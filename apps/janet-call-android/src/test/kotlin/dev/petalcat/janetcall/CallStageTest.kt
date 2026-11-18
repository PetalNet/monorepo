package dev.petalcat.janetcall

import kotlin.math.sin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CallStageTest {
	private fun sentence(vararg words: Pair<String, Double>) =
		ServerMessage.HerWords(words.joinToString(" ") { it.first }, words.map { TimedWord(it.first, it.second) })

	private val hello = sentence("Hi" to 0.0, "Sam," to 0.2, "thanks" to 0.5, "for" to 0.8, "calling." to 1.0)

	private fun Transcript.text(nowS: Double) = caption(nowS)?.first?.text

	@Test
	fun `her words appear in time with her audio, not when they arrive`() {
		val transcript = Transcript()
		transcript.herSentenceQueued(hello)
		assertNull("nothing shows before her audio starts", transcript.caption(5.0))

		transcript.herAudioStarted(startS = 10.0)
		assertEquals("Hi", transcript.text(10.0))
		assertEquals("Hi Sam,", transcript.text(10.3))
		assertEquals("Hi Sam, thanks for", transcript.text(10.9))
		assertEquals("Hi Sam, thanks for calling.", transcript.text(11.0))
		assertEquals(Side.Her, transcript.caption(11.0)?.first?.side)
	}

	@Test
	fun `a second sentence waits for its own audio and extends the same utterance`() {
		val transcript = Transcript()
		transcript.herSentenceQueued(hello)
		transcript.herSentenceQueued(sentence("How" to 0.0, "are" to 0.2, "you?" to 0.4))
		transcript.herAudioStarted(10.0)
		val first = transcript.caption(12.0)!!.first
		assertEquals("Hi Sam, thanks for calling.", first.text)

		transcript.herAudioStarted(12.5)
		val both = transcript.caption(12.8)!!
		assertEquals("Hi Sam, thanks for calling. How are", both.first.text)
		assertEquals(listOf("Hi Sam, thanks for calling.", "How are"), both.second)
		assertEquals("one utterance", first.id, both.first.id)
	}

	@Test
	fun `his words show at once, in his colour, and replace hers`() {
		val transcript = Transcript()
		transcript.herSentenceQueued(hello)
		transcript.herAudioStarted(10.0)
		val hers = transcript.caption(11.0)!!.first
		transcript.hisWords("Is the build done?")
		val his = transcript.caption(11.0)!!.first
		assertEquals(Caption(hers.id + 1, Side.Him, "Is the build done?"), his)

		transcript.herSentenceQueued(sentence("Not" to 0.0, "yet." to 0.3))
		assertEquals("his line stays until she is heard", his, transcript.caption(11.5)!!.first)
		transcript.herAudioStarted(12.0)
		assertEquals(Caption(his.id + 1, Side.Her, "Not"), transcript.caption(12.1)!!.first)
	}

	@Test
	fun `cutting her off keeps only the words she said and drops what was queued`() {
		val transcript = Transcript()
		transcript.herSentenceQueued(hello)
		transcript.herSentenceQueued(sentence("Never" to 0.0, "said." to 0.3))
		transcript.herAudioStarted(10.0)
		transcript.clear(nowS = 10.6)
		assertEquals("Hi Sam, thanks", transcript.text(10.6))
		assertEquals("no more words appear after the cut", "Hi Sam, thanks", transcript.text(20.0))

		transcript.herAudioStarted(11.0)
		assertEquals("the dropped sentence never shows", "Hi Sam, thanks", transcript.text(20.0))
	}

	@Test
	fun `a sentence without timings shows whole when its audio starts`() {
		val transcript = Transcript()
		transcript.herSentenceQueued(ServerMessage.HerWords("No timings here.", emptyList()))
		transcript.herAudioStarted(3.0)
		assertEquals("No timings here.", transcript.text(3.0))
	}

	@Test
	fun `her next turn starts a new utterance`() {
		val stage = CallStage()
		stage.state(Phase.Speaking, nowS = 0.5)
		stage.herSentenceQueued(hello)
		stage.herAudioStarted(1.0)
		val first = stage.view(3.0).caption!!
		stage.state(Phase.Listening, nowS = 3.5)
		assertEquals("what she said stays up while he talks", first, stage.view(4.0).caption)
		stage.state(Phase.Speaking, nowS = 5.5)
		stage.herSentenceQueued(sentence("Sure." to 0.0))
		stage.herAudioStarted(6.0)
		assertEquals(Caption(first.id + 1, Side.Her, "Sure."), stage.view(6.1).caption)
	}

	@Test
	fun `the level of pcm is its rms against 6000`() {
		fun pcm(amplitude: Int) = ByteArray(640).also { bytes ->
			for (i in 0 until 320) {
				val s = (amplitude * sin(2 * Math.PI * i / 32)).toInt()
				bytes[2 * i] = s.toByte()
				bytes[2 * i + 1] = (s shr 8).toByte()
			}
		}
		assertEquals(0.0, pcmLevel(ByteArray(640)), 0.0)
		assertEquals(0.0, pcmLevel(ByteArray(0)), 0.0)
		assertEquals(3000 / Math.sqrt(2.0) / 6000, pcmLevel(pcm(3000)), 0.002)
		assertEquals("loud speech is the top of the scale", 1.0, pcmLevel(pcm(20_000)), 0.0)
	}

	@Test
	fun `the bridge's levels drive the meter while they keep coming`() {
		val levels = Levels()
		levels.played(0.9, nowS = 10.0)
		levels.mic(0.8, nowS = 10.0)
		levels.remote(her = 0.3, him = 0.1, nowS = 10.0)
		assertEquals(0.3, levels.her(10.2), 0.0)
		assertEquals(0.1, levels.him(10.2), 0.0)
	}

	@Test
	fun `her level falls to silence when the bridge stops sending it`() {
		val levels = Levels()
		levels.remote(her = 0.6, him = 0.0, nowS = 10.0)
		for (tenth in 1..8) levels.remote(her = null, him = 0.2, nowS = 10.0 + tenth / 10.0)
		assertEquals("no reading for her since 10.0", 0.0, levels.her(10.85), 0.0)
		assertEquals(0.2, levels.him(10.85), 0.0)
	}

	@Test
	fun `a second without level events falls back to the levels measured on the phone`() {
		val levels = Levels()
		levels.remote(her = 0.3, him = 0.1, nowS = 10.0)
		levels.played(0.9, nowS = 11.0)
		levels.mic(0.8, nowS = 11.0)
		assertEquals(0.9, levels.her(11.05), 0.0)
		assertEquals(0.8, levels.him(11.05), 0.0)
		assertEquals("no audio played lately is silence, not the last level", 0.0, levels.her(11.5), 0.0)

		levels.remote(her = 0.2, him = 0.0, nowS = 12.0)
		levels.played(0.9, nowS = 12.0)
		assertEquals("the bridge's events take over again", 0.2, levels.her(12.01), 0.0)
	}

	@Test
	fun `with no state events the phase follows who is audible`() {
		val stage = CallStage()
		assertEquals(Phase.Idle, stage.view(0.0).phase)
		stage.played(0.5, heardS = 1.0)
		assertEquals(Phase.Speaking, stage.view(1.01).phase)
		stage.mic(0.5, nowS = 2.0)
		assertEquals(Phase.Listening, stage.view(2.01).phase)
		assertEquals(Phase.Idle, stage.view(3.0).phase)

		stage.state(Phase.Thinking, nowS = 3.5)
		stage.played(0.5, heardS = 4.0)
		assertEquals("a stated phase wins over the levels", Phase.Thinking, stage.view(4.01).phase)
	}

	@Test
	fun `listening waits until her voice has left the speaker`() {
		val stage = CallStage()
		stage.state(Phase.Speaking, nowS = 1.0)
		stage.played(0.5, heardS = 2.0)
		stage.state(Phase.Listening, nowS = 1.9)
		assertEquals("her last audio is still playing", Phase.Speaking, stage.view(2.0).phase)
		stage.played(0.5, heardS = 2.02)
		assertEquals(Phase.Speaking, stage.view(2.05).phase)
		assertEquals(Phase.Listening, stage.view(2.2).phase)
	}

	@Test
	fun `cutting her off makes listening immediate`() {
		val stage = CallStage()
		stage.state(Phase.Speaking, nowS = 1.0)
		stage.played(0.5, heardS = 2.0)
		stage.clear(nowS = 1.5)
		stage.state(Phase.Listening, nowS = 1.5)
		assertEquals(Phase.Listening, stage.view(1.5).phase)
	}

	@Test
	fun `the foreground warm-up goes out at most once a minute`() {
		val throttle = Throttle(60_000)
		assertTrue(throttle.due(1_000))
		assertFalse(throttle.due(30_000))
		assertFalse(throttle.due(60_999))
		assertTrue(throttle.due(61_000))
		assertFalse(throttle.due(61_001))
	}
}
