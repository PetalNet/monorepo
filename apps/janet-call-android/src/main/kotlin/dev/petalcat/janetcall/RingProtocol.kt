package dev.petalcat.janetcall

import org.json.JSONException
import org.json.JSONObject

private const val RING_SERVER = "https://ntfy.petalcat.dev"
private val TOPIC = Regex("janet-ring-[A-Za-z0-9_-]{43}")
private val RING_ID = Regex("[A-Za-z0-9_-]{1,256}")

class RingRegistration(val topic: String) {
	val socketUrl: String get() = "wss://ntfy.petalcat.dev/$topic/ws"
}

class RingNotice(val id: String, val expires: Double)
class PendingRing(val id: String, val reason: String, val expires: Double)

sealed interface RingCheck {
	data class Live(val ring: PendingRing) : RingCheck
	data object Gone : RingCheck
	data object Retry : RingCheck
}

/** Retains notices during another check and consumes an ID only after a definitive bridge response. */
internal class RingInbox {
	private val queued = LinkedHashMap<String, RingNotice>()
	private val seen = LinkedHashSet<String>()
	private var active: RingNotice? = null

	fun offer(notice: RingNotice) {
		if (notice.id in seen || active?.id == notice.id || queued.size >= 32) return
		queued.putIfAbsent(notice.id, notice)
	}

	fun next(nowS: Long): RingNotice? {
		if (active != null) return null
		queued.entries.removeAll { it.value.expires <= nowS }
		val notice = queued.values.firstOrNull() ?: return null
		queued.remove(notice.id)
		active = notice
		return notice
	}

	fun complete(id: String, retry: Boolean) {
		val notice = active?.takeIf { it.id == id } ?: return
		active = null
		if (retry) queued[id] = notice else {
			seen.add(id)
			while (seen.size > 128) seen.remove(seen.first())
		}
	}

	fun clear() {
		queued.clear()
		seen.clear()
		active = null
	}
}

internal fun ringRemainingMs(expires: Double, nowMs: Long = System.currentTimeMillis()): Long =
	(expires * 1000 - nowMs).toLong().coerceAtLeast(0)

internal fun validRingId(id: String): Boolean = RING_ID.matches(id)

internal fun parseRingRegistration(json: JSONObject): RingRegistration? {
	val server = json.opt("server") as? String ?: return null
	val topic = json.opt("topic") as? String ?: return null
	return if (server == RING_SERVER && TOPIC.matches(topic)) RingRegistration(topic) else null
}

private fun expiry(json: JSONObject): Double? =
	(json.opt("expires") as? Number)?.toDouble()?.takeIf { it.isFinite() }

internal fun parseRingNotice(envelope: String, nowS: Long): RingNotice? = if (envelope.length > 4096) null else try {
	val outer = JSONObject(envelope)
	if (outer.opt("event") != "message") null else {
		val message = outer.opt("message") as? String
		val payload = message?.let(::JSONObject)
		val id = payload?.opt("id") as? String
		val expires = payload?.let(::expiry)
		if (id != null && validRingId(id) && expires != null && expires > nowS) RingNotice(id, expires) else null
	}
} catch (_: JSONException) {
	null
}

internal fun parsePendingRing(json: JSONObject, expectedId: String, nowS: Long): PendingRing? {
	val id = json.opt("id") as? String ?: return null
	val reason = json.opt("reason") as? String ?: return null
	val expires = expiry(json) ?: return null
	return if (id == expectedId && validRingId(id) && expires > nowS) PendingRing(id, reason, expires) else null
}
