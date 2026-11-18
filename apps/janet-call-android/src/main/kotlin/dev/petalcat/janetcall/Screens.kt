package dev.petalcat.janetcall

/** What the app shows when no call is up. A pure function of the pairing, the pending link and the last answer: [screenFor]. */
sealed interface Screen {
	/** This phone is not paired. [notice] is why the last attempt failed, if it did. */
	data class Welcome(val notice: String?) : Screen

	/** A pairing request is in flight to [host]. */
	data class Pairing(val host: String) : Screen

	/** A link is waiting for a yes or no. [pairReady] is false for the first moment, so a stray tap cannot pair. */
	data class Confirm(val host: String, val replacing: String?, val pairReady: Boolean) : Screen

	/** Paired and idle. [notice] is the last thing worth saying: why a call failed, or how it ended. */
	data class Home(val host: String, val notice: String?, val recent: List<CallRecord>) : Screen
}

fun screenFor(
	pairingWith: String?,
	link: PairingLink?,
	pairReady: Boolean,
	paired: Pairing?,
	notice: String?,
	ended: String?,
	recent: List<CallRecord>,
): Screen = when {
	pairingWith != null -> Screen.Pairing(pairingWith)
	link != null -> Screen.Confirm(link.host, paired?.host, pairReady)
	paired == null -> Screen.Welcome(notice)
	else -> Screen.Home(paired.host, notice ?: ended, recent.take(3))
}
