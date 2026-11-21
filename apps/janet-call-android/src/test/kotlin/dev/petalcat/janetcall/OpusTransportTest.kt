package dev.petalcat.janetcall

import org.junit.Assert.*
import org.junit.Test

class OpusTransportTest {
	@Test
	fun `wire header uses network byte order and preserves packet boundaries`() {
		val packet = OpusWire.pack(0x0102030405060708, byteArrayOf(0x48, 1, 2))
		assertArrayEquals(byteArrayOf(0x4a, 0x4f, 0x50, 0x31, 1, 2, 3, 4, 5, 6, 7, 8, 0x48, 1, 2), packet)
		val (timestamp, opus) = OpusWire.unpack(packet)
		assertEquals(0x0102030405060708, timestamp)
		assertArrayEquals(byteArrayOf(0x48, 1, 2), opus)
	}

	@Test
	fun `bad magic empty payload and oversized packets are rejected`() {
		for (packet in listOf(ByteArray(12), ByteArray(13), ByteArray(1288))) {
			assertThrows(IllegalArgumentException::class.java) { OpusWire.unpack(packet) }
		}
	}

	@Test
	fun `metadata keeps PCM compatibility and announces Opus`() {
		assertEquals(ServerMessage.Audio(24000, "opus"), parseServerMessage("""{"type":"audio","rate":24000,"codec":"opus"}"""))
		assertEquals(ServerMessage.Audio(16000), parseServerMessage("""{"type":"audio","rate":16000}"""))
	}

	@Test
	fun `retries back off and expire after twenty seconds regardless of attempts`() {
		val retry = ReconnectWindow()
		assertEquals(250L, retry.nextDelay(1000))
		assertEquals(500L, retry.nextDelay(1250))
		assertEquals(1000L, retry.nextDelay(1750))
		assertEquals(2000L, retry.nextDelay(2750))
		assertEquals(4000L, retry.nextDelay(4750))
		assertEquals(4000L, retry.nextDelay(8750))
		assertEquals(1L, retry.nextDelay(20999))
		assertNull(retry.nextDelay(21000))
	}

	@Test
	fun `compressed mic backlog drops a run until the queue drains`() {
		val backlog = MicBacklog(frameBytes = 80, limitBytes = 1600)
		assertTrue(backlog.admits(1599))
		assertFalse(backlog.admits(1600))
		assertFalse(backlog.admits(500))
		assertTrue(backlog.admits(80))
	}
}
