package dev.petalcat.janetcall

import java.net.URI
import java.net.URISyntaxException
import java.util.Base64
import org.json.JSONException
import org.json.JSONObject

/** What the app holds once paired. [url] is the call WebSocket; [token] is this device's own bearer token. */
data class Pairing(val url: String, val token: String, val cfId: String, val cfSecret: String) {
	val host: String get() = bridgeAuthority(url).orEmpty()
}

/**
 * A decoded `janetcall://pair?u=...` link: where to pair, and the one-time code that buys a device
 * token and the Access credentials. The link holds no lasting secret. [url] is rebuilt from the
 * parsed host, so the host shown is the host every request goes to.
 */
data class PairingLink(val url: String, val code: String, val expires: Long) {
	val host: String get() = bridgeAuthority(url).orEmpty()

	fun expired(nowS: Long) = nowS >= expires

	/** The code is a one-time secret: a log line or a crash report must not carry it. */
	override fun toString() = "PairingLink(host=$host)"
}

sealed interface PairingParse {
	data class Ok(val link: PairingLink) : PairingParse

	data class Bad(val reason: String) : PairingParse
}

/** A pairing code is short-lived. A link that claims a longer life than this did not come from the bridge. */
const val MAX_LINK_LIFE_S = 15 * 60L

/** Longer than any real payload. A longer one is refused before it is decoded. */
const val MAX_PAYLOAD_CHARS = 4096

const val EXPIRED_LINK = "This pairing link has expired. Ask for a new one."
private const val BAD_LINK = "This is not a Janet pairing link."

const val CALL_PATH = "/v1/call"

/** `host[:port]` of a bridge URL, in lower case, or null when the URL is not one this app will talk to. */
fun bridgeAuthority(url: String): String? {
	val uri = try {
		URI(url)
	} catch (_: URISyntaxException) {
		return null
	}
	val host = uri.host?.lowercase() ?: return null
	if (uri.scheme !in setOf("wss", "ws") || uri.rawPath != CALL_PATH) return null
	if (uri.userInfo != null || uri.rawQuery != null || uri.rawFragment != null) return null
	return if (uri.port == -1) host else "$host:${uri.port}"
}

/** A reason [url] cannot be the call WebSocket, or null. ws:// is for a local test bridge in debug builds only. */
fun bridgeUrlProblem(url: String, allowCleartext: Boolean): String? = when {
	bridgeAuthority(url) == null -> "The bridge address is not valid."
	url.startsWith("wss://") -> null
	url.startsWith("ws://") && allowCleartext -> null
	else -> "The bridge address must start with wss://"
}

/** The bridge's HTTP endpoint next to the call WebSocket: `wss://HOST/v1/call` gives `https://HOST/v1/call/<name>`. */
fun bridgeEndpoint(url: String, name: String): String {
	val scheme = if (url.startsWith("wss://")) "https" else "http"
	return "$scheme://${bridgeAuthority(url)}$CALL_PATH/$name"
}

/** [url] rebuilt from its parsed parts, or null when it is not a bridge URL. */
fun canonicalBridgeUrl(url: String): String? {
	val authority = bridgeAuthority(url) ?: return null
	return "${if (url.startsWith("wss://")) "wss" else "ws"}://$authority$CALL_PATH"
}

/** Parses the `u` parameter of a pairing link: base64url of a JSON object, without padding. */
fun parsePairingPayload(u: String, nowS: Long, allowCleartext: Boolean): PairingParse {
	if (u.length > MAX_PAYLOAD_CHARS) return PairingParse.Bad(BAD_LINK)
	val json = try {
		JSONObject(String(Base64.getUrlDecoder().decode(u.trimEnd('=')), Charsets.UTF_8))
	} catch (_: IllegalArgumentException) {
		return PairingParse.Bad(BAD_LINK)
	} catch (_: JSONException) {
		return PairingParse.Bad(BAD_LINK)
	}
	val url = json.optString("url")
	val link = PairingLink(
		url = canonicalBridgeUrl(url) ?: url,
		code = json.optString("code"),
		expires = json.optLong("expires", 0),
	)
	if (link.url.isEmpty() || link.code.isEmpty() || link.expires <= 0) return PairingParse.Bad(BAD_LINK)
	bridgeUrlProblem(link.url, allowCleartext)?.let { return PairingParse.Bad(it) }
	if (link.expired(nowS)) return PairingParse.Bad(EXPIRED_LINK)
	if (link.expires - nowS > MAX_LINK_LIFE_S) return PairingParse.Bad(BAD_LINK)
	return PairingParse.Ok(link)
}
