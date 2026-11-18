package dev.petalcat.janetcall

import android.os.Process
import android.util.Log
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString

sealed interface End {
	data object Local : End

	data class Remote(val reason: String) : End

	data class Failed(val reason: String) : End
}

/** One call: one WebSocket to the bridge, microphone up, reply audio down. */
class CallSession(
	private val pairing: Pairing,
	private val micFactory: () -> Mic,
	private val player: Player,
	private val stage: CallStage,
	private val onOpen: () -> Unit,
	private val onEnded: (End) -> Unit,
) {
	private val ended = AtomicBoolean(false)

	@Volatile private var socket: WebSocket? = null

	@Volatile private var mic: Mic? = null

	@Volatile private var readerTid: Int? = null

	fun start() {
		try {
			val request = with(Bridge) {
				Request.Builder().url(pairing.url)
					.header("Authorization", "Bearer ${pairing.token}")
					.cloudflareAccess(pairing.cfId, pairing.cfSecret)
					.build()
			}
			socket = Bridge.http.newWebSocket(request, Listener())
		} catch (e: IllegalArgumentException) {
			finish(End.Failed("The stored pairing is not valid. Unpair and pair again."))
		}
	}

	fun hangup() = finish(End.Local)

	private fun finish(end: End) {
		if (!ended.compareAndSet(false, true)) return
		try {
			mic?.stop()
			player.close(drain = end !is End.Local && end !is End.Failed)
			socket?.close(1000, "hangup")
			readerTid?.let { Process.setThreadPriority(it, Process.THREAD_PRIORITY_DEFAULT) }
		} finally {
			onEnded(end)
		}
	}

	private fun streamMic(source: Mic) {
		Thread({
			Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
			val buf = ByteArray(MIC_CHUNK_BYTES)
			val backlog = MicBacklog()
			while (!ended.get()) {
				val n = source.read(buf)
				if (n <= 0) break
				stage.mic(pcmLevel(buf, n), CallStage.nowS())
				val socket = socket ?: continue
				if (backlog.admits(socket.queueSize())) socket.send(buf.toByteString(0, n))
			}
			source.close()
			if (backlog.dropped > 0) Log.w("JanetCall", "the uplink fell behind: dropped ${backlog.dropped} microphone frames")
			finish(End.Failed("Microphone stopped"))
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

		override fun onMessage(webSocket: WebSocket, bytes: ByteString) = player.enqueue(bytes.toByteArray())

		override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
			finish(End.Remote("Connection closed by the bridge"))
		}

		override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
			val code = response?.code
			val reason = when (code) {
				401, 403 -> "The bridge refused this phone (HTTP $code). Unpair and pair again."
				in 300..399 -> "Cloudflare Access did not accept this phone (HTTP $code). Unpair and pair again."
				null -> t.message ?: "Could not reach the bridge"
				else -> "Bridge error (HTTP $code)"
			}
			finish(End.Failed(reason))
		}
	}
}
