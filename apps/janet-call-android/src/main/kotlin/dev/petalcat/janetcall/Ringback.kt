package dev.petalcat.janetcall

import android.media.AudioManager
import android.media.ToneGenerator

/** The tone a caller hears while the other end is not yet there. */
interface Tone {
	fun start()

	fun stop()
}

/**
 * The ringback tone, on the call's own audio stream so Telecom routes it to the earpiece or a Bluetooth
 * headset with the call. [start] and [stop] are safe to call from any thread, in any order, any number
 * of times: only the first [start] sounds and the first [stop] after it ends it.
 */
class Ringback(private val tone: () -> Tone = { SystemTone() }) {
	private var playing: Tone? = null

	/** A tone that cannot be made or started is no tone: it must never take the call down with it. */
	@Synchronized
	fun start() {
		if (playing != null) return
		val made = runCatching { tone() }.getOrNull() ?: return
		if (runCatching { made.start() }.isSuccess) playing = made else runCatching { made.stop() }
	}

	@Synchronized
	fun stop() {
		val tone = playing ?: return
		playing = null
		runCatching { tone.stop() }
	}
}

private class SystemTone : Tone {
	private val generator = ToneGenerator(AudioManager.STREAM_VOICE_CALL, VOLUME)

	override fun start() {
		generator.startTone(ToneGenerator.TONE_SUP_RINGTONE)
	}

	override fun stop() {
		try {
			generator.stopTone()
		} finally {
			generator.release()
		}
	}

	private companion object {
		/** 0 to 100. The tone is quieter than speech, so a call that starts with a tone does not start with a blast. */
		const val VOLUME = 60
	}
}
