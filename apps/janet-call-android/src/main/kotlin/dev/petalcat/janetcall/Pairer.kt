package dev.petalcat.janetcall

import android.content.Context
import android.os.Build

/**
 * The pairing attempt in flight and the last thing worth telling the person. It lives outside the
 * activity, so a rotation during the request does not lose the answer. Read and written on the
 * main thread; changes are announced through [Calls]' observers.
 */
object Pairer {
	/** The bridge host being paired with right now, or null. */
	var host: String? = null
		private set

	/** Why the last pairing or call attempt did not go through, or null. */
	var problem: Problem? = null

	fun start(context: Context, link: PairingLink) {
		val app = context.applicationContext
		host = link.host
		problem = null
		Calls.update()
		Thread({
			val failed = pairAndStore(app, link)
			if (failed == null) {
				// A fresh pairing: ask the bridge at once whether the line is up.
				Calls.line = Line.Checking
				Settings(app).pairing()?.let { Bridge.warm(it, Calls.lineSink(app, it)) }
			}
			Calls.update {
				host = null
				problem = failed
			}
		}, "janet-pair").start()
	}

	/** Trades the code for the pairing and stores it. Blocks. Returns why it failed, or null. */
	fun pairAndStore(context: Context, link: PairingLink): Problem? =
		when (val result = Bridge.pair(link, "${Build.MANUFACTURER} ${Build.MODEL}")) {
			// Only a link whose code was not spent can be tried again.
			is PairResult.Refused -> if (result.retryable) Problem.PairUnreachable(result.reason, link) else Problem.Note(result.reason)
			is PairResult.Paired -> try {
				Settings(context).save(result.pairing)
				null
			} catch (_: Exception) {
				// The code is spent by now, so only a new one can pair this phone.
				Problem.Note("This phone could not store the pairing. Ask for a new pairing link.")
			}
		}
}
