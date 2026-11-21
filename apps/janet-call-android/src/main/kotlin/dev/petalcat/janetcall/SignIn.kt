package dev.petalcat.janetcall

import android.content.Context
import android.os.Build
import android.os.SystemClock
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.net.URI
import java.net.URLDecoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import org.json.JSONObject

const val DEFAULT_BRIDGE_URL = "wss://janet-voice.petalcat.dev/v1/call"
const val SIGN_IN_LIFE_MS = 10 * 60_000L

/** Kept encrypted across process death. The callback cannot choose the bridge or the verifier. */
class PendingSignIn(val url: String, val verifier: String, val state: String, val wallMs: Long, val elapsedMs: Long) {
	val challenge: String get() = Base64.getUrlEncoder().withoutPadding()
		.encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))
	val browserUrl: String get() = bridgeEndpoint(url, "pair/signin") + "?challenge=$challenge&state=$state"

	fun live(wall: Long, elapsed: Long): Boolean =
		wall - wallMs in 0 until SIGN_IN_LIFE_MS && elapsed - elapsedMs in 0 until SIGN_IN_LIFE_MS

	fun json(): String = JSONObject().put("url", url).put("verifier", verifier).put("state", state)
		.put("wall", wallMs).put("elapsed", elapsedMs).toString()

	override fun toString() = "PendingSignIn"

	companion object {
		fun create(url: String, wall: Long, elapsed: Long): PendingSignIn {
			require(bridgeUrlProblem(url, false) == null)
			val random = SecureRandom()
			fun secret() = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32).also(random::nextBytes))
			return PendingSignIn(canonicalBridgeUrl(url)!!, secret(), secret(), wall, elapsed)
		}

		fun restore(raw: String): PendingSignIn {
			val json = JSONObject(raw)
			return PendingSignIn(json.getString("url"), json.getString("verifier"), json.getString("state"),
				json.getLong("wall"), json.getLong("elapsed"))
		}
	}
}

sealed interface SignInCallback {
	class Code(val value: String) : SignInCallback { override fun toString() = "SignInCallback.Code" }
	data object Denied : SignInCallback
	data object Invalid : SignInCallback
}

/** Strict parsing also rejects duplicate query fields and fragment/authority tricks. */
fun signInCallback(raw: String, pending: PendingSignIn, wall: Long, elapsed: Long): SignInCallback {
	if (!pending.live(wall, elapsed) || raw.length > 4096) return SignInCallback.Invalid
	return try {
		val uri = URI(raw)
		if (uri.scheme != "janetcall" || uri.rawAuthority != "signin" || !uri.rawPath.isNullOrEmpty() || uri.rawFragment != null) {
			return SignInCallback.Invalid
		}
		val fields = uri.rawQuery.orEmpty().split('&').map {
			val pair = it.split('=', limit = 2)
			URLDecoder.decode(pair[0], "UTF-8") to URLDecoder.decode(pair.getOrElse(1) { "" }, "UTF-8")
		}
		if (fields.map { it.first }.distinct().size != fields.size) return SignInCallback.Invalid
		val query = fields.toMap()
		if (query["state"] != pending.state) return SignInCallback.Invalid
		val code = query["code"]
		when {
			query.containsKey("error") && code == null -> SignInCallback.Denied
			!query.containsKey("error") && code != null && code.length in 1..512 && code.none { it.isISOControl() } -> SignInCallback.Code(code)
			else -> SignInCallback.Invalid
		}
	} catch (_: IllegalArgumentException) {
		SignInCallback.Invalid
	} catch (_: java.net.URISyntaxException) {
		SignInCallback.Invalid
	}
}

/** Main-thread enrollment coordinator; only the HTTP exchange runs on a worker. */
object SignIn {
	var open by mutableStateOf(false)
		private set
	var exchanging by mutableStateOf(false)
		private set
	var finishing by mutableStateOf(false)
		private set
	var message by mutableStateOf("Sign in with your Janet account to enroll this phone. Shared links give guest access.")
		private set
	private var generation = 0
	private fun callBusy() = Calls.inCall || Calls.state is CallState.Ringing

	fun pending(context: Context): PendingSignIn? = Settings(context).pendingSignIn()

