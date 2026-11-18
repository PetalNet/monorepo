package dev.petalcat.janetcall

import android.os.Looper
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CallsTest {
	private fun settle() = shadowOf(Looper.getMainLooper()).idle()

	@Test
	fun `a finished call leaves neither mute nor a sound route for the next one`() {
		Calls.update(CallState.Active, route = "Speaker")
		Calls.mute(true)
		settle()
		assertEquals(true, Calls.muted)
		assertEquals("Speaker", Calls.route)

		Calls.update(CallState.Ended("done"))
		settle()
		assertEquals(false, Calls.muted)
		assertEquals("", Calls.route)
	}

	@Test
	fun `mute does nothing when there is no call`() {
		Calls.update(CallState.Idle)
		Calls.mute(true)
		settle()
		assertEquals(false, Calls.muted)
	}
}
