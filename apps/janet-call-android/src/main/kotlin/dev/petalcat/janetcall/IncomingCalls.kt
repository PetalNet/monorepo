package dev.petalcat.janetcall

import android.content.Context
import android.os.Handler
import android.os.Looper
import java.util.concurrent.Executors

internal object RingWork {
	private val worker = Executors.newSingleThreadExecutor { task -> Thread(task, "janet-ring-check") }
	fun run(task: () -> Unit) { worker.execute(task) }
}

class IncomingCall(val pairing: Pairing, val ring: PendingRing)

/** One authenticated ring reserved while Telecom creates its connection. Main thread only. */
object IncomingCalls {
	const val EXTRA_RING_ID = "dev.petalcat.janetcall.RING_ID"
	private val main = Handler(Looper.getMainLooper())
	var pending: IncomingCall? = null
		private set
	private var timeout: Runnable? = null

	fun offer(context: Context, pairing: Pairing, ring: PendingRing) {
		if (Settings(context).pairing() != pairing || ringRemainingMs(ring.expires) <= 0) return
		if (pending?.ring?.id == ring.id) return
		if (Calls.inCall || pending != null || Calls.connection != null) {
			decline(pairing, ring.id, busy = true)
			return
		}
		val call = IncomingCall(pairing, ring)
		pending = call
		Calls.update(CallState.Ringing(ring))
		timeout = Runnable {
			if (pending !== call) return@Runnable
			Calls.connection?.expireIncoming() ?: clear(context, "Missed call from Janet")
		}.also { main.postDelayed(it, ringRemainingMs(ring.expires)) }
		try {
			Dialer.incoming(context, ring.id)
		} catch (_: RuntimeException) {
			decline(pairing, ring.id, busy = true)
			clear(context, "Android could not receive the call")
		}
	}

	fun matching(context: Context, id: String?): IncomingCall? = pending?.takeIf {
		it.ring.id == id && Settings(context).pairing() == it.pairing && ringRemainingMs(it.ring.expires) > 0
	}

	fun failed(context: Context, id: String?) {
		val call = pending?.takeIf { it.ring.id == id } ?: return
		decline(call.pairing, call.ring.id, busy = true)
		clear(context, "Android could not receive the call")
	}

	fun answered(context: Context) {
		timeout?.let(main::removeCallbacks)
		timeout = null
		IncomingNotification.cancel(context)
	}

	fun clear(context: Context, reason: String? = null) {
		timeout?.let(main::removeCallbacks)
		timeout = null
		pending = null
		IncomingNotification.cancel(context)
		if (reason != null) Calls.update(CallState.Ended(reason))
	}

	fun pairingChanged(context: Context) {
		val call = pending ?: return
		if (Settings(context).pairing() == call.pairing) return
		Calls.connection?.hangup() ?: clear(context, "Pairing changed")
	}

	fun decline(pairing: Pairing, id: String, busy: Boolean = false) = RingWork.run {
		Bridge.declineRing(pairing, id, busy)
	}
}
