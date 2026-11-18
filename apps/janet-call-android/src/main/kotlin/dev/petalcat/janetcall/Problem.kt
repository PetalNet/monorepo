package dev.petalcat.janetcall

/**
 * Something went wrong that the person can act on. Every problem says what happened and, when
 * there is something to tap, [action] names it: the screen shows one button, and [MainActivity]
 * does the work.
 */
sealed interface Problem {
	val message: String

	/** The label of the one thing to tap, or null when there is nothing to do but read it. */
	val action: String?

	/** Information, or a refusal that only a new pairing link can fix. */
	data class Note(override val message: String) : Problem {
		override val action: String? = null
	}

	/** The bridge could not be reached while pairing. The link's code is still unspent, so the same link can be tried again. */
	data class PairUnreachable(override val message: String, val link: PairingLink) : Problem {
		override val action = "Try again"
	}

	data object NoMicrophone : Problem {
		override val message = "Janet needs the microphone to take a call."
		override val action = "Open app settings"
	}

	data class CallFailed(override val message: String) : Problem {
		override val action = "Call again"
	}

	/** The bridge no longer accepts this phone, or the stored pairing is unusable. Only a new pairing fixes it. */
	data class RePair(override val message: String) : Problem {
		override val action = "Pair again"
	}
}

/** What the last ping to the bridge's warm-up endpoint said about the line to Janet. */
enum class Line {
	Checking,
	Ready,
	Unreachable,
	/** The bridge answered, and it does not know this phone's token. */
	Revoked,
}

/** The two-line headline of the home screen. */
fun lineHeadline(line: Line): String = when (line) {
	Line.Checking, Line.Ready -> "Ready when\nyou are."
	Line.Unreachable -> "Janet's line\nis down."
	Line.Revoked -> "The bridge forgot\nthis phone."
}

/** The line under the headline when there is no problem to show. */
fun lineStatus(line: Line, host: String): String = when (line) {
	Line.Checking -> "Checking the line to $host…"
	Line.Ready -> "Paired with $host"
	Line.Unreachable -> "Can't reach $host right now. You can still try a call."
	Line.Revoked -> "$host no longer knows this phone"
}
