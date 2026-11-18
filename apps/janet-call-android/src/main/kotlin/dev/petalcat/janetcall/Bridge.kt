package dev.petalcat.janetcall

import java.io.IOException
import java.util.concurrent.TimeUnit
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONException
import org.json.JSONObject

sealed interface PairResult {
	data class Paired(val pairing: Pairing) : PairResult

	data class Refused(val reason: String) : PairResult
}

/** Lets something through at most once every [everyMs]. */
class Throttle(private val everyMs: Long) {
	private var last: Long? = null

	@Synchronized
	fun due(nowMs: Long): Boolean {
		if (last?.let { nowMs - it < everyMs } == true) return false
		last = nowMs
		return true
	}
}

/** The bridge's HTTP side. Redirects are never followed: a redirect means Cloudflare Access wants a login. */
object Bridge {
	val http: OkHttpClient = OkHttpClient.Builder()
		.connectTimeout(10, TimeUnit.SECONDS)
		.readTimeout(0, TimeUnit.SECONDS)
		.followRedirects(false)
		.followSslRedirects(false)
		.pingInterval(15, TimeUnit.SECONDS)
		.build()

	private val quick = http.newBuilder().readTimeout(15, TimeUnit.SECONDS).callTimeout(25, TimeUnit.SECONDS).build()

	fun Request.Builder.cloudflareAccess(cfId: String, cfSecret: String) = apply {
		if (cfId.isNotEmpty()) header("CF-Access-Client-Id", cfId)
		if (cfSecret.isNotEmpty()) header("CF-Access-Client-Secret", cfSecret)
	}

	/** Trades the link's one-time code for a device token. Blocks; call it off the main thread. */
	fun pair(link: PairingLink, deviceName: String): PairResult {
		val body = JSONObject().put("code", link.code).put("name", deviceName).toString()
		return try {
			val request = Request.Builder().url(bridgeEndpoint(link.url, "pair"))
				.cloudflareAccess(link.cfId, link.cfSecret)
				.post(body.toRequestBody("application/json".toMediaType()))
				.build()
			quick.newCall(request).execute().use { response ->
				when (response.code) {
					200 -> pairedFrom(link, response.peekBody(MAX_ANSWER_BYTES).string())
					// The bridge's own 403 is JSON with an "error". Any other 403 never reached the bridge.
					403 -> if (json(response.peekBody(MAX_ANSWER_BYTES).string())?.has("error") == true) {
						PairResult.Refused("The pairing code was already used or has expired. Open the pairing page again for a new one.")
					} else {
						PairResult.Refused("This phone could not reach the bridge: Cloudflare Access refused it (HTTP 403).")
					}
					in 300..399 -> PairResult.Refused("Cloudflare Access did not accept this link (HTTP ${response.code}).")
					else -> PairResult.Refused("The bridge could not pair this phone (HTTP ${response.code}).")
				}
			}
		} catch (e: IOException) {
			PairResult.Refused("Could not reach ${link.host}: ${e.message ?: "no connection"}")
		} catch (_: IllegalArgumentException) {
			PairResult.Refused("The pairing link holds a value that cannot be sent.")
		}
	}

	private fun json(body: String): JSONObject? = try {
		JSONObject(body)
	} catch (_: JSONException) {
		null
	}

	private const val MAX_ANSWER_BYTES = 64 * 1024L

	/**
	 * Asks the bridge to load speech-to-text and the voice, so the call's first audio does not wait
	 * for them. The bridge answers at once and warms in the background. Never blocks, and a failure
	 * is silent: the call works without it, only slower to start.
	 */
	fun warm(pairing: Pairing) {
		val request = try {
			Request.Builder().url(bridgeEndpoint(pairing.url, "warm"))
				.header("Authorization", "Bearer ${pairing.token}")
				.cloudflareAccess(pairing.cfId, pairing.cfSecret)
				.post(ByteArray(0).toRequestBody())
				.build()
		} catch (_: IllegalArgumentException) {
			return
		}
		quick.newCall(request).enqueue(object : Callback {
			override fun onFailure(call: Call, e: IOException) = Unit

			override fun onResponse(call: Call, response: Response) = response.close()
		})
	}

	/** [warm] for the app coming to the foreground: at most once every [FOREGROUND_WARM_MS]. */
	fun warmOnForeground(pairing: Pairing, nowMs: Long) {
		if (foreground.due(nowMs)) warm(pairing)
	}

	private val foreground = Throttle(FOREGROUND_WARM_MS)
	private const val FOREGROUND_WARM_MS = 60_000L

	private fun pairedFrom(link: PairingLink, body: String): PairResult {
		val token = json(body)?.optString("token").orEmpty()
		if (token.isEmpty()) return PairResult.Refused("The bridge answered without a device token.")
		return PairResult.Paired(Pairing(link.url, token, link.cfId, link.cfSecret))
	}
}
