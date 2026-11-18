package dev.petalcat.janetcall

import android.content.ComponentName
import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager

sealed interface CallState {
	data object Idle : CallState

	data object Connecting : CallState

	data object Active : CallState

	data class Ended(val reason: String) : CallState
}

/** Call state shared between the ConnectionService and the activity. Mutated and observed on the main thread. */
object Calls {
	var state: CallState = CallState.Idle
		private set
	var route: String = ""
		private set
	var connection: JanetConnection? = null

	/** True while the caller has muted the microphone. Read on the microphone thread. A new call starts unmuted. */
	@Volatile var muted = false
		private set

	fun mute(on: Boolean) = update { muted = on && inCall }

	/** What the call screen shows of the call in progress. */
	var stage: CallStage? = null

	/** When the call connected, on the elapsed-realtime clock, or null while there is no connected call. */
	var activeSinceMs: Long? = null
		private set

	private val main = Handler(Looper.getMainLooper())
	private val observers = mutableListOf<() -> Unit>()

	val inCall: Boolean get() = state is CallState.Connecting || state is CallState.Active

	fun observe(observer: () -> Unit) {
		observers += observer
	}

	fun unobserve(observer: () -> Unit) {
		observers -= observer
	}

	fun update(state: CallState = this.state, route: String = this.route) = update {
		this.state = state
		activeSinceMs = if (state is CallState.Active) activeSinceMs ?: SystemClock.elapsedRealtime() else null
		// A finished call leaves no sound route behind for the next one to show.
		this.route = if (inCall) route else ""
		if (!inCall) muted = false
	}

	/** Runs [change] on the main thread, then tells the observers. */
	fun update(change: () -> Unit) = main.post {
		change()
		observers.toList().forEach { it() }
	}
}

object Dialer {
	private val ADDRESS: Uri = Uri.parse("sip:janet@janet")

	private fun handle(context: Context) =
		PhoneAccountHandle(ComponentName(context, JanetConnectionService::class.java), "janet")

	/** Places the call. Returns a reason it could not be placed, or null. */
	fun place(context: Context): String? {
		if (Calls.inCall) return null
		val pairing = Settings(context).pairing() ?: return NOT_PAIRED
		// Speech-to-text and the voice start loading now, while Android sets the call up.
		Bridge.warm(pairing)
		val telecom = context.getSystemService(TelecomManager::class.java)
		val handle = handle(context)
		telecom.registerPhoneAccount(
			PhoneAccount.builder(handle, "Janet")
				.setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
				.setAddress(ADDRESS)
				.addSupportedUriScheme(PhoneAccount.SCHEME_SIP)
				.setExtras(Bundle().apply { putBoolean(PhoneAccount.EXTRA_LOG_SELF_MANAGED_CALLS, true) })
				.build(),
		)
		Calls.update(CallState.Connecting)
		return try {
			telecom.placeCall(ADDRESS, Bundle().apply { putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle) })
			null
		} catch (e: SecurityException) {
			Calls.update(CallState.Idle)
			"Telecom refused the call: ${e.message}"
		}
	}
}

/** Debug-only overrides: a WAV as the microphone and a WAV that records what was played. */
object TestHooks {
	@Volatile var micWav: java.io.File? = null

	@Volatile var playedWav: java.io.File? = null
}
