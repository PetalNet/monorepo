package dev.petalcat.janetcall

import android.media.MediaCodec
import android.media.MediaFormat
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.ArrayDeque

/** JOP1 + unsigned big-endian sample position + one mono 20 ms Opus packet. */
object OpusWire {
	const val MAX_PACKET = 1275
	val rates = setOf(8_000, 12_000, 16_000, 24_000, 48_000)

	fun pack(timestamp: Long, payload: ByteArray): ByteArray {
		require(timestamp >= 0 && payload.size in 1..MAX_PACKET)
		return ByteBuffer.allocate(12 + payload.size).putInt(0x4a4f5031).putLong(timestamp).put(payload).array()
	}

	fun unpack(packet: ByteArray): Pair<Long, ByteArray> {
		require(packet.size in 13..(12 + MAX_PACKET)) { "Invalid Opus packet size" }
		val buffer = ByteBuffer.wrap(packet)
		require(buffer.int == 0x4a4f5031) { "Invalid Opus magic" }
		val timestamp = buffer.long
		require(timestamp >= 0) { "Invalid Opus timestamp" }
		return timestamp to packet.copyOfRange(12, packet.size)
	}
}

/** Platform codecs are confined to their owning audio thread. */
class OpusEncoder : AutoCloseable {
	private val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS)
	private val timestamps = ArrayDeque<Long>()
	private var closed = false

	init {
		try {
			val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, MIC_RATE, 1)
			format.setInteger(MediaFormat.KEY_BIT_RATE, 20_000)
			codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
			codec.start()
		} catch (e: Exception) {
			codec.release()
			throw e
		}
	}

	fun encode(pcm: ByteArray, timestamp: Long): List<ByteArray> {
		require(pcm.size == MIC_CHUNK_BYTES)
		val packets = mutableListOf<ByteArray>()
		drain(packets)
		val index = codec.dequeueInputBuffer(20_000)
		check(index >= 0) { "Opus encoder input stalled" }
		codec.getInputBuffer(index)!!.put(pcm)
		timestamps.addLast(timestamp)
		codec.queueInputBuffer(index, 0, pcm.size, timestamp * 1_000_000 / MIC_RATE, 0)
		drain(packets)
		return packets
	}

	private fun drain(packets: MutableList<ByteArray>) {
		val info = MediaCodec.BufferInfo()
		while (true) {
			val index = codec.dequeueOutputBuffer(info, 0)
			if (index == MediaCodec.INFO_TRY_AGAIN_LATER) return
			if (index < 0) continue
			try {
				if (info.size > 0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
					val buffer = codec.getOutputBuffer(index)!!
					buffer.position(info.offset)
					val payload = ByteArray(info.size)
					buffer.get(payload)
					packets.add(OpusWire.pack(timestamps.removeFirst(), payload))
				}
			} finally {
				codec.releaseOutputBuffer(index, false)
			}
		}
	}

	override fun close() {
		if (closed) return
		closed = true
		codec.release()
	}
}

class OpusDecoder(private val rate: Int) : AutoCloseable {
	private val codec = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS)
	private var closed = false

	init {
		try {
			require(rate in OpusWire.rates)
			val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, rate, 1)
			val head = ByteBuffer.allocate(19).order(ByteOrder.LITTLE_ENDIAN)
				.put("OpusHead".toByteArray()).put(1).put(1).putShort(0).putInt(rate).putShort(0).put(0)
			format.setByteBuffer("csd-0", ByteBuffer.wrap(head.array()))
			format.setByteBuffer("csd-1", ByteBuffer.allocate(8).order(ByteOrder.nativeOrder()).putLong(0).apply { flip() })
			format.setByteBuffer("csd-2", ByteBuffer.allocate(8).order(ByteOrder.nativeOrder()).putLong(80_000_000).apply { flip() })
			codec.configure(format, null, null, 0)
			codec.start()
		} catch (e: Exception) {
			codec.release()
			throw e
		}
	}

	fun decode(packet: ByteArray, output: (Int, ByteArray) -> Unit) {
		val (timestamp, payload) = OpusWire.unpack(packet)
		drain(output)
		val index = codec.dequeueInputBuffer(20_000)
		check(index >= 0) { "Opus decoder input stalled" }
		codec.getInputBuffer(index)!!.put(payload)
		codec.queueInputBuffer(index, 0, payload.size, timestamp * 1_000_000 / rate, 0)
		drain(output, 20_000)
	}

	private fun drain(output: (Int, ByteArray) -> Unit, timeoutUs: Long = 0) {
		val info = MediaCodec.BufferInfo()
		var wait = timeoutUs
		while (true) {
			val index = codec.dequeueOutputBuffer(info, wait)
			wait = 0
			if (index == MediaCodec.INFO_TRY_AGAIN_LATER) return
			if (index < 0) continue
			try {
				if (info.size > 0) {
					val buffer = codec.getOutputBuffer(index)!!
					buffer.position(info.offset)
					val pcm = ByteArray(info.size)
					buffer.get(pcm)
					output(codec.outputFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE), pcm)
				}
			} finally {
				codec.releaseOutputBuffer(index, false)
			}
		}
	}

	override fun close() {
		if (closed) return
		closed = true
		codec.release()
	}
}