	fun show() { open = true; Calls.update() }

	fun resume(context: Context) {
		if (Settings(context).webResetRequired()) {
			if (!finishing) resetWebSession(context)
			return
		}
		val request = pending(context) ?: return
		open = true
		message = if (request.live(System.currentTimeMillis(), SystemClock.elapsedRealtime())) {
			"Finish signing in in your browser, or cancel to start again."
		} else {
			Settings(context).clearPendingSignIn()
			"Sign-in expired. Start sign-in again."
		}
		Calls.update()
	}

	fun begin(context: Context, url: String): String? {
		if (Settings(context).webResetRequired()) { resetWebSession(context); return null }
		if (callBusy() || Pairer.host != null || exchanging || finishing) return null
		return try {
			val request = PendingSignIn.create(url, System.currentTimeMillis(), SystemClock.elapsedRealtime())
			Settings(context).savePendingSignIn(request)
			generation++
			message = "Finish signing in in your browser, then return to Janet."
			Calls.update()
			request.browserUrl
		} catch (_: Exception) {
			message = "Could not prepare sign-in. Check the bridge address and try again."
			Calls.update()
			null
		}
	}

	fun cancel(context: Context): Boolean {
		if (finishing) return false
		generation++
		exchanging = false
		val cleared = Settings(context).clearPendingSignIn()
		message = if (cleared) "Sign-in cancelled."
			else "Could not cancel sign-in on this phone. Keep Janet open and try cancelling again."
		Calls.update()
		return cleared
	}

	fun close(context: Context) {
		if (finishing || Settings(context).webResetRequired()) return
		if (cancel(context)) open = false
		Calls.update()
	}

	private fun resetWebSession(context: Context, success: String = "Home-page session cleared. You can return to Janet.") {
		open = true
		finishing = true
		message = "Clearing the previous home-page session…"
		forgetWebSession {
			finishing = false
			message = if (Settings(context).finishWebReset()) success
				else "Could not save the session reset. Tap Open sign-in in browser to retry."
			Calls.update()
		}
		Calls.update()
	}

	internal fun receive(
		context: Context,
		raw: String,
		exchange: (PendingSignIn, String, String) -> PairResult = { request, code, name -> Bridge.signIn(request, code, name) },
	) {
		val app = context.applicationContext
		val request = pending(app)
		val callback = request?.let { signInCallback(raw, it, System.currentTimeMillis(), SystemClock.elapsedRealtime()) }
		open = true
		if (callback == null || callback == SignInCallback.Invalid) {
			message = "This sign-in return is invalid or expired. Return to the browser or start sign-in again."
			Calls.update()
			return
		}
		// Persist consumption before any network request, including when Android later kills the process.
		if (!Settings(app).clearPendingSignIn()) {
			message = "Could not finish sign-in safely. Start sign-in again."
			Calls.update()
			return
		}
		if (callback == SignInCallback.Denied || callBusy() || Pairer.host != null) {
			message = if (callback == SignInCallback.Denied) "Sign-in was declined. You can try again." else "Finish the call or pairing, then sign in again."
			Calls.update()
			return
		}
		val code = (callback as SignInCallback.Code).value
		val epoch = ++generation
		exchanging = true
		message = "Finishing sign-in with ${bridgeAuthority(request.url)}…"
		Calls.update()
		Thread({
			val result = exchange(request, code, "${Build.MANUFACTURER} ${Build.MODEL}")
			Calls.update {
				if (generation == epoch) {
					exchanging = false
					message = when {
						callBusy() -> "Finish the call, then sign in again. Your pairing is unchanged."
						result is PairResult.Refused -> result.reason
						else -> try {
							val pairing = (result as PairResult.Paired).pairing
							Settings(app).requireWebReset()
							Settings(app).save(pairing)
							resetWebSession(app, "Signed in. This phone is enrolled with your Janet account.")
							Calls.line = Line.Checking
							Bridge.warm(pairing, Calls.lineSink(app, pairing))
							message
						} catch (_: Exception) {
							"Could not save the new pairing. Your previous pairing is kept. Try signing in again."
						}
					}
				}
			}
		}, "janet-signin").start()
	}
}
