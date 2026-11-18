package dev.petalcat.janetcall

import java.time.Instant
import java.time.ZoneId
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Every screen outside a call. A screen that cannot be drawn fails the test. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class HomeShots {
	private val now = Instant.parse("2026-11-18T15:00:00Z")
	private val zone = ZoneId.of("UTC")
	private val calls = listOf(
		CallRecord(Instant.parse("2026-11-18T09:41:00Z").toEpochMilli(), 134, true),
		CallRecord(Instant.parse("2026-11-17T18:02:00Z").toEpochMilli(), 41, true),
		CallRecord(Instant.parse("2026-11-10T08:00:00Z").toEpochMilli(), 0, false),
	)

	private fun draw(name: String, dark: Boolean = true, content: @androidx.compose.runtime.Composable () -> Unit) {
		val clock = doubleArrayOf(100.0)
		shoot(name, dark, before = { activity ->
			if (views<CallSky>(activity.window.decorView).isNotEmpty()) play(activity, clock, 1.0)
		}, content = content)
	}

	@Test fun home() = draw("home-1-calls") { HomeScreen(Screen.Home("bridge.example.com", Line.Ready, null, null, calls), {}, {}, now = now, zone = zone) }

	@Test fun homeLight() = draw("home-2-light", dark = false) { HomeScreen(Screen.Home("bridge.example.com", Line.Ready, null, null, calls), {}, {}, now = now, zone = zone) }

	@Test fun homeEmpty() = draw("home-3-empty") {
		HomeScreen(Screen.Home("bridge.example.com", Line.Ready, Problem.NoMicrophone, null, emptyList()), {}, {}, now = now, zone = zone)
	}

	@Test fun welcome() = draw("home-4-welcome") { WelcomeScreen(Screen.Welcome(null)) }

	@Test fun welcomeFailed() = draw("home-5-welcome-expired", dark = false) {
		WelcomeScreen(Screen.Welcome(Problem.Note("This pairing link has expired. Ask for a new one.")))
	}

	@Test fun confirm() = draw("home-6-confirm") { ConfirmScreen(Screen.Confirm("bridge.example.com", null, true), {}, {}) }

	@Test fun confirmWaiting() = draw("home-7-confirm-replacing", dark = false) {
		ConfirmScreen(Screen.Confirm("other.example.com", "bridge.example.com", false), {}, {})
	}

	@Test fun pairing() = draw("home-8-pairing") { PairingScreen(Screen.Pairing("bridge.example.com")) }

	@Test fun homeFallback() = draw("home-11-page-failed") {
		HomeScreen(Screen.Home("bridge.example.com", Line.Ready, null, null, calls), {}, {}, now, zone, onRetry = {})
	}

	@Test fun homePage() = draw("home-12-web") {
		HomeWeb(DEFAULT_HOME_URL, {}, {}, { retry -> HomeScreen(Screen.Home("bridge.example.com", Line.Ready, null, null, calls), {}, {}, now, zone, onRetry = retry) })
	}

	@Test fun settings() = draw("home-9-settings") { SettingsScreen("bridge.example.com", DEFAULT_HOME_URL, { null }, {}, {}, { "Geist: SIL Open Font License 1.1" }) }

	@Test fun homeCallFailed() = draw("home-15-call-failed") {
		HomeScreen(Screen.Home("bridge.example.com", Line.Ready, Problem.CallFailed("Could not reach the bridge"), null, calls), {}, {}, now = now, zone = zone)
	}

	@Test fun homeUnreachable() = draw("home-16-unreachable", dark = false) {
		HomeScreen(Screen.Home("bridge.example.com", Line.Unreachable, null, null, calls), {}, {}, now = now, zone = zone)
	}

	@Test fun homeForgotten() = draw("home-17-forgotten") {
		HomeScreen(Screen.Home("bridge.example.com", Line.Revoked, Problem.RePair("The bridge no longer knows this phone."), null, calls), {}, {}, now = now, zone = zone)
	}

	@Test fun welcomeRetry() = draw("home-18-pair-retry") {
		val link = PairingLink("wss://bridge.example.com/v1/call", "c", 9_999_999_999)
		WelcomeScreen(Screen.Welcome(Problem.PairUnreachable("Could not reach the bridge at bridge.example.com: no connection", link)))
	}


	@Test fun settingsLight() = draw("home-10-settings-light", dark = false) {
		SettingsScreen("bridge.example.com", DEFAULT_HOME_URL, { null }, {}, {}, { "Geist: SIL Open Font License 1.1" })
	}
}
