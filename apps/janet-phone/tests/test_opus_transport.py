import math
import struct
import unittest

from opus_transport import Decoder, Encoder, HEADER, MAGIC, MAX_PACKET, RATES


class OpusTransportTest(unittest.TestCase):
    def test_stream_round_trip_at_every_native_rate(self):
        for rate in RATES:
            with self.subTest(rate=rate):
                encoder, decoder = Encoder(rate), Decoder(rate)
                self.addCleanup(encoder.close)
                self.addCleanup(decoder.close)
                pcm = b"".join(struct.pack("<h", int(6000 * math.sin(2 * math.pi * 220 * i / rate)))
                               for i in range(rate // 5))
                # Deliberately split in the middle of a sample and of a frame.
                packets = encoder.encode(pcm[:13]) + encoder.encode(pcm[13:777]) + encoder.encode(pcm[777:])
                self.assertEqual(10, len(packets))
                decoded = []
                for index, packet in enumerate(packets):
                    timestamp, frame = decoder.decode(packet)
                    self.assertEqual(index * rate // 50, timestamp)
                    self.assertEqual(rate // 50 * 2, len(frame))
                    self.assertLessEqual(len(packet), HEADER.size + MAX_PACKET)
                    decoded.extend(struct.unpack(f"<{len(frame) // 2}h", frame))
                self.assertGreater(sum(abs(v) for v in decoded) / len(decoded), 1000)

    def test_remainder_is_carried_until_a_full_frame_arrives(self):
        encoder = Encoder(16000)
        self.addCleanup(encoder.close)
        self.assertEqual([], encoder.encode(bytes(639)))
        self.assertEqual(1, len(encoder.encode(bytes(1))))
        self.assertEqual([], encoder.encode(b""))
        packet, = encoder.encode(bytes(640))
        self.assertEqual((MAGIC, 320), HEADER.unpack_from(packet))

    def test_network_gap_returns_only_received_pcm_and_original_position(self):
        encoder, decoder = Encoder(16000), Decoder(16000)
        self.addCleanup(encoder.close)
        self.addCleanup(decoder.close)
        packets = encoder.encode(bytes(640 * 20))
        timestamp, pcm = decoder.decode(packets[0])
        self.assertEqual(0, timestamp)
        self.assertEqual(640, len(pcm))
        timestamp, pcm = decoder.decode(packets[-1])
        self.assertEqual(6080, timestamp)
        self.assertEqual(640, len(pcm))

    def test_invalid_frames_are_value_errors(self):
        decoder = Decoder(16000)
        self.addCleanup(decoder.close)
        for packet in (b"", MAGIC, HEADER.pack(MAGIC, 0), HEADER.pack(b"BAD!", 0) + b"x",
                       HEADER.pack(MAGIC, 0) + bytes(MAX_PACKET + 1), HEADER.pack(MAGIC, 0) + b"\xff"):
            with self.subTest(size=len(packet)), self.assertRaises(ValueError):
                decoder.decode(packet)

    def test_other_opus_durations_are_rejected(self):
        # TOC 0x80 is a single 2.5 ms CELT frame, not this protocol's 20 ms.
        decoder = Decoder(16000)
        self.addCleanup(decoder.close)
        with self.assertRaises(ValueError):
            decoder.decode(HEADER.pack(MAGIC, 0) + b"\x80\x00")

    def test_close_is_idempotent_and_closed_instances_reject_use(self):
        encoder, decoder = Encoder(16000), Decoder(16000)
        packet, = encoder.encode(bytes(640))
        for codec in (encoder, decoder):
            codec.close()
            codec.close()
        with self.assertRaises(ValueError):
            encoder.encode(bytes(640))
        with self.assertRaises(ValueError):
            decoder.decode(packet)

    def test_unsupported_rates_are_value_errors(self):
        for factory in (Encoder, Decoder):
            for rate in (0, 44100, -16000):
                with self.assertRaises(ValueError):
                    factory(rate)


if __name__ == "__main__":
    unittest.main()
