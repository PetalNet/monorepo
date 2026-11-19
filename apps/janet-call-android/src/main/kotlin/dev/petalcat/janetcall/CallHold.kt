package dev.petalcat.janetcall

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.PowerManager
import android.util.Log

/**
 * What keeps a call's microphone and connection alive while the screen is off and the app is behind
 * another: a partial wake lock so the CPU does not sleep under the microphone thread and the socket, a
 * Wi-Fi lock so the radio does not nap between packets, and audio focus so another app's sound does not
 * take the call's place. A foreground service of type microphone keeps the app allowed to record, but it
 * holds none of these. [start] and [stop] are safe to call in any order and more than once.
 */
class CallHold(context: Context) {
	private val app = context.applicationContext
	private var wake: PowerManager.WakeLock? = null
	private var wifi: List<WifiManager.WifiLock> = emptyList()
	private var focus: AudioFocusRequest? = null
	private var started = false

	@Synchronized
	fun start() {
		if (started) return
		started = true
		wake = runCatching {
			app.getSystemService(PowerManager::class.java)
				.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "janetcall:call")
				.apply {
					setReferenceCounted(false)
					acquire(SAFETY_MS)
				}
		}.getOrNull()
		// Low latency holds the radio only with the screen on and the app in front; high performance is the lock that
		// holds it behind another app or with the screen off, and it is deprecated from API 34, so both are taken.
		wifi = listOfNotNull(
			if (Build.VERSION.SDK_INT >= 29) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else null,
			@Suppress("DEPRECATION") WifiManager.WIFI_MODE_FULL_HIGH_PERF,
		).mapNotNull { mode ->
			runCatching {
				app.getSystemService(WifiManager::class.java)
					.createWifiLock(mode, "janetcall:call")
					.apply {
						setReferenceCounted(false)
						acquire()
					}
			}.getOrNull()
		}
		focus = runCatching {
			val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
				.setAudioAttributes(
					AudioAttributes.Builder()
						.setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
						.setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
						.build(),
				)
				// The call goes on whatever another app does with the audio: nothing here may pause it.
				.setOnAudioFocusChangeListener { change -> Log.i("JanetCall", "audio focus changed: $change; the call goes on") }
				.build()
			request.takeIf { app.getSystemService(AudioManager::class.java).requestAudioFocus(it) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED }
		}.getOrNull()
	}

	@Synchronized
	fun stop() {
		runCatching { wake?.takeIf { it.isHeld }?.release() }
		wifi.forEach { lock -> runCatching { if (lock.isHeld) lock.release() } }
		runCatching { focus?.let { app.getSystemService(AudioManager::class.java).abandonAudioFocusRequest(it) } }
		started = false
		wake = null
		wifi = emptyList()
		focus = null
	}

	private companion object {
		/** A call lasts at most the bridge's 15 minutes; a lock that outlives a bug in [stop] must not drain the battery. */
		const val SAFETY_MS = 30 * 60 * 1000L
	}
}
