package dev.petalcat.janetcall

/** What the app shows when no call is up. A pure function of the pairing, the pending link and the last answer: [screenFor]. */
sealed interface Screen {
	/** This phone is not paired. [problem] is why the last attempt failed, if it did. */
	data class Welcome(val problem: Problem?) : Screen

	/** A pairing request is in flight to [host]. */
	data class Pairing(val host: String) : Screen

	/** A link is waiting for a yes or no. [pairReady] is false for the first moment, so a stray tap cannot pair. */
	data class Confirm(val host: String, val replacing: String?, val pairReady: Boolean) : Screen

	/**
	 * Paired and idle. [problem] is what to fix first, and [ended] how the last call ended when it
	 * did not go wrong. [line] is what the bridge last said about the line.
	 */
	data class Home(
		val host: String,
		val line: Line,
		val problem: Problem?,
		val ended: String?,
		val recent: List<CallRecord>,
	) : Screen
}

fun screenFor(
	pairingWith: String?,
	link: PairingLink?,
	pairReady: Boolean,
	paired: Pairing?,
	problem: Problem?,
	ended: String?,
	line: Line,
	recent: List<CallRecord>,
): Screen = when {
	pairingWith != null -> Screen.Pairing(pairingWith)
	link != null -> Screen.Confirm(link.host, paired?.host, pairReady)
	paired == null -> Screen.Welcome(problem)
	else -> Screen.Home(
		host = paired.host,
		line = line,
		// A phone the bridge has forgotten has one thing to do, and it comes before anything else it says.
		problem = problem ?: if (line == Line.Revoked) Problem.RePair("The bridge no longer knows this phone.") else null,
		ended = ended,
		recent = recent.take(3),
	)
}
