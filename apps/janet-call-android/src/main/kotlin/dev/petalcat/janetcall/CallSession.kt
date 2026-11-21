package dev.petalcat.janetcall

import android.os.Process
import android.os.SystemClock
import java.net.SocketTimeoutException
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
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

/** A Telecom call keeps one microphone while its authenticated transport reattaches. */
class CallSession(
	private val pairing: Pairing,
	private val micFactory: () -> Mic,
	private val player: Player,
	private val stage: CallStage,
	private val onOpen: () -> Unit,
	private val onEnded: (End) -> Unit,
	private val onFirstAudio: () -> Unit = {},
	private val ringId: String? = null,
) {
	private val ended = AtomicBoolean(false)
	private val heard = AtomicBoolean(false)
	private val opened = AtomicBoolean(false)
	private val pulse = MicPulse()
	private val session = UUID.randomUUID().toString().replace("-", "")
	private val retries = Executors.newSingleThreadScheduledExecutor { task ->
		Thread(task, "janet-reattach").apply { isDaemon = true }
	}
	private var retry = ReconnectWindow()
	private var deadline: ScheduledFuture<*>? = null
	private var attempt = 0
	private var localPending = false
	private var socketOpen = false
	private var decoder: OpusDecoder? = null
	private var lastReplyTimestamp = -1L

	@Volatile private var socket: WebSocket? = null
	@Volatile private var ready = false
	@Volatile private var mic: Mic? = null
	@Volatile private var captured = 0L
	@Volatile private var sendFrom = 0L

	@Synchronized
	fun start() {
		if (ringId != null && !validRingId(ringId)) {
			finish(End.Failed("The incoming call is invalid."))
			return
		}
		connect()
	}

	@Synchronized
	private fun connect() {
		if (ended.get() && !localPending) return
		val id = ++attempt
		socketOpen = false
		try {
			val request = with(Bridge) {
				Request.Builder().url(pairing.url)
					.header("Authorization", "Bearer ${pairing.token}")
					.header("X-Janet-Audio", "opus")
					.header("X-Janet-Session", session)
					.cloudflareAccess(pairing.cfId, pairing.cfSecret)
					.apply { if (!opened.get()) ringId?.let { header("X-Janet-Ring", it) } }
					.build()
			}
			socket = transport.newWebSocket(request, Listener(id))
		} catch (_: IllegalArgumentException) {
			finish(End.Failed("The stored pairing is not valid.", repair = true))
		}
	}

	fun hangup() = finish(End.Local)

	@Synchronized
	private fun finish(end: End) {
		if (!ended.compareAndSet(false, true)) return
		ready = false
		decoder?.close()
		decoder = null
		try {
			mic?.stop()
			player.close(drain = end is End.Remote)
			val current = socket
			if (end == End.Local && !socketOpen && opened.get()) {
				// Retain only the transport retry, so an offline hangup can close the server session.
				localPending = true
			} else {
				if (end == End.Local) current?.send("{\"type\":\"hangup\"}")
				if (socketOpen) current?.close(1000, "hangup") else current?.cancel()
				socket = null
				stopTransport()
			}
		} finally {
			onEnded(end)
		}
	}

	private fun stopTransport() {
		localPending = false
		attempt++
		deadline?.cancel(false)
		socket?.cancel()
		socket = null
		retries.shutdownNow()
	}

	@Synchronized
	private fun disconnected(id: Int, end: End) {
		if (id != attempt || (ended.get() && !localPending)) return
		ready = false
		socketOpen = false
		socket?.cancel()
		socket = null
		decoder?.close()
		decoder = null
		if (!ended.get()) {
			player.clear()
			stage.clear(CallStage.nowS())
		}
		val delay = retry.nextDelay(SystemClock.elapsedRealtime())
		if (delay == null) {
			if (localPending) stopTransport() else finish(end)
			return
		}
		if (deadline == null) {
			val window = retry
			deadline = retries.schedule({
				synchronized(this) {
					if (retry === window) {
						if (localPending) stopTransport() else if (!ready) finish(end)
					}
				}
			}, ReconnectWindow.LIMIT_MS, TimeUnit.MILLISECONDS)
		}
		// Invalidate callbacks from the cancelled socket before scheduling its successor.
		attempt++
		retries.schedule({ synchronized(this) { connect() } }, delay, TimeUnit.MILLISECONDS)
	}

	private fun streamMic(source: Mic) {
		pulse.beat(SystemClock.elapsedRealtime())
		Thread({
			while (!ended.get()) {
				Thread.sleep(1_000)
				if (!ended.get() && pulse.stalled(SystemClock.elapsedRealtime())) finish(End.Dropped(MIC_STALLED))
			}
		}, "janet-mic-watch").apply { isDaemon = true }.start()
		Thread({
			Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
			var encoder: OpusEncoder? = null
			try {
				encoder = OpusEncoder()
				val buf = ByteArray(MIC_CHUNK_BYTES)
				var filled = 0
				val backlog = MicBacklog(frameBytes = 80, limitBytes = 1_600)
				while (!ended.get()) {
					val part = ByteArray(buf.size - filled)
					val n = source.read(part)
					if (n <= 0) break
					part.copyInto(buf, filled, 0, n)
					filled += n
					pulse.beat(SystemClock.elapsedRealtime())
					if (filled < buf.size) continue
					filled = 0
					val timestamp = captured
					captured += MIC_RATE / 50
					stage.mic(pcmLevel(buf), CallStage.nowS())
					// Encode and drain even offline; capture time never stops and old output is discarded.
					for (packet in encoder.encode(buf, timestamp)) {
						synchronized(this) {
							val current = socket
							if (ready && current != null && OpusWire.unpack(packet).first >= sendFrom &&
								backlog.admits(current.queueSize())) current.send(packet.toByteString())
						}
					}
				}
				if (!ended.get()) finish(End.Dropped(MIC_STALLED))
			} catch (e: Exception) {
				finish(End.Failed(e.message ?: "Audio codec unavailable"))
			} finally {
				encoder?.close()
				source.close()
			}
		}, "janet-mic").start()
	}

	private companion object {
		val transport = Bridge.http.newBuilder()
			.connectTimeout(5, TimeUnit.SECONDS)
			// OkHttp exits this timeout at the WebSocket upgrade.
			.callTimeout(5, TimeUnit.SECONDS)
			.pingInterval(5, TimeUnit.SECONDS)
			.build()
	}

	private inner class Listener(private val id: Int) : WebSocketListener() {
		override fun onOpen(webSocket: WebSocket, response: Response) = synchronized(this@CallSession) {
			if (id != attempt || (ended.get() && !localPending)) {
				webSocket.cancel()
				return@synchronized
			}
			socketOpen = true
			if (localPending) {
				webSocket.send("{\"type\":\"hangup\"}")
				webSocket.close(1000, "hangup")
				// Let OkHttp flush the hangup before closing the transport.
				socket = null
				stopTransport()
				return@synchronized
			}
			if (opened.compareAndSet(false, true)) {
				try {
					val source = micFactory()
					mic = source
					streamMic(source)
					onOpen()
				} catch (e: Exception) {
					finish(End.Failed(e.message ?: "Microphone unavailable"))
				}
			}
		}

		override fun onMessage(webSocket: WebSocket, text: String) = synchronized(this@CallSession) {
			if (id != attempt || ended.get()) return@synchronized
			try {
				when (val msg = parseServerMessage(text)) {
					is ServerMessage.Audio -> {
						decoder?.close()
						decoder = null
						check(msg.codec == "opus") { "The bridge did not negotiate Opus" }
						decoder = OpusDecoder(msg.rate)
						lastReplyTimestamp = -1
						player.clear()
						sendFrom = captured + MIC_RATE / 50
						ready = true
						retry = ReconnectWindow()
						deadline?.cancel(false)
						deadline = null
					}
					ServerMessage.Clear -> {
						player.clear()
						stage.clear(CallStage.nowS())
					}
					is ServerMessage.State -> stage.state(msg.phase, CallStage.nowS())
					is ServerMessage.HerWords -> player.markSentence(stage.herSentenceQueued(msg))
					is ServerMessage.HisWords -> stage.hisWords(msg.text)
					is ServerMessage.Level -> {
						val now = CallStage.nowS()
						stage.level(msg.her, msg.him, now, herHeardS = now + player.lagS())
					}
					ServerMessage.Bye -> finish(End.Remote("Janet ended the call"))
					ServerMessage.Unknown -> Unit
				}
			} catch (e: Exception) {
				finish(End.Failed(e.message ?: "Audio codec unavailable"))
			}
		}

		override fun onMessage(webSocket: WebSocket, bytes: ByteString) = synchronized(this@CallSession) {
			if (id != attempt || ended.get() || !ready) return@synchronized
			try {
				val packet = bytes.toByteArray()
				val timestamp = OpusWire.unpack(packet).first
				if (timestamp <= lastReplyTimestamp) return@synchronized
				lastReplyTimestamp = timestamp
				decoder?.decode(packet) { rate, pcm ->
					if (heard.compareAndSet(false, true)) onFirstAudio()
					player.setRate(rate)
					player.enqueue(pcm)
				}
			} catch (e: Exception) {
				finish(End.Failed(e.message ?: "Invalid reply audio"))
			}
		}

		override fun onClosing(webSocket: WebSocket, code: Int, reason: String) = synchronized(this@CallSession) {
			if (id != attempt) return@synchronized
			if (code == 1000 || code == 1008 || code in 4001..4003) {
				if (localPending) stopTransport() else finish(closedBy(code, reason))
			} else disconnected(id, closedBy(code, reason))
		}

		override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = synchronized(this@CallSession) {
			if (id != attempt) return@synchronized
			val code = response?.code
			val repair = code == 401 || code == 403 || code in 300..399
			if (repair || (code != null && code in 400..499 && code != 408 && code != 429)) {
				if (localPending) stopTransport()
				else finish(End.Failed("The bridge refused this phone (HTTP $code).", repair))
			} else disconnected(id, if (opened.get()) lostLine(t) else End.Failed("Could not reach the bridge"))
		}
	}
}

/** A single outage has a fixed deadline, including time spent connecting. */
class ReconnectWindow {
	private var since: Long? = null
	private var failures = 0

	fun nextDelay(nowMs: Long): Long? {
		val start = since ?: nowMs.also { since = it }
		val remaining = LIMIT_MS - (nowMs - start)
		if (remaining <= 0) return null
		return minOf(250L shl minOf(failures++, 4), remaining)
	}

	companion object {
		const val LIMIT_MS = 20_000L
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
