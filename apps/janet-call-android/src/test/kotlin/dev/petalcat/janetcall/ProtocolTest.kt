package dev.petalcat.janetcall

import java.io.File
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class ProtocolTest {
	@Test
	fun `bridge messages are parsed and unknown ones ignored`() {
		assertEquals(ServerMessage.Audio(24_000), parseServerMessage("""{"type":"audio","rate":24000}"""))
		assertEquals(ServerMessage.Clear, parseServerMessage("""{"type":"clear"}"""))
		assertEquals(ServerMessage.Bye, parseServerMessage("""{"type":"bye"}"""))
		assertEquals(ServerMessage.Unknown, parseServerMessage("""{"type":"future-thing"}"""))
		assertEquals(ServerMessage.Unknown, parseServerMessage("""{"type":"audio","rate":0}"""))
		assertEquals(ServerMessage.Unknown, parseServerMessage("not json"))
	}

	@Test
	fun `a written wav reads back as the same pcm`() {
		val pcm = ByteArray(640) { (it * 7).toByte() }
		val file = File.createTempFile("wav", ".wav")
		WavWriter(file, 16_000).apply {
			write(pcm)
			close()
		}
		assertArrayEquals(pcm, Wav.readPcm16Mono(file, 16_000))
		file.delete()
	}
}
