package dev.petalcat.janetcall

import android.content.Context
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import org.json.JSONArray
import org.json.JSONObject

/** One call this phone placed. [seconds] is the connected time; a call that never connected has [connected] false. */
data class CallRecord(val startedMs: Long, val seconds: Int, val connected: Boolean)

/**
 * The last few calls, for the home screen. Times and lengths only: no words, no host. It is not a
 * secret, so it sits in plain preferences, and unpairing clears it.
 */
class CallLog(context: Context) {
	private val prefs = context.getSharedPreferences("janet_call_log", Context.MODE_PRIVATE)

	fun add(record: CallRecord) {
		val kept = (listOf(record) + recent(KEEP - 1)).take(KEEP)
		val array = JSONArray()
		kept.forEach { array.put(JSONObject().put("at", it.startedMs).put("s", it.seconds).put("ok", it.connected)) }
		prefs.edit().putString(KEY, array.toString()).apply()
	}

	/** Newest first. A log that cannot be read is an empty one. */
	fun recent(n: Int = KEEP): List<CallRecord> {
		val array = try {
			JSONArray(prefs.getString(KEY, null) ?: return emptyList())
		} catch (_: Exception) {
			return emptyList()
		}
		return (0 until array.length()).mapNotNull { i ->
			array.optJSONObject(i)?.let { CallRecord(it.optLong("at"), it.optInt("s"), it.optBoolean("ok")) }
		}.take(n)
	}

	fun clear() = prefs.edit().clear().apply()

	private companion object {
		const val KEY = "calls"
		const val KEEP = 10
	}
}

/** "Today 9:41", "Yesterday 18:02", then the weekday and date. */
fun whenText(record: CallRecord, now: Instant, zone: ZoneId, locale: Locale = Locale.getDefault()): String {
	val at = Instant.ofEpochMilli(record.startedMs).atZone(zone)
	val days = java.time.temporal.ChronoUnit.DAYS.between(at.toLocalDate(), LocalDate.ofInstant(now, zone))
	// Newer JDKs put a narrow no-break space before AM and PM.
	val time = DateTimeFormatter.ofPattern("h:mm a", locale).format(at).replace('\u202f', ' ')
	return when (days) {
		0L -> "Today $time"
		1L -> "Yesterday $time"
		else -> DateTimeFormatter.ofPattern("EEE d MMM", locale).format(at)
	}
}

/** "2:14" for a call that connected, "Did not connect" for one that did not. */
fun lengthText(record: CallRecord): String =
	if (!record.connected) "Did not connect" else "%d:%02d".format(record.seconds / 60, record.seconds % 60)
