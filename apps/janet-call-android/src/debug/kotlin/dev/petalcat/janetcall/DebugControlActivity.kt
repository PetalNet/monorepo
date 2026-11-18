package dev.petalcat.janetcall

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.util.Log
import java.io.File

/**
 * Debug builds only (see src/debug/AndroidManifest.xml). Scripted from adb:
 *   -a dev.petalcat.janetcall.PROVISION --es u PAYLOAD      pairs with a link's `u` payload, no confirmation
 *   -a dev.petalcat.janetcall.PROVISION --es url wss://... --es token ... [--es cf_id ... --es cf_secret ...]
 *   -a dev.petalcat.janetcall.UNPAIR
 *   -a dev.petalcat.janetcall.CALL [--es mic in.wav] [--es out played.wav]
 *   -a dev.petalcat.janetcall.HANGUP
 * WAV names are files in the app's external files dir. Outcomes go to logcat under JanetCallDebug.
 */
class DebugControlActivity : Activity() {
	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		handle(intent)
	}

	/** A second `am start` reaches the instance that is still finishing, so it arrives here. */
	override fun onNewIntent(intent: Intent) {
		super.onNewIntent(intent)
		handle(intent)
	}

	private fun handle(intent: Intent) {
		val extras = intent.extras
		fun extra(name: String) = extras?.getString(name)
		fun wav(name: String?) = name?.let { File(getExternalFilesDir(null), File(it).name) }
		val settings = Settings(applicationContext)
		when (intent.action) {
			"dev.petalcat.janetcall.PROVISION" -> extra("u")?.let { pairWith(it) } ?: run {
				val pairing = Pairing(extra("url").orEmpty(), extra("token").orEmpty(), extra("cf_id").orEmpty(), extra("cf_secret").orEmpty())
				val problem = bridgeUrlProblem(pairing.url, allowCleartext = true) ?: "The token is empty".takeIf { pairing.token.isEmpty() }
				if (problem == null) settings.save(pairing)
				Log.i(TAG, "provisioned: ${problem ?: "ok"}")
			}
			"dev.petalcat.janetcall.UNPAIR" -> {
				settings.clear()
				Log.i(TAG, "unpaired")
			}
			"dev.petalcat.janetcall.CALL" -> {
				TestHooks.micWav = wav(extra("mic"))
				TestHooks.playedWav = wav(extra("out"))
				startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
				Log.i(TAG, "call: ${Dialer.place(this) ?: "placed"}")
			}
			"dev.petalcat.janetcall.HANGUP" -> {
				Calls.connection?.hangup()
				Log.i(TAG, "hangup")
			}
		}
		finish()
	}

	private fun pairWith(payload: String) {
		val parsed = parsePairingPayload(payload, System.currentTimeMillis() / 1000, allowCleartext = true)
		if (parsed !is PairingParse.Ok) {
			Log.i(TAG, "provisioned: ${(parsed as PairingParse.Bad).reason}")
			return
		}
		val app = applicationContext
		Thread({ Log.i(TAG, "provisioned: ${Pairer.pairAndStore(app, parsed.link) ?: "ok"}") }, "janet-pair").start()
	}

	private companion object {
		const val TAG = "JanetCallDebug"
	}
}
