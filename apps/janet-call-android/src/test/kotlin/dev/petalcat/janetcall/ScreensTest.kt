package dev.petalcat.janetcall

import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import java.time.Instant
import java.time.ZoneId
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

private val PAIRED = Pairing("wss://bridge.example.com/v1/call", "t", "i", "s")
private val LINK = PairingLink("wss://other.example.com/v1/call", "code", 9_999_999_999)
private val UTC = ZoneId.of("UTC")

private fun at(iso: String) = Instant.parse(iso).toEpochMilli()

class ScreensTest {
	private fun screen(
		pairingWith: String? = null,
		link: PairingLink? = null,
		ready: Boolean = true,
		paired: Pairing? = null,
		notice: String? = null,
		ended: String? = null,
		recent: List<CallRecord> = emptyList(),
	) = screenFor(pairingWith, link, ready, paired, notice, ended, recent)

	@Test
	fun `an unpaired phone shows the welcome and why the last link failed`() {
		assertEquals(Screen.Welcome(null), screen())
		assertEquals(Screen.Welcome("expired"), screen(notice = "expired"))
	}

	@Test
	fun `a link waiting for an answer shows the question, naming the host it replaces`() {
		assertEquals(Screen.Confirm("other.example.com", null, true), screen(link = LINK))
		assertEquals(Screen.Confirm("other.example.com", "bridge.example.com", false), screen(link = LINK, ready = false, paired = PAIRED))
	}

	@Test
	fun `a pairing in flight outranks everything else`() {
		assertEquals(Screen.Pairing("other.example.com"), screen(pairingWith = "other.example.com", link = LINK, paired = PAIRED))
	}

	@Test
	fun `home says the notice, else how the last call ended, and lists three calls at most`() {
		val calls = (1..5).map { CallRecord(it * 1000L, it, true) }
		assertEquals(Screen.Home("bridge.example.com", "No mic", calls.take(3)), screen(paired = PAIRED, notice = "No mic", ended = "Call ended", recent = calls))
		assertEquals("Call ended", (screen(paired = PAIRED, ended = "Call ended") as Screen.Home).notice)
	}

	@Test
	fun `a call is described by its day and its length`() {
		val now = Instant.parse("2026-11-18T15:00:00Z")
		fun text(iso: String, seconds: Int = 134, ok: Boolean = true) =
			CallRecord(at(iso), seconds, ok).let { whenText(it, now, UTC, Locale.US) to lengthText(it) }
		assertEquals("Today 9:41 AM" to "2:14", text("2026-11-18T09:41:00Z"))
		assertEquals("Yesterday 6:02 PM" to "2:14", text("2026-11-17T18:02:00Z"))
		assertEquals("Tue 10 Nov" to "Did not connect", text("2026-11-10T08:00:00Z", 0, false))
	}
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CallLogTest {
	private val context get() = ApplicationProvider.getApplicationContext<android.app.Application>()

	@Test
	fun `the log keeps the newest ten, newest first, and clears`() {
		val log = CallLog(context)
		assertEquals(emptyList<CallRecord>(), log.recent())
		(1..12).forEach { log.add(CallRecord(it * 1000L, it, it % 2 == 0)) }
		val recent = log.recent()
		assertEquals(10, recent.size)
		assertEquals(CallRecord(12_000, 12, true), recent.first())
		assertEquals(CallRecord(3_000, 3, false), recent.last())
		log.clear()
		assertTrue(log.recent().isEmpty())
	}
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AppConfigTest {
	private val config get() = AppConfig(ApplicationProvider.getApplicationContext<android.app.Application>())

	@Test
	fun `a saved address that no longer validates falls back to the default`() {
		val app = ApplicationProvider.getApplicationContext<android.app.Application>()
		app.getSharedPreferences("janet_call_app", android.content.Context.MODE_PRIVATE).edit().putString("home_url", "http://bad.example/").commit()
		assertEquals(DEFAULT_HOME_URL, AppConfig(app).homeUrl())
	}

	@Test
	fun `the home page is the default until a good address is saved, and a blank one resets it`() {
		assertEquals(DEFAULT_HOME_URL, config.homeUrl())
		assertEquals(true, config.setHomeUrl("http://insecure.example/") != null)
		assertEquals(DEFAULT_HOME_URL, config.homeUrl())
		assertNull(config.setHomeUrl(" https://home.example.com/janet "))
		assertEquals("https://home.example.com/janet", config.homeUrl())
		assertNull(config.setHomeUrl(""))
		assertEquals(DEFAULT_HOME_URL, config.homeUrl())
	}
}
