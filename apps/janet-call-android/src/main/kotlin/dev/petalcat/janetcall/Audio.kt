package dev.petalcat.janetcall

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.os.Process
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicLong

const val MIC_RATE = 16_000

/** 20 ms of 16 kHz mono PCM16, the chunk size sent to the bridge. */
const val MIC_CHUNK_BYTES = MIC_RATE / 50 * 2

/** The most microphone audio that may wait in the socket's own send queue: half a second, 25 frames. */
const val MIC_BACKLOG_BYTES = MIC_CHUNK_BYTES * 25L

/**
 * Decides whether each microphone frame joins the socket's send queue. When the uplink is slower
 * than speech that queue would grow without end: Janet would hear the caller ever later, and after
 * a hang-up the phone would go on sending what was said before it.
 *
 * So once half a second is waiting, frames are dropped until the queue has drained, and then sending
 * resumes. Dropping a whole run and resuming leaves the bridge clean stretches of speech with a gap;
 * dropping one frame each time one fits would hand it every few frames run together, which neither
 * its end-of-speech detector nor speech to text can use. The bound covers this queue only, not what
 * the TLS layer and the kernel already hold.
 */
class MicBacklog {
	private var dropping = false

	/** Frames dropped so far. */
	var dropped = 0L
		private set

	fun admits(queuedBytes: Long): Boolean {
		if (queuedBytes >= MIC_BACKLOG_BYTES) dropping = true
		else if (queuedBytes <= MIC_CHUNK_BYTES) dropping = false
		if (dropping) dropped++
		return !dropping
	}
}

/**
 * [mic], silent while [muted] says so. The frames keep coming at their own pace, so the bridge
 * hears a pause and the call's timing does not change.
 */
class MutableMic(private val mic: Mic, private val muted: () -> Boolean) : Mic by mic {
	override fun read(buf: ByteArray): Int {
		val n = mic.read(buf)
		if (n > 0 && muted()) buf.fill(0, 0, n)
		return n
	}
}

interface Mic {
	/** Blocks until [buf] is full, or returns <= 0 once the mic is stopped. */
	fun read(buf: ByteArray): Int

	/** Makes [read] return; safe from any thread. */
	fun stop()

	/** Frees the mic. Call it from the thread that reads, after [read] has returned. */
	fun close()
}

class AudioRecordMic : Mic {
	private val record: AudioRecord

	init {
		val minBuf = AudioRecord.getMinBufferSize(MIC_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
		record = AudioRecord(
			MediaRecorder.AudioSource.VOICE_COMMUNICATION,
			MIC_RATE,
			AudioFormat.CHANNEL_IN_MONO,
			AudioFormat.ENCODING_PCM_16BIT,
			maxOf(minBuf, MIC_CHUNK_BYTES * 8),
		)
		check(record.state == AudioRecord.STATE_INITIALIZED) { "Microphone unavailable" }
		record.startRecording()
	}

	override fun read(buf: ByteArray): Int = record.read(buf, 0, buf.size, AudioRecord.READ_BLOCKING)

	override fun stop() = record.stop()

	override fun close() = record.release()
}

/** Debug mic: a 16 kHz mono PCM16 WAV paced in real time, then silence. */
class WavMic(file: File) : Mic {
	private val pcm = Wav.readPcm16Mono(file, MIC_RATE)
	private val startNs = System.nanoTime()
	private var offset = 0
	private var sent = 0L

	@Volatile private var closed = false

	override fun read(buf: ByteArray): Int {
		val dueNs = startNs + sent * 1_000_000_000L / (MIC_RATE * 2)
		while (!closed && System.nanoTime() < dueNs) Thread.sleep(2)
		if (closed) return -1
		buf.fill(0)
		val n = minOf(buf.size, pcm.size - offset).coerceAtLeast(0)
		System.arraycopy(pcm, offset, buf, 0, n)
		offset += n
		sent += buf.size
		return buf.size
	}

	override fun stop() {
		closed = true
	}

	override fun close() = Unit
}

object Wav {
	fun readPcm16Mono(file: File, rate: Int): ByteArray {
		val bytes = file.readBytes()
		val buf = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
		require(bytes.size > 12 && String(bytes, 0, 4) == "RIFF" && String(bytes, 8, 4) == "WAVE") { "Not a WAV file" }
		var pos = 12
		var fmtOk = false
		while (pos + 8 <= bytes.size) {
			val id = String(bytes, pos, 4)
			val size = buf.getInt(pos + 4)
			if (id == "fmt ") {
				fmtOk = buf.getShort(pos + 8).toInt() == 1 && buf.getShort(pos + 10).toInt() == 1 &&
					buf.getInt(pos + 12) == rate && buf.getShort(pos + 22).toInt() == 16
			} else if (id == "data") {
				require(fmtOk) { "WAV must be PCM16 mono $rate Hz" }
				val end = minOf(bytes.size.toLong(), pos + 8L + size.toUInt().toLong()).toInt()
				return bytes.copyOfRange(pos + 8, end)
			}
			pos += 8 + size + (size and 1)
		}
		error("WAV has no data chunk")
	}
}

/** Writes PCM16 mono to a WAV file; the header sizes are patched on [close]. */
class WavWriter(file: File, private val rate: Int) {
	private val out = RandomAccessFile(file, "rw").apply {
		setLength(0)
		write(ByteArray(44))
	}
	private var dataBytes = 0

	@Synchronized
	fun write(pcm: ByteArray) {
		out.write(pcm)
		dataBytes += pcm.size
	}

