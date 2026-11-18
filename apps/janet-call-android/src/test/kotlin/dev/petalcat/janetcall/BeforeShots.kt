package dev.petalcat.janetcall

import android.content.Intent
import android.net.Uri
import android.os.Looper
import com.github.takahirom.roborazzi.captureRoboImage
import com.github.takahirom.roborazzi.captureScreenRoboImage
import java.util.Base64
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class BeforeShots {
	private val paired = Pairing("wss://bridge.example.com/v1/call", "t", "i", "s")

	private fun reset(pairing: Pairing?, notice: String? = null, state: CallState = CallState.Idle, host: String? = null) {
		Settings.fake = pairing
		Pairer.notice = notice
		Pairer::class.java.getDeclaredField("host").apply { isAccessible = true }.set(Pairer, host)
		Calls.stage = null
		Calls.update(state, "")
		shadowOf(Looper.getMainLooper()).idle()
	}

	private fun shot(name: String, intent: Intent? = null, idleMs: Long = 0, then: (MainActivity) -> Unit = {}) {
		val controller = if (intent == null) Robolectric.buildActivity(MainActivity::class.java) else Robolectric.buildActivity(MainActivity::class.java, intent)
		val activity = controller.setup().get()
		then(activity)
		if (idleMs > 0) Thread.sleep(idleMs)
		shadowOf(Looper.getMainLooper()).idle()
		captureScreenRoboImage("build/shots/$name.png")
		controller.pause().stop().destroy()
	}

	private fun link(): Intent {
		val json = """{"url":"wss://bridge.example.com/v1/call","code":"abc","expires":${System.currentTimeMillis() / 1000 + 300}}"""
		val u = Base64.getUrlEncoder().withoutPadding().encodeToString(json.toByteArray())
		return Intent(Intent.ACTION_VIEW, Uri.parse("janetcall://pair?u=$u"))
	}

	@Test fun unpaired() { reset(null); shot("01-unpaired") }

	@Test fun confirmWaiting() { reset(null); shot("02-pair-confirm-first-second", link()) }

	@Test fun confirmReady() { reset(null); shot("03-pair-confirm", link(), idleMs = 1100) }

	@Test fun pairing() { reset(null, host = "bridge.example.com"); shot("04-pairing") }

	@Test fun errUnreachable() { reset(null, "Could not reach the bridge at bridge.example.com: failed to connect to bridge.example.com/203.0.113.7 (port 443) after 10000ms"); shot("05-error-unreachable") }

	@Test fun errUsed() { reset(null, "This pairing link was already used or has expired. Ask for a new one."); shot("06-error-code-used") }

	@Test fun errRate() { reset(null, "Too many pairing attempts. Wait a minute, then open the pairing link again."); shot("07-error-rate-limited") }

	@Test fun idle() { reset(paired); shot("08-paired-idle") }

	@Test fun micDenied() { reset(paired, "Janet needs the microphone to take a call"); shot("09-error-mic-denied") }

	@Test fun ended() { reset(paired, state = CallState.Ended("Call ended")); shot("10-call-ended") }

	@Test fun endedFailed() { reset(paired, state = CallState.Ended("Failed to connect to bridge.example.com/203.0.113.7:443")); shot("11-call-failed") }

	@Test fun unpairDialog() {
		reset(paired)
		shot("12-unpair-dialog") { a -> a.javaClass.getDeclaredMethod("confirmUnpair").apply { isAccessible = true }.invoke(a) }
	}

	private fun call(name: String, state: CallState, prepare: (CallStage, Double) -> Unit) {
		reset(paired)
		val stage = CallStage()
		prepare(stage, CallStage.nowS())
		Calls.stage = stage
		Calls.update(state, "Earpiece")
		shadowOf(Looper.getMainLooper()).idle()
		shot(name, idleMs = 600)
	}

	@Test fun connecting() = call("13-call-connecting", CallState.Connecting) { _, _ -> }

	@Test fun listening() = call("14-call-listening", CallState.Active) { s, now ->
		s.state(Phase.Listening, now)
		s.hisWords("Janet, is the build done?")
		for (i in 0..60) s.level(null, 0.5, now + i * 0.02, now)
	}

	@Test fun thinking() = call("15-call-thinking", CallState.Active) { s, now ->
		s.hisWords("Janet, is the build done?")
		s.state(Phase.Thinking, now)
	}

	@Test fun speaking() = call("16-call-speaking", CallState.Active) { s, now ->
		s.state(Phase.Speaking, now)
		val seq = s.herSentenceQueued(ServerMessage.HerWords("Three things. Your Mac talks to me now, and nothing needs you.", emptyList()))
		s.herAudioStarted(seq, now)
		for (i in 0..60) s.level(0.6, null, now + i * 0.02, now + i * 0.02)
	}
}
