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
	var notice: String? = null

	fun start(context: Context, link: PairingLink) {
		val app = context.applicationContext
		host = link.host
		notice = null
		Calls.update()
		Thread({
			val problem = pairAndStore(app, link)
			Calls.update {
				host = null
				notice = problem
			}
		}, "janet-pair").start()
	}

	/** Trades the code for a device token and stores the pairing. Blocks. Returns why it failed, or null. */
	fun pairAndStore(context: Context, link: PairingLink): String? =
		when (val result = Bridge.pair(link, "${Build.MANUFACTURER} ${Build.MODEL}")) {
			is PairResult.Refused -> result.reason
			is PairResult.Paired -> try {
				Settings(context).save(result.pairing)
				null
			} catch (_: Exception) {
				// The code is spent by now, so only a new one can pair this phone.
				"This phone could not store the pairing. Open the pairing page again for a new code."
			}
		}
}
