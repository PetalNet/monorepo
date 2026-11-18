package dev.petalcat.janetcall

import org.junit.Assert.assertEquals
import org.junit.Test

class RingbackTest {
	private class Counting : Tone {
		var started = 0
		var stopped = 0

		override fun start() {
			started++
		}

		override fun stop() {
			stopped++
		}
	}

	@Test
	fun `the tone sounds once and ends at the first stop, however often either is called`() {
		val tones = mutableListOf<Counting>()
		val ringback = Ringback { Counting().also(tones::add) }
		ringback.start()
		ringback.start()
		assertEquals(1, tones.size)
		assertEquals(1, tones[0].started)
		ringback.stop()
		ringback.stop()
		assertEquals(1, tones[0].stopped)
	}

	@Test
	fun `a stop with no tone does nothing, and a later call rings again`() {
		val tones = mutableListOf<Counting>()
		val ringback = Ringback { Counting().also(tones::add) }
		ringback.stop()
		assertEquals(0, tones.size)
		ringback.start()
		ringback.stop()
		ringback.start()
		assertEquals(2, tones.size)
	}
}
