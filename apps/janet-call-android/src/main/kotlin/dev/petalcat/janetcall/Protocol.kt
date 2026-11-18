package dev.petalcat.janetcall

import org.json.JSONException
import org.json.JSONObject

/** Text frames the bridge sends. Anything else is [Unknown] and ignored. */
sealed interface ServerMessage {
	data class Audio(val rate: Int) : ServerMessage

	data object Clear : ServerMessage

	data object Bye : ServerMessage

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
			?.let { ServerMessage.Audio(it) } ?: ServerMessage.Unknown
		"clear" -> ServerMessage.Clear
		"bye" -> ServerMessage.Bye
		else -> ServerMessage.Unknown
	}
}
