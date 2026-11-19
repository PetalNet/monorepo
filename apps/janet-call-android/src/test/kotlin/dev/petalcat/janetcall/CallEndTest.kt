package dev.petalcat.janetcall

import java.net.SocketTimeoutException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CallEndTest {
	@Test
	fun `a normal close is not a drop`() {
		assertEquals(End.Remote("The bridge closed the line"), closedBy(1000, ""))
	}

	@Test
	fun `the bridge's keepalive timeout says the phone's connection stalled`() {
		val end = closedBy(1011, "keepalive ping timeout")
		assertTrue(end is End.Dropped)
		assertTrue((end as End.Dropped).reason.contains("stalled"))
	}

	@Test
	fun `a bridge going down is a drop`() {
		assertTrue(closedBy(1001, "going away") is End.Dropped)
		assertTrue(closedBy(1012, "") is End.Dropped)
	}

	@Test
	fun `any other close names its code and reason`() {
		assertEquals(
			End.Dropped("The bridge closed the line unexpectedly (code 1006, abnormal)."),
			closedBy(1006, "abnormal"),
		)
		assertEquals(End.Dropped("The bridge closed the line unexpectedly (code 4000)."), closedBy(4000, ""))
	}

	@Test
	fun `an unanswered ping and any other failure are both drops with their own words`() {
		assertEquals(
			End.Dropped("The connection to the bridge stopped responding."),
			lostLine(SocketTimeoutException("sent ping but didn't receive pong within 15000ms")),
		)
		assertEquals(
			End.Dropped("Lost the connection to the bridge: Software caused connection abort."),
			lostLine(java.io.IOException("Software caused connection abort")),
		)
	}

	@Test
	fun `a microphone that stops delivering is noticed after five seconds`() {
		val pulse = MicPulse()
		pulse.beat(10_000)
		assertFalse(pulse.stalled(14_999))
		assertFalse(pulse.stalled(15_000))
		assertTrue(pulse.stalled(15_001))
		pulse.beat(15_001)
		assertFalse(pulse.stalled(15_002))
	}
}
