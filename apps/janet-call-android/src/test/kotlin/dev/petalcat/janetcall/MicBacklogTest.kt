package dev.petalcat.janetcall

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MicBacklogTest {
	@Test
	fun `every frame is sent while the queue stays short`() {
		val backlog = MicBacklog()
		for (queued in listOf(0L, 640L, 8_000L, MIC_BACKLOG_BYTES - 1)) assertTrue(backlog.admits(queued))
		assertEquals(0L, backlog.dropped)
	}

	@Test
	fun `once half a second waits, frames are dropped until the queue has drained`() {
		val backlog = MicBacklog()
		assertFalse(backlog.admits(MIC_BACKLOG_BYTES))
		// The queue is draining but not empty: a frame let in here would be one of every few.
		for (queued in listOf(15_360L, 8_000L, 1_280L)) assertFalse("at $queued", backlog.admits(queued))
		assertTrue(backlog.admits(640L))
		assertTrue(backlog.admits(8_000L))
		assertEquals(4L, backlog.dropped)
	}

	@Test
	fun `half a second is 25 frames of 640 bytes`() {
		assertEquals(16_000L, MIC_BACKLOG_BYTES)
		assertEquals(640, MIC_CHUNK_BYTES)
	}
}
