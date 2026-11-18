package dev.petalcat.janetcall

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FramePacingTest {
	@Test
	fun `a quick frame is followed a thirtieth of a second after its vsync`() {
		for (busyMs in 0L..7L) assertEquals("a frame that took $busyMs ms", 30L, busyMs + frameGapMs(busyMs))
	}

	@Test
	fun `slow frames keep the main thread for a quarter of the time at most`() {
		for (busyMs in listOf(10L, 40L, 400L, 3_000L)) {
			val share = busyMs.toDouble() / (busyMs + frameGapMs(busyMs))
			assertTrue("frames of $busyMs ms take ${(share * 100).toInt()}% of the main thread", share <= 0.25)
		}
	}
}
