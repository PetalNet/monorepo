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

	/** [retryable]: the code was not spent, so the same link can be tried again. */
	data class Refused(val reason: String, val retryable: Boolean = false) : PairResult
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

	/**
	 * Trades the link's one-time code for a device token and the Access credentials. The pairing
	 * endpoint is outside Cloudflare Access, so the request carries none. Blocks; call it off the
	 * main thread.
	 */
	fun pair(link: PairingLink, deviceName: String): PairResult {
		val body = JSONObject().put("code", link.code).put("name", deviceName).toString()
		return try {
			val request = Request.Builder().url(bridgeEndpoint(link.url, "pair"))
				.post(body.toRequestBody("application/json".toMediaType()))
				.build()
			quick.newCall(request).execute().use { response ->
				val answer = json(response.peekBody(MAX_ANSWER_BYTES).string())
				val pairing = answer?.takeIf { response.code == 200 }?.let { pairingFrom(link, it) }
				when {
					pairing != null -> PairResult.Paired(pairing)
					// The bridge's own 403 is JSON with an "error". Any other 403 never reached the bridge.
					response.code == 403 && answer?.has("error") == true ->
						PairResult.Refused("This pairing link was already used or has expired. Ask for a new one.")
					response.code == 429 ->
						PairResult.Refused("Too many pairing attempts. Wait a minute, then try again.", retryable = true)
					else -> PairResult.Refused("Could not reach the bridge at ${link.host} (HTTP ${response.code}).", retryable = true)
				}
			}
		} catch (e: IOException) {
			PairResult.Refused("Could not reach the bridge at ${link.host}: ${e.message ?: "no connection"}", retryable = true)
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

	/** Blocks; callers must use a background thread. A failed or malformed response is not a ring. */
	fun registerRing(pairing: Pairing): RingRegistration? =
		ringRequest(pairing, "register", JSONObject())?.takeIf { it.code in 200..299 }?.body?.let(::parseRingRegistration)

	fun pendingRing(pairing: Pairing, id: String, nowS: Long): RingCheck {
		if (!validRingId(id)) return RingCheck.Gone
		val answer = ringRequest(pairing, "pending", JSONObject().put("id", id)) ?: return RingCheck.Retry
		return when (answer.code) {
			in 200..299 -> answer.body?.let { parsePendingRing(it, id, nowS) }?.let { RingCheck.Live(it) } ?: RingCheck.Gone
			400, 409 -> RingCheck.Gone
			else -> RingCheck.Retry
		}
	}

	fun declineRing(pairing: Pairing, id: String, busy: Boolean = false): Boolean {
		if (!validRingId(id)) return false
		val body = JSONObject().put("id", id).put("status", if (busy) "busy" else "declined")
		return ringRequest(pairing, "decline", body)?.let { it.code in 200..299 } == true
	}

	private data class RingAnswer(val code: Int, val body: JSONObject?)

	private fun ringRequest(pairing: Pairing, endpoint: String, body: JSONObject): RingAnswer? = try {
		val request = Request.Builder().url(bridgeEndpoint(pairing.url, "ring/$endpoint"))
			.header("Authorization", "Bearer ${pairing.token}")
			.cloudflareAccess(pairing.cfId, pairing.cfSecret)
			.post(body.toString().toRequestBody("application/json".toMediaType()))
			.build()
		quick.newCall(request).execute().use { response ->
			RingAnswer(response.code, json(response.peekBody(MAX_ANSWER_BYTES).string()))
		}
	} catch (_: IOException) {
		null
	} catch (_: IllegalArgumentException) {
		null
	}

	/**
	 * Asks the bridge to load speech-to-text and the voice, so the call's first audio does not wait
	 * for them. The bridge answers at once and warms in the background. Never blocks, and a failure
	 * is silent: the call works without it, only slower to start. [onAnswer] hears what the bridge
	 * said about the line, for the home screen.
	 */
	fun warm(pairing: Pairing, onAnswer: (Line) -> Unit = {}) {
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
			override fun onFailure(call: Call, e: IOException) = onAnswer(Line.Unreachable)

			override fun onResponse(call: Call, response: Response) {
				val line = response.use { lineFor(it.code, json(it.peekBody(MAX_ANSWER_BYTES).string())) }
				onAnswer(line)
			}
		})
	}

	/** [warm] for the app coming to the foreground: at most once every [FOREGROUND_WARM_MS]. */
	fun warmOnForeground(pairing: Pairing, nowMs: Long, onAnswer: (Line) -> Unit = {}) {
		if (foreground.due(nowMs)) warm(pairing, onAnswer)
	}

	/**
	 * 202 is the bridge accepting the warm-up. Only the bridge's own 403, JSON with an "error", says it
	 * does not know this phone: any other 403 is Cloudflare Access in front of it, and that is not
	 * proof of anything about the pairing.
	 */
	internal fun lineFor(code: Int, answer: JSONObject?): Line = when {
		code in 200..299 -> Line.Ready
		code == 403 && answer?.has("error") == true -> Line.Revoked
		else -> Line.Unreachable
	}

	private val foreground = Throttle(FOREGROUND_WARM_MS)
	private const val FOREGROUND_WARM_MS = 60_000L

	/**
	 * Null unless the answer holds all three values as text: without the Access pair the phone could
	 * not call. `optString` is not used: on Android it turns a JSON null into the text "null".
	 */
	internal fun pairingFrom(link: PairingLink, answer: JSONObject): Pairing? {
		val (token, cfId, cfSecret) = listOf("token", "cf_id", "cf_secret").map { name ->
			(answer.opt(name) as? String)?.takeUnless { it.isEmpty() || it == "null" } ?: return null
		}
		return Pairing(link.url, token, cfId, cfSecret)
	}
}
