package dev.petalcat.janetcall

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class MuteTest {
	private class Tone : Mic {
		var stopped = false

		override fun read(buf: ByteArray): Int {
			buf.fill(7)
			return buf.size
		}

		override fun stop() {
			stopped = true
		}

		override fun close() = Unit
	}

	@Test
	fun `a muted microphone sends silence at the same pace and comes back when unmuted`() {
		var muted = false
		val mic = MutableMic(Tone()) { muted }
		val buf = ByteArray(MIC_CHUNK_BYTES)

		assertEquals(buf.size, mic.read(buf))
		assertArrayEquals(ByteArray(buf.size) { 7 }, buf)

		muted = true
		assertEquals("a muted frame is still a whole frame", buf.size, mic.read(buf))
		assertArrayEquals(ByteArray(buf.size), buf)
		assertEquals(0.0, pcmLevel(buf), 0.0)

		muted = false
		mic.read(buf)
		assertArrayEquals(ByteArray(buf.size) { 7 }, buf)
	}

	@Test
	fun `stopping a muted microphone stops the real one`() {
		val tone = Tone()
		MutableMic(tone) { true }.stop()
		assertEquals(true, tone.stopped)
	}

	@Test
	fun `the status line says what the call is doing`() {
		assertEquals("Calling…", callStatus(connected = false, muted = false, Phase.Idle))
		assertEquals("Listening", callStatus(connected = true, muted = false, Phase.Idle))
		assertEquals("Listening", callStatus(connected = true, muted = false, Phase.Listening))
		assertEquals("Thinking", callStatus(connected = true, muted = false, Phase.Thinking))
		assertEquals("Speaking", callStatus(connected = true, muted = false, Phase.Speaking))
		assertEquals("Muted", callStatus(connected = true, muted = true, Phase.Speaking))
	}
}
