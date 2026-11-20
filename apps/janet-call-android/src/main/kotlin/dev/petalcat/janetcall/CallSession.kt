package dev.petalcat.janetcall

import android.os.Process
import android.util.Log
import android.os.SystemClock
import java.net.SocketTimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString

sealed interface End {
	data object Local : End

	/** Janet ended it, or the bridge closed the line normally. */
	data class Remote(val reason: String) : End

	/** The line was lost during a call, so Janet did not end it. The phone plays [DropTone] for it. */
	data class Dropped(val reason: String) : End

	/** [repair]: only a new pairing can fix it. */
	data class Failed(val reason: String, val repair: Boolean = false) : End
}

/** One call: one WebSocket to the bridge, microphone up, reply audio down. */
class CallSession(
	private val pairing: Pairing,
	private val micFactory: () -> Mic,
	private val player: Player,
	private val stage: CallStage,
	private val onOpen: () -> Unit,
	private val onEnded: (End) -> Unit,
	/** Janet's first audio has arrived: the ringback tone stops here. Called once, off the main thread. */
	private val onFirstAudio: () -> Unit = {},
	private val ringId: String? = null,
) {
	private val ended = AtomicBoolean(false)
	private val heard = AtomicBoolean(false)
	private val opened = AtomicBoolean(false)
	private val pulse = MicPulse()

	@Volatile private var socket: WebSocket? = null

	@Volatile private var mic: Mic? = null

	@Volatile private var readerTid: Int? = null

	fun start() {
		try {
			if (ringId != null && !validRingId(ringId)) {
				finish(End.Failed("The incoming call is invalid."))
				return
			}
			val request = with(Bridge) {
				Request.Builder().url(pairing.url)
					.header("Authorization", "Bearer ${pairing.token}")
					.cloudflareAccess(pairing.cfId, pairing.cfSecret)
					.apply { ringId?.let { header("X-Janet-Ring", it) } }
					.build()
			}
			socket = Bridge.http.newWebSocket(request, Listener())
		} catch (e: IllegalArgumentException) {
			finish(End.Failed("The stored pairing is not valid.", repair = true))
		}
	}

	fun hangup() = finish(End.Local)

	private fun finish(end: End) {
		if (!ended.compareAndSet(false, true)) return
		try {
			mic?.stop()
			player.close(drain = end is End.Remote)
			socket?.close(1000, "hangup")
			readerTid?.let { Process.setThreadPriority(it, Process.THREAD_PRIORITY_DEFAULT) }
		} finally {
			onEnded(end)
		}
	}

	private fun streamMic(source: Mic) {
		pulse.beat(SystemClock.elapsedRealtime())
		Thread({
			while (!ended.get()) {
				Thread.sleep(WATCH_MS)
				if (pulse.stalled(SystemClock.elapsedRealtime())) finish(End.Dropped(MIC_STALLED))
			}
		}, "janet-mic-watch").apply { isDaemon = true }.start()
		Thread({
			Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
			val buf = ByteArray(MIC_CHUNK_BYTES)
			val backlog = MicBacklog()
			while (!ended.get()) {
				val n = source.read(buf)
				if (n <= 0) break
				pulse.beat(SystemClock.elapsedRealtime())
				stage.mic(pcmLevel(buf, n), CallStage.nowS())
				val socket = socket ?: continue
				if (backlog.admits(socket.queueSize())) socket.send(buf.toByteString(0, n))
			}
			source.close()
			if (backlog.dropped > 0) Log.w("JanetCall", "the uplink fell behind: dropped ${backlog.dropped} microphone frames")
			finish(End.Dropped(MIC_STALLED))
		}, "janet-mic").start()
	}

	private inner class Listener : WebSocketListener() {
		override fun onOpen(webSocket: WebSocket, response: Response) {
			// This is the thread that reads the socket for the rest of the call. Her audio arrives on
			// it, so it runs ahead of drawing the call screen too. It is one of OkHttp's pooled
			// threads, so finish() puts its priority back.
			readerTid = Process.myTid()
			Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
			val source = try {
				micFactory()
			} catch (e: Exception) {
				finish(End.Failed(e.message ?: "Microphone unavailable"))
				return
			}
			mic = source
			if (ended.get()) source.close() else {
				opened.set(true)
				streamMic(source)
				onOpen()
			}
		}

		override fun onMessage(webSocket: WebSocket, text: String) {
			when (val msg = parseServerMessage(text)) {
				is ServerMessage.Audio -> player.setRate(msg.rate)
				ServerMessage.Clear -> {
					player.clear()
					stage.clear(CallStage.nowS())
				}
				is ServerMessage.State -> stage.state(msg.phase, CallStage.nowS())
				is ServerMessage.HerWords -> player.markSentence(stage.herSentenceQueued(msg))
				is ServerMessage.HisWords -> stage.hisWords(msg.text)
				is ServerMessage.Level -> {
					// Her reading comes with its audio, ahead of the speaker by what is still buffered.
					val now = CallStage.nowS()
					stage.level(msg.her, msg.him, now, herHeardS = now + player.lagS())
				}
				ServerMessage.Bye -> finish(End.Remote("Janet ended the call"))
				ServerMessage.Unknown -> Unit
			}
		}

		override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
			if (heard.compareAndSet(false, true)) onFirstAudio()
			player.enqueue(bytes.toByteArray())
		}

		override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
			finish(closedBy(code, reason))
		}

		override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
			val code = response?.code
			val repair = code == 401 || code == 403 || code in 300..399
			val reason = when (code) {
				401, 403 -> "The bridge refused this phone (HTTP $code)."
				in 300..399 -> "Cloudflare Access did not accept this phone (HTTP $code)."
				null -> t.message ?: "Could not reach the bridge"
				else -> "Bridge error (HTTP $code)"
			}
			finish(if (opened.get()) lostLine(t) else End.Failed(reason, repair))
		}
	}

	private companion object {
		const val WATCH_MS = 1_000L
	}
}

const val MIC_STALLED = "The phone's microphone stopped, so Janet could no longer hear you."

/**
 * How a call ends when the bridge closes the socket without having sent "bye". Code 1000 is a normal
 * close. Anything else is the line going away: the bridge closes with 1011 when its keepalive gets
 * no answer from the phone, and with 1001 or 1012 when it is going down.
 */
internal fun closedBy(code: Int, reason: String): End = when {
	code == 1000 -> End.Remote("The bridge closed the line")
	code == 1011 && reason.contains("keepalive", ignoreCase = true) ->
		End.Dropped("The bridge stopped hearing this phone and closed the line. The phone's connection to it stalled.")
	code == 1001 || code == 1012 || code == 1013 -> End.Dropped("The bridge went away or is restarting.")
	else -> End.Dropped("The bridge closed the line unexpectedly (code $code${if (reason.isBlank()) "" else ", $reason"}).")
}

/** The socket failed during a call. OkHttp's own ping that gets no pong is a [SocketTimeoutException]. */
internal fun lostLine(t: Throwable): End.Dropped = when (t) {
	is SocketTimeoutException -> End.Dropped("The connection to the bridge stopped responding.")
	else -> End.Dropped("Lost the connection to the bridge: ${t.message ?: t.javaClass.simpleName}.")
}

/** When the microphone last delivered a frame, so a capture that stops without an error is noticed. */
class MicPulse(private val stallMs: Long = 5_000L) {
	@Volatile private var lastMs = 0L

	fun beat(nowMs: Long) {
		lastMs = nowMs
	}

	fun stalled(nowMs: Long) = nowMs - lastMs > stallMs
}
