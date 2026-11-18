package dev.petalcat.janetcall

import kotlin.math.sqrt

enum class Side { Her, Him }

/** The one utterance on screen: whose it is and the text revealed so far. [id] changes with each new utterance. */
data class Caption(val id: Int, val side: Side, val text: String)

/**
 * The transcript line. Only the current utterance shows. Her sentences are revealed word by word
 * on the clock of their own audio, and a sentence waits its turn until its audio starts, so a
 * line never runs ahead of her voice. His line shows whole, at once.
 */
class Transcript {
	private class Sentence(val text: String, val words: List<TimedWord>, val startS: Double) {
		/** Set when she is cut off: only this many words were said. */
		var cut: Int? = null

		fun revealed(nowS: Double): String {
			if (words.isEmpty()) return if (cut == null) text else ""
			val said = cut ?: words.count { it.start <= nowS - startS }
			return words.take(said).joinToString(" ") { it.text }
		}
	}

	private val waiting = ArrayDeque<ServerMessage.HerWords>()
	private var sentences = listOf<Sentence>()
	private var his: String? = null
	private var id = 0

	/** True once her turn is over, so her next sentence starts a new utterance and does not extend the old one. */
	private var turnOver = true

	/** A sentence whose audio is queued behind this call. Returns nothing; [herAudioStarted] reveals it. */
	fun herSentenceQueued(words: ServerMessage.HerWords) {
		waiting.addLast(words)
	}

	/** The audio of the oldest waiting sentence starts playing at [startS]. */
	fun herAudioStarted(startS: Double) {
		val next = waiting.removeFirstOrNull() ?: return
		val sentence = Sentence(next.text, next.words, startS)
		if (turnOver || his != null) {
			id++
			sentences = listOf(sentence)
		} else {
			sentences = sentences + sentence
		}
		his = null
		turnOver = false
	}

	fun hisWords(text: String) {
		id++
		his = text
		sentences = emptyList()
		turnOver = true
	}

	/** Her turn ended without a cut: what she said stays up until the next utterance replaces it. */
	fun herTurnOver() {
		turnOver = true
	}

	/** She was cut off at [nowS]: words not yet said are never shown, and sentences not yet started are dropped. */
	fun clear(nowS: Double) {
		waiting.clear()
		sentences.forEach { s -> if (s.cut == null) s.cut = s.words.count { it.start <= nowS - s.startS } }
		turnOver = true
	}

	/**
	 * The utterance to show at [nowS], or null before anyone has spoken. Her sentences are listed
	 * oldest first, so a view with little room can drop the oldest.
	 */
	fun caption(nowS: Double): Pair<Caption, List<String>>? {
		his?.let { return Caption(id, Side.Him, it) to listOf(it) }
		if (sentences.isEmpty()) return null
		val parts = sentences.map { it.revealed(nowS) }.filter { it.isNotEmpty() }
		return Caption(id, Side.Her, parts.joinToString(" ")) to parts
	}
}

/** RMS of PCM16LE [pcm] as a level: 0 is silence, 1 is an RMS of 6000 or more. The bridge's `level` events use the same scale. */
fun pcmLevel(pcm: ByteArray, length: Int = pcm.size): Double {
	val samples = length / 2
	if (samples == 0) return 0.0
	var sum = 0.0
	for (i in 0 until samples) {
		val s = (pcm[2 * i].toInt() and 0xFF) or (pcm[2 * i + 1].toInt() shl 8)
		sum += s.toDouble() * s
	}
	return (sqrt(sum / samples) / 6000).coerceIn(0.0, 1.0)
}

/**
 * The two levels the meter shows. The bridge's `level` events win while they keep coming. When
 * none has arrived for [REMOTE_STALE_S], the levels are the ones measured on this phone from the
 * audio it played and the microphone audio it sent, so the meter always shows real sound.
 *
 * A reading stands only briefly. The bridge sends no zero for her when she stops, so a side
 * without a new reading for [REMOTE_HOLD_S] is silent.
 */
class Levels {
	private var remoteHer = 0.0
	private var remoteHerAtS = Double.NEGATIVE_INFINITY
	private var remoteHim = 0.0
	private var remoteHimAtS = Double.NEGATIVE_INFINITY
	private var remoteAtS = Double.NEGATIVE_INFINITY
	private var playedLevel = 0.0
	private var playedAtS = Double.NEGATIVE_INFINITY
	private var micLevel = 0.0
	private var micAtS = Double.NEGATIVE_INFINITY

