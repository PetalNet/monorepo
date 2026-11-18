package dev.petalcat.janetcall

import android.os.Process
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
		} finally {
			onEnded(end)
		}
	}

	private fun streamMic(source: Mic) {
		Thread({
			Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
			val buf = ByteArray(MIC_CHUNK_BYTES)
			while (!ended.get()) {
				val n = source.read(buf)
				if (n <= 0) break
				stage.mic(pcmLevel(buf, n), CallStage.nowS())
				socket?.send(buf.toByteString(0, n))
			}
			source.close()
			finish(End.Failed("Microphone stopped"))
		}, "janet-mic").start()
	}

	private inner class Listener : WebSocketListener() {
		override fun onOpen(webSocket: WebSocket, response: Response) {
			// This is the thread that reads the socket for the rest of the call. Her audio arrives on
			// it, so it runs ahead of drawing the call screen too.
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
				is ServerMessage.HerWords -> {
					stage.herSentenceQueued(msg)
					player.markSentence()
				}
				is ServerMessage.HisWords -> stage.hisWords(msg.text)
				is ServerMessage.Level -> stage.level(msg.her, msg.him, CallStage.nowS())
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
