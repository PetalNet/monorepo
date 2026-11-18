package dev.petalcat.janetcall

import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.OkHttpClient
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
	private val config: Config,
	private val micFactory: () -> Mic,
	private val player: Player,
	private val onOpen: () -> Unit,
	private val onEnded: (End) -> Unit,
) {
	private val ended = AtomicBoolean(false)

	@Volatile private var socket: WebSocket? = null

	@Volatile private var mic: Mic? = null

	fun start() {
		val request = Request.Builder().url(config.url)
			.header("Authorization", "Bearer ${config.token}")
			.apply {
				if (config.cfId.isNotEmpty()) header("CF-Access-Client-Id", config.cfId)
				if (config.cfSecret.isNotEmpty()) header("CF-Access-Client-Secret", config.cfSecret)
			}
			.build()
		socket = http.newWebSocket(request, Listener())
	}

	fun hangup() = finish(End.Local)

	private fun finish(end: End) {
		if (!ended.compareAndSet(false, true)) return
		mic?.stop()
		player.close(drain = end !is End.Local && end !is End.Failed)
		socket?.close(1000, "hangup")
		onEnded(end)
	}

	private fun streamMic(source: Mic) {
		Thread({
			val buf = ByteArray(MIC_CHUNK_BYTES)
			while (!ended.get()) {
				val n = source.read(buf)
				if (n <= 0) break
				socket?.send(buf.toByteString(0, n))
			}
			source.close()
		}, "janet-mic").start()
	}

	private inner class Listener : WebSocketListener() {
		override fun onOpen(webSocket: WebSocket, response: Response) {
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
				ServerMessage.Clear -> player.clear()
				ServerMessage.Bye -> finish(End.Remote("Janet ended the call"))
				ServerMessage.Unknown -> Unit
			}
		}

		override fun onMessage(webSocket: WebSocket, bytes: ByteString) = player.enqueue(bytes.toByteArray())

		override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
			finish(End.Remote("Connection closed by the bridge"))
		}

		override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
			val reason = when (response?.code) {
				401, 403 -> "Bridge refused the credentials (HTTP ${response.code})"
				null -> t.message ?: "Could not reach the bridge"
				else -> "Bridge error (HTTP ${response.code})"
			}
			finish(End.Failed(reason))
		}
	}

	private companion object {
		val http: OkHttpClient = OkHttpClient.Builder()
			.connectTimeout(10, TimeUnit.SECONDS)
			.readTimeout(0, TimeUnit.SECONDS)
			.pingInterval(15, TimeUnit.SECONDS)
			.build()
	}
}
