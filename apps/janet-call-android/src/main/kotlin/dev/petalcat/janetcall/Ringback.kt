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

/**
 * The tone for a call that was lost, not ended: the fast-busy beeps of a network that dropped the line. It is
 * a pair of low steady pitches that repeat, so it cannot be taken for Janet's hang-up earcon, which is two
 * soft notes falling once. Safe to [play] from any thread: a tone that cannot sound is no tone.
 */
class DropTone(private val tone: () -> Tone = { SystemTone(ToneGenerator.TONE_SUP_CONGESTION) }) {
	fun play(handler: android.os.Handler) {
		val made = runCatching { tone() }.getOrNull() ?: return
		if (runCatching { made.start() }.isSuccess) handler.postDelayed({ runCatching { made.stop() } }, DROP_TONE_MS)
		else runCatching { made.stop() }
	}

	companion object {
		/** About two beeps of the congestion tone's 250 ms on, 250 ms off. */
		const val DROP_TONE_MS = 1_000L
	}
}

private class SystemTone(private val kind: Int = ToneGenerator.TONE_SUP_RINGTONE) : Tone {
	private val generator = ToneGenerator(AudioManager.STREAM_VOICE_CALL, VOLUME)

	override fun start() {
		generator.startTone(kind)
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
