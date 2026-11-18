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
	fun `call screen events are parsed`() {
		assertEquals(ServerMessage.State(Phase.Thinking), parseServerMessage("""{"type":"state","value":"thinking"}"""))
		assertEquals(ServerMessage.State(Phase.Listening), parseServerMessage("""{"type":"state","value":"listening"}"""))
		assertEquals(ServerMessage.State(Phase.Speaking), parseServerMessage("""{"type":"state","value":"speaking"}"""))
		assertEquals(ServerMessage.Unknown, parseServerMessage("""{"type":"state","value":"dreaming"}"""))
		assertEquals(
			ServerMessage.HerWords("Hi Sam, thanks.", listOf(TimedWord("Hi", 0.0), TimedWord("Sam,", 0.18), TimedWord("thanks.", 0.43))),
			parseServerMessage(
				"""{"type":"words","side":"her","text":"Hi Sam, thanks.","words":[{"w":"Hi","t":0.0,"d":0.18},{"w":"Sam,","t":0.18,"d":0.25},{"w":"thanks.","t":0.43,"d":0.3}]}""",
			),
		)
		assertEquals(ServerMessage.HerWords("No timings.", emptyList()), parseServerMessage("""{"type":"words","side":"her","text":"No timings."}"""))
		assertEquals(ServerMessage.HisWords("what he said"), parseServerMessage("""{"type":"words","side":"him","text":"what he said","words":[]}"""))
		assertEquals(ServerMessage.Unknown, parseServerMessage("""{"type":"words","side":"them","text":"x"}"""))
		assertEquals(ServerMessage.Unknown, parseServerMessage("""{"type":"words","side":"him","text":" "}"""))
		assertEquals(ServerMessage.Level(0.25, 1.0), parseServerMessage("""{"type":"level","her":0.25,"him":7}"""))
		assertEquals(ServerMessage.Level(0.0, null), parseServerMessage("""{"type":"level","her":-1}"""))
		assertEquals(ServerMessage.Level(null, 0.5), parseServerMessage("""{"type":"level","him":0.5}"""))
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