	fun remote(her: Double?, him: Double?, nowS: Double) {
		if (her != null) {
			remoteHer = her
			remoteHerAtS = nowS
		}
		if (him != null) {
			remoteHim = him
			remoteHimAtS = nowS
		}
		remoteAtS = nowS
	}

	fun played(level: Double, nowS: Double) {
		playedLevel = level
		playedAtS = nowS
	}

	fun mic(level: Double, nowS: Double) {
		micLevel = level
		micAtS = nowS
	}

	private fun live(nowS: Double) = nowS - remoteAtS < REMOTE_STALE_S

	private fun held(level: Double, atS: Double, nowS: Double, holdS: Double) = if (nowS - atS < holdS) level else 0.0

	fun her(nowS: Double) =
		if (live(nowS)) held(remoteHer, remoteHerAtS, nowS, REMOTE_HOLD_S) else held(playedLevel, playedAtS, nowS, LOCAL_HOLD_S)

	fun him(nowS: Double) =
		if (live(nowS)) held(remoteHim, remoteHimAtS, nowS, REMOTE_HOLD_S) else held(micLevel, micAtS, nowS, LOCAL_HOLD_S)

	companion object {
		const val REMOTE_STALE_S = 1.0

		/** The bridge sends about ten readings a second, so three missed in a row is silence. */
		const val REMOTE_HOLD_S = 0.3

		/** A local measurement stands for this long. Chunks are 20 ms, so a longer gap is silence. */
		const val LOCAL_HOLD_S = 0.15

		/** With no `state` events, a level above this is someone talking. */
		const val TALKING = 0.04
	}
}

/** What the call screen draws at one instant. */
data class StageView(val phase: Phase, val her: Double, val him: Double, val caption: Caption?, val parts: List<String>)

/**
 * Everything the call screen shows about one call. The socket, playback and microphone threads
 * write it and the screen reads it, so every member takes the lock. Times are seconds on one
 * monotonic clock ([nowS]).
 */
class CallStage {
	private val transcript = Transcript()
	private val levels = Levels()
	private var stated: Phase? = null

	/**
	 * The bridge says "listening" when it has sent the last of her audio, which the phone is still
	 * playing. The phase waits here until her voice has actually stopped.
	 */
	private var waiting: Phase? = null
	private var heardUntilS = Double.NEGATIVE_INFINITY

	@Synchronized
	fun state(phase: Phase, nowS: Double) {
		if (stated == Phase.Speaking && phase == Phase.Listening && nowS < heardUntilS) {
			waiting = phase
		} else {
			enter(phase)
		}
	}

	private fun enter(phase: Phase) {
		if (stated == Phase.Speaking && phase != Phase.Speaking) transcript.herTurnOver()
		stated = phase
		waiting = null
	}

	@Synchronized
	fun herSentenceQueued(words: ServerMessage.HerWords) = transcript.herSentenceQueued(words)

	@Synchronized
	fun herAudioStarted(startS: Double) = transcript.herAudioStarted(startS)

	@Synchronized
	fun hisWords(text: String) = transcript.hisWords(text)

	/** She was cut off: her audio is gone from the speaker, and so are the words she had not said. */
	@Synchronized
	fun clear(nowS: Double) {
		transcript.clear(nowS)
		heardUntilS = nowS
	}

	@Synchronized
	fun level(her: Double?, him: Double?, nowS: Double) = levels.remote(her, him, nowS)

	/** A piece of her audio, [level] loud, reaches the speaker at [heardS]. */
	@Synchronized
	fun played(level: Double, heardS: Double) {
		levels.played(level, heardS)
		heardUntilS = heardS + PLAYBACK_TAIL_S
	}

	@Synchronized
	fun mic(level: Double, nowS: Double) = levels.mic(level, nowS)

	@Synchronized
	fun view(nowS: Double): StageView {
		waiting?.let { if (nowS >= heardUntilS) enter(it) }
		val her = levels.her(nowS)
		val him = levels.him(nowS)
		val phase = stated ?: when {
			her > Levels.TALKING -> Phase.Speaking
			him > Levels.TALKING -> Phase.Listening
			else -> Phase.Idle
		}
		val caption = transcript.caption(nowS)
		return StageView(phase, her, him, caption?.first, caption?.second.orEmpty())
	}

	companion object {
		/** One 20 ms piece, and room for the playback thread to hand over the next one. */
		const val PLAYBACK_TAIL_S = 0.07

		fun nowS() = System.nanoTime() / 1e9
	}
}