	@Synchronized
	fun close() {
		val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
			.put("RIFF".toByteArray()).putInt(36 + dataBytes).put("WAVE".toByteArray())
			.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(1).putInt(rate).putInt(rate * 2)
			.putShort(2).putShort(16).put("data".toByteArray()).putInt(dataBytes)
		out.seek(0)
		out.write(header.array())
		out.close()
	}
}

/**
 * Plays the bridge's reply audio. A "clear" drops everything queued and flushes the AudioTrack;
 * audio is cut into 20 ms pieces so at most one stale piece is still in flight.
 *
 * It also tells [stage] what it is playing: the level of each piece, and the moment the audio
 * after a [markSentence] will reach the speaker, which is the clock her words are revealed on.
 */
class Player(private val stage: CallStage, private val recorder: (Int) -> WavWriter? = { null }) {
	private sealed interface Item {
		class Pcm(val generation: Int, val bytes: ByteArray) : Item

		class Sentence(val generation: Int, val seq: Int) : Item

		class Rate(val hz: Int) : Item

		data object Stop : Item
	}

	private val queue = LinkedBlockingQueue<Item>()

	@Volatile private var generation = 0

	@Volatile private var draining = false

	private val trackLock = Any()

	@Volatile private var track: AudioTrack? = null
	@Volatile private var rate = MIC_RATE
	private var recording: WavWriter? = null

	/** Frames written to the current track since it was built or flushed, to tell how far playback lags the queue. */
	private val written = AtomicLong()
	private val thread = Thread(::loop, "janet-playback").apply { start() }

	fun setRate(hz: Int) = queue.put(Item.Rate(hz))

	fun enqueue(pcm: ByteArray) {
		val piece = rate.coerceAtLeast(8_000) / 50 * 2
		val gen = generation
		var i = 0
		while (i < pcm.size) {
			val end = minOf(pcm.size, i + piece)
			queue.put(Item.Pcm(gen, pcm.copyOfRange(i, end)))
			i = end
		}
	}

	/** The audio enqueued after this call is the start of sentence [seq], whose words the stage is holding. */
	fun markSentence(seq: Int) = queue.put(Item.Sentence(generation, seq))

	fun clear() {
		generation++
		queue.removeIf { it is Item.Pcm || it is Item.Sentence }
		withTrack {
			pause()
			flush()
			written.set(0)
			play()
		}
	}

	/** With [drain], audio already queued still plays out before the track is released. */
	fun close(drain: Boolean) {
		if (drain) {
			draining = true
		} else {
			generation++
			queue.clear()
			withTrack {
				pause()
				flush()
			}
		}
		queue.put(Item.Stop)
	}

	/** The playback thread releases the track; callers on other threads go through here so they never touch a released one. */
	private fun withTrack(block: AudioTrack.() -> Unit) = synchronized(trackLock) {
		try {
			track?.block()
		} catch (_: IllegalStateException) {
		}
	}

	private fun replaceTrack(next: AudioTrack?) = synchronized(trackLock) {
		track?.release()
		track = next
		written.set(0)
	}

	/** Seconds until a frame written now is heard: what is written and not yet played. */
	fun lagS(): Double = synchronized(trackLock) {
		val head = try {
			track?.playbackHeadPosition?.toLong()?.and(0xFFFFFFFFL)
		} catch (_: IllegalStateException) {
			null
		} ?: return 0.0
		((written.get() - head).toDouble() / rate).coerceIn(0.0, MAX_LAG_S)
	}

	private fun loop() {
		// Audio keeps its place ahead of drawing the call screen.
		Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
		var sentenceDue: Item.Sentence? = null
		try {
			while (true) {
				when (val item = queue.take()) {
					Item.Stop -> {
						if (draining) Thread.sleep(DRAIN_MS)
						break
					}
					is Item.Rate -> {
						if (item.hz == rate && track != null) continue
						rate = item.hz
						replaceTrack(buildTrack(item.hz))
					}
					// A later marker replaces one whose audio never came.
					is Item.Sentence -> sentenceDue = item
					is Item.Pcm -> {
						if (item.generation != generation) continue
						if (track == null) replaceTrack(buildTrack(rate))
						if (recording == null) recording = recorder(rate)
						recording?.write(item.bytes)
						val heardS = CallStage.nowS() + lagS()
						sentenceDue?.let { if (it.generation == item.generation) stage.herAudioStarted(it.seq, heardS) }
						sentenceDue = null
						stage.played(pcmLevel(item.bytes), heardS)
						track?.write(item.bytes, 0, item.bytes.size)
						written.addAndGet(item.bytes.size / 2L)
					}
				}
			}
		} finally {
			replaceTrack(null)
			recording?.close()
		}
	}

	private fun buildTrack(hz: Int): AudioTrack {
		val minBuf = AudioTrack.getMinBufferSize(hz, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
		return AudioTrack.Builder()
			.setAudioAttributes(
				AudioAttributes.Builder()
					.setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
					.setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
					.build(),
			)
			.setAudioFormat(
				AudioFormat.Builder()
					.setEncoding(AudioFormat.ENCODING_PCM_16BIT)
					.setSampleRate(hz)
					.setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
					.build(),
			)
			.setTransferMode(AudioTrack.MODE_STREAM)
			.setBufferSizeInBytes(maxOf(minBuf, hz / 5 * 2))
			.build()
			.also { it.play() }
	}

	private companion object {
		/** A little over the 200 ms AudioTrack buffer, so the last words finish. */
		const val DRAIN_MS = 300L

		/** The AudioTrack buffer is 200 ms; anything past this is a counter out of step, not real lag. */
		const val MAX_LAG_S = 0.5
	}
}
