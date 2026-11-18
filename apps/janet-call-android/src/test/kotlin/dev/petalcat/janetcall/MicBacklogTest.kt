package dev.petalcat.janetcall

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MicBacklogTest {
	@Test
	fun `a frame is sent while less than half a second of microphone is waiting`() {
		assertTrue(micFrameFits(0))
		assertTrue(micFrameFits(MIC_BACKLOG_BYTES - MIC_CHUNK_BYTES))
	}

	@Test
	fun `a frame is dropped once half a second of microphone is waiting`() {
		assertFalse(micFrameFits(MIC_BACKLOG_BYTES))
		assertFalse(micFrameFits(MIC_BACKLOG_BYTES * 60))
	}

	@Test
	fun `half a second is 16000 bytes of 16 kHz mono PCM16`() {
		assertTrue(MIC_BACKLOG_BYTES == 16_000L)
	}
}
