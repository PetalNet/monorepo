package dev.petalcat.janetcall

import java.io.IOException
import java.util.concurrent.TimeUnit
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONException
import org.json.JSONObject

sealed interface PairResult {
	data class Paired(val pairing: Pairing) : PairResult

	data class Refused(val reason: String) : PairResult
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
					200 -> pairedFrom(link, response.body?.string().orEmpty())
					403 -> PairResult.Refused("The pairing code was already used or is not valid. Open the pairing page again for a new one.")
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

	private fun pairedFrom(link: PairingLink, body: String): PairResult {
		val token = try {
			JSONObject(body).optString("token")
		} catch (_: JSONException) {
			""
		}
		if (token.isEmpty()) return PairResult.Refused("The bridge answered without a device token.")
		return PairResult.Paired(Pairing(link.url, token, link.cfId, link.cfSecret))
	}
}
