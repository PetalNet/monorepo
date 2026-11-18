package dev.petalcat.janetcall

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.util.Log
import java.io.File

/**
 * Debug builds only (see src/debug/AndroidManifest.xml). Scripted from adb:
 *   -a dev.petalcat.janetcall.PROVISION --es url wss://... --es token ... [--es cf_id ... --es cf_secret ...]
 *   -a dev.petalcat.janetcall.CALL [--es mic in.wav] [--es out played.wav]
 *   -a dev.petalcat.janetcall.HANGUP
 * WAV names are files in the app's external files dir.
 */
class DebugControlActivity : Activity() {
	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		val extras = intent.extras
		fun extra(name: String) = extras?.getString(name)
		getExternalFilesDir(null)
		fun wav(name: String?) = name?.let { File(getExternalFilesDir(null), File(it).name) }
		when (intent.action) {
			"dev.petalcat.janetcall.PROVISION" -> {
				Settings(this).save(extra("url").orEmpty(), extra("token"), extra("cf_id"), extra("cf_secret"))
				Log.i(TAG, "provisioned: ${Settings(this).config().problem() ?: "ok"}")
			}
			"dev.petalcat.janetcall.CALL" -> {
				TestHooks.micWav = wav(extra("mic"))
				TestHooks.playedWav = wav(extra("out"))
				startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
				Log.i(TAG, "call: ${Dialer.place(this) ?: "placed"}")
			}
			"dev.petalcat.janetcall.HANGUP" -> Calls.connection?.hangup()
		}
		finish()
	}

	private companion object {
		const val TAG = "JanetCallDebug"
	}
}
