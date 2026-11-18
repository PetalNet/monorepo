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

		fun said(nowS: Double): Int = cut ?: if (words.isEmpty()) 1 else words.count { it.start <= nowS - startS }

		fun revealed(said: Int): String = if (words.isEmpty()) (if (said > 0) text else "") else words.take(said).joinToString(" ") { it.text }
	}

	private class Waiting(val seq: Int, val words: ServerMessage.HerWords)

	private val waiting = ArrayDeque<Waiting>()
	private var sentences = listOf<Sentence>()
	private var his: String? = null
	private var id = 0
	private var nextSeq = 0

	/** True once her turn is over, so her next sentence starts a new utterance and does not extend the old one. */
	private var turnOver = true

	/** What [caption] last built, and the word counts it was built from, so a frame with nothing new builds nothing. */
	private var built: Pair<Caption, List<String>>? = null
	private var builtFrom = -1L

	/**
	 * A sentence whose audio is queued behind this call. The number it returns names the sentence
	 * to [herAudioStarted].
	 */
	fun herSentenceQueued(words: ServerMessage.HerWords): Int {
		waiting.addLast(Waiting(nextSeq, words))
		return nextSeq++
	}

	/**
	 * The audio of sentence [seq] starts playing at [startS]. Sentences queued before it whose audio
	 * never came are dropped, so one lost sentence does not shift every later one.
	 */
	fun herAudioStarted(seq: Int, startS: Double) {
		while (waiting.isNotEmpty() && waiting.first().seq < seq) waiting.removeFirst()
		if (waiting.firstOrNull()?.seq != seq) return
		val next = waiting.removeFirst().words
		val sentence = Sentence(next.text, next.words, startS)
		if (turnOver || his != null) {
			id++
			sentences = listOf(sentence)
		} else {
			sentences = (sentences + sentence).takeLast(MAX_SENTENCES)
		}
		his = null
		turnOver = false
		built = null
	}

	fun hisWords(text: String) {
		id++
		his = text
		sentences = emptyList()
		turnOver = true
		built = null
	}

	/** Her turn ended without a cut: what she said stays up until the next utterance replaces it. */
	fun herTurnOver() {
		turnOver = true
	}

	/** She was cut off at [nowS]: words not yet said are never shown, and sentences not yet started are dropped. */
	fun clear(nowS: Double) {
		waiting.clear()
		sentences.forEach { s -> if (s.cut == null) s.cut = s.said(nowS) }
		turnOver = true
	}

	/**
	 * The utterance to show at [nowS], or null before anyone has spoken. Her sentences are listed
	 * oldest first, so a view with little room can drop the oldest. The same object comes back
	 * until another word is due.
	 */
	fun caption(nowS: Double): Pair<Caption, List<String>>? {
		if (his == null && sentences.isEmpty()) return null
		var from = 0L
		for (s in sentences) from = from * 1009 + s.said(nowS)
		built?.let { if (builtFrom == from) return it }
		val made = his?.let { Caption(id, Side.Him, it) to listOf(it) } ?: run {
			val parts = sentences.map { it.revealed(it.said(nowS)) }.filter { it.isNotEmpty() }
			Caption(id, Side.Her, parts.joinToString(" ")) to parts
		}
		built = made
		builtFrom = from
		return made
	}

	private companion object {
		/** A turn longer than this shows its last sentences only, however long a bridge keeps one turn open. */
		const val MAX_SENTENCES = 6
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
 * Every reading carries the time it is due: her audio is measured before it is heard, and the
 * meter must not move ahead of her voice. A reading stands only briefly. The bridge sends no
 * zero for her when she stops, so a side without a new reading for [REMOTE_HOLD_S] is silent.
 */
class Levels {
	/** Readings in the order they fall due. [at] gives the latest one whose time has come, while it still stands. */
	private class Readings(private val holdS: Double) {
		private val due = ArrayDeque<DoubleArray>()
		private var level = 0.0
		private var sinceS = Double.NEGATIVE_INFINITY

		fun add(level: Double, dueS: Double) {
			if (due.size == MAX_DUE) due.removeFirst()
			due.addLast(doubleArrayOf(dueS, level))
		}

		fun at(nowS: Double): Double {
			while (due.isNotEmpty() && due.first()[0] <= nowS) {
				val reading = due.removeFirst()
				sinceS = reading[0]
				level = reading[1]
			}
			return if (nowS - sinceS < holdS) level else 0.0
		}
	}

	private val remoteHer = Readings(REMOTE_HOLD_S)
	private val remoteHim = Readings(REMOTE_HOLD_S)
	private val played = Readings(LOCAL_HOLD_S)
	private val mic = Readings(LOCAL_HOLD_S)
	private var remoteAtS = Double.NEGATIVE_INFINITY

	/** A `level` event at [nowS]. Her reading describes audio that is heard at [herHeardS]. */
	fun remote(her: Double?, him: Double?, nowS: Double, herHeardS: Double = nowS) {
		her?.let { remoteHer.add(it, herHeardS) }
		him?.let { remoteHim.add(it, nowS) }
		remoteAtS = nowS
	}

	/** A piece of her audio, [level] loud, that is heard at [heardS]. */
	fun played(level: Double, heardS: Double) = played.add(level, heardS)

	fun mic(level: Double, nowS: Double) = mic.add(level, nowS)

	private fun live(nowS: Double) = nowS - remoteAtS < REMOTE_STALE_S

	fun her(nowS: Double): Double {
		// Both are read every time, so neither queue holds stale readings when the source changes.
		val remote = remoteHer.at(nowS)
		val local = played.at(nowS)
		return if (live(nowS)) remote else local
	}

	fun him(nowS: Double): Double {
		val remote = remoteHim.at(nowS)
		val local = mic.at(nowS)
		return if (live(nowS)) remote else local
	}

	companion object {
		const val REMOTE_STALE_S = 1.0

		/** The bridge sends about ten readings a second, so three missed in a row is silence. */
		const val REMOTE_HOLD_S = 0.3

		/** A local measurement stands for this long. Chunks are 20 ms, so a longer gap is silence. */
		const val LOCAL_HOLD_S = 0.15

		/** With no `state` events, a level above this is someone talking. */
		const val TALKING = 0.04

		/** Far more readings than can be waiting: half a second of 20 ms pieces is 25. */
		private const val MAX_DUE = 128
	}
}

/** What the call screen draws at one instant. The screen owns one and [CallStage.read] fills it, so a frame allocates nothing. */
class StageView {
	var phase = Phase.Idle
	var her = 0.0
	var him = 0.0
	var caption: Caption? = null
	var parts: List<String> = emptyList()
}

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
	fun herSentenceQueued(words: ServerMessage.HerWords): Int = transcript.herSentenceQueued(words)

	@Synchronized
	fun herAudioStarted(seq: Int, startS: Double) = transcript.herAudioStarted(seq, startS)

	@Synchronized
	fun hisWords(text: String) = transcript.hisWords(text)

	/** She was cut off: her audio is gone from the speaker, and so are the words she had not said. */
	@Synchronized
	fun clear(nowS: Double) {
		transcript.clear(nowS)
		heardUntilS = nowS
	}

	@Synchronized
	fun level(her: Double?, him: Double?, nowS: Double, herHeardS: Double) = levels.remote(her, him, nowS, herHeardS)

	/** A piece of her audio, [level] loud, reaches the speaker at [heardS]. */
	@Synchronized
	fun played(level: Double, heardS: Double) {
		levels.played(level, heardS)
		heardUntilS = heardS + PLAYBACK_TAIL_S
	}

	@Synchronized
	fun mic(level: Double, nowS: Double) = levels.mic(level, nowS)

	/**
	 * Fills [into] with what to draw at [nowS]. The meter gets her level only while she speaks and
	 * his only while she listens, so his microphone during her speech cannot turn the meter into his.
	 */
	@Synchronized
	fun read(nowS: Double, into: StageView) {
		waiting?.let { if (nowS >= heardUntilS) enter(it) }
		val her = levels.her(nowS)
		val him = levels.him(nowS)
		val phase = stated ?: when {
			her > Levels.TALKING -> Phase.Speaking
			him > Levels.TALKING -> Phase.Listening
			else -> Phase.Idle
		}
		val caption = transcript.caption(nowS)
		into.phase = phase
		into.her = if (phase == Phase.Speaking) her else 0.0
		into.him = if (phase == Phase.Listening) him else 0.0
		into.caption = caption?.first
		into.parts = caption?.second.orEmpty()
	}

	companion object {
		/** One 20 ms piece, and room for the playback thread to hand over the next one. */
		const val PLAYBACK_TAIL_S = 0.07

		fun nowS() = System.nanoTime() / 1e9
	}
}
