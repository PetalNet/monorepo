package dev.petalcat.janetcall

import org.json.JSONException
import org.json.JSONObject

/** One word of a sentence Janet is about to say: [start] seconds after the sentence's first sample plays. */
data class TimedWord(val text: String, val start: Double)

/** Text frames the bridge sends. Anything else is [Unknown] and ignored. */
sealed interface ServerMessage {
	data class Audio(val rate: Int, val codec: String = "pcm") : ServerMessage

	data object Clear : ServerMessage

	data object Bye : ServerMessage

	data class State(val phase: Phase) : ServerMessage

	/** A sentence Janet is about to say, sent immediately before its audio. */
	data class HerWords(val text: String, val words: List<TimedWord>) : ServerMessage

	/** What the caller said, once it is transcribed. */
	data class HisWords(val text: String) : ServerMessage

	/**
	 * Levels 0..1: [her] is the audio being sent now, [him] the microphone as the bridge heard it.
	 * A side the event does not mention is null: the bridge sends no reading for her once she stops.
	 */
	data class Level(val her: Double?, val him: Double?) : ServerMessage

	data object Unknown : ServerMessage
}

fun parseServerMessage(text: String): ServerMessage {
	val json = try {
		JSONObject(text)
	} catch (_: JSONException) {
		return ServerMessage.Unknown
	}
	return when (json.optString("type")) {
		"audio" -> json.optInt("rate", 0).takeIf { it in 8_000..48_000 }
			?.let { ServerMessage.Audio(it, json.optString("codec", "pcm")) } ?: ServerMessage.Unknown
		"clear" -> ServerMessage.Clear
		"bye" -> ServerMessage.Bye
		"state" -> when (json.optString("value")) {
			"listening" -> ServerMessage.State(Phase.Listening)
			"thinking" -> ServerMessage.State(Phase.Thinking)
			"speaking" -> ServerMessage.State(Phase.Speaking)
			else -> ServerMessage.Unknown
		}
		"words" -> words(json)
		"level" -> {
			val her = unit(json, "her")
			val him = unit(json, "him")
			if (her == null && him == null) ServerMessage.Unknown else ServerMessage.Level(her, him)
		}
		else -> ServerMessage.Unknown
	}
}

private fun unit(json: JSONObject, name: String): Double? =
	json.optDouble(name, Double.NaN).takeUnless { it.isNaN() }?.coerceIn(0.0, 1.0)

private fun words(json: JSONObject): ServerMessage {
	val text = json.optString("text").trim()
	if (text.isEmpty()) return ServerMessage.Unknown
	return when (json.optString("side")) {
		"him" -> ServerMessage.HisWords(text)
		"her" -> {
			val list = json.optJSONArray("words")
			val words = (0 until (list?.length() ?: 0)).mapNotNull { i ->
				val word = list?.optJSONObject(i) ?: return@mapNotNull null
				val w = word.optString("w")
				val t = word.optDouble("t", Double.NaN)
				if (w.isEmpty() || t.isNaN()) null else TimedWord(w, t)
			}
			ServerMessage.HerWords(text, words)
		}
		else -> ServerMessage.Unknown
	}
}
