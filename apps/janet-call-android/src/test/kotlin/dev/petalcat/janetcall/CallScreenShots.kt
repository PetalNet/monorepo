package dev.petalcat.janetcall

import android.os.SystemClock
import kotlin.math.sin
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The call screen in each state a call passes through. A screen that cannot be drawn fails the test. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class CallScreenShots {
	private fun call(
		name: String,
		connected: Boolean = true,
		route: String = "Earpiece",
		muted: Boolean = false,
		dark: Boolean = true,
		seconds: Double = 2.0,
		script: (CallStage, Double) -> Unit = { _, _ -> },
	) {
		val stage = CallStage()
		val clock = doubleArrayOf(100.0)
		val ui = CallUi(if (connected) SystemClock.elapsedRealtime() - 42_000 else null, if (connected) route else "", muted)
		shoot(name, dark, before = { play(it, clock, seconds) { now -> script(stage, now) } }) {
			CallScreen(ui, stage, onMute = {}, onSpeaker = {}, onHangUp = {}, clock = { clock[0] })
		}
	}

	private fun voice(t: Double) = 0.35 + 0.3 * sin(t * 9) * sin(t * 2.3)

	private val asked = "Janet, is the build done?"

	@Test fun connecting() = call("call-1-connecting", connected = false)

	@Test
	fun listening() = call("call-2-listening") { stage, now ->
		if (now == 100.0) {
			stage.state(Phase.Listening, now)
			stage.hisWords(asked)
		}
		stage.level(null, voice(now), now, now)
	}

	@Test
	fun thinking() = call("call-3-thinking") { stage, now ->
		if (now == 100.0) {
			stage.hisWords(asked)
			stage.state(Phase.Thinking, now)
		}
	}

	private fun speaking(stage: CallStage, now: Double) {
		if (now == 100.0) {
			stage.state(Phase.Speaking, now)
			val seq = stage.herSentenceQueued(ServerMessage.HerWords("Three things. Your Mac talks to me now, and nothing needs you.", emptyList()))
			stage.herAudioStarted(seq, now)
		}
		stage.level(voice(now), null, now, now)
	}

	@Test fun speaking() = call("call-4-speaking", script = ::speaking)

	@Test fun speakingLight() = call("call-5-speaking-light", dark = false, script = ::speaking)

	@Test fun speakerOn() = call("call-6-speaker-on", route = "Speaker", script = ::speaking)

	@Test fun muted() = call("call-7-muted", muted = true)
}
