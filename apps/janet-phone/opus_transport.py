"""Mono PCM16LE / 20 ms Opus transport. Requires the system libopus shared library.

Instances belong to one stream and must be used serially. Decoding returns the
sender's sample position without filling gaps or concealing missing packets.
"""

import ctypes as C
import ctypes.util
import struct
import sys

MAGIC = b"JOP1"
HEADER = struct.Struct(">4sQ")
MAX_PACKET = 1275
RATES = (8000, 12000, 16000, 24000, 48000)


def _library():
    lib = C.CDLL(ctypes.util.find_library("opus") or "libopus.so.0")
    for name in ("encoder", "decoder"):
        create = getattr(lib, f"opus_{name}_create")
        create.argtypes = [C.c_int32, C.c_int] + ([C.c_int] if name == "encoder" else []) + [C.POINTER(C.c_int)]
        create.restype = C.c_void_p
        destroy = getattr(lib, f"opus_{name}_destroy")
        destroy.argtypes = [C.c_void_p]
        destroy.restype = None
    lib.opus_encode.argtypes = [C.c_void_p, C.POINTER(C.c_int16), C.c_int, C.c_void_p, C.c_int32]
    lib.opus_decode.argtypes = [C.c_void_p, C.c_void_p, C.c_int32, C.POINTER(C.c_int16), C.c_int, C.c_int]
    lib.opus_packet_get_nb_samples.argtypes = [C.c_void_p, C.c_int32, C.c_int32]
    # ctl is variadic; only the fixed arguments have argtypes.
    lib.opus_encoder_ctl.argtypes = [C.c_void_p, C.c_int]
    return lib


class Encoder:
    """Carry partial frames between calls; timestamps count input samples."""

    def __init__(self, rate):
        if rate not in RATES:
            raise ValueError("unsupported Opus rate")
        self.rate = rate
        self.frame_samples = rate // 50
        self._pending = bytearray()
        self._timestamp = 0
        self._lib = _library()
        error = C.c_int()
        self._state = self._lib.opus_encoder_create(rate, 1, 2048, C.byref(error))  # OPUS_APPLICATION_VOIP
        if error.value or not self._state:
            raise ValueError(f"Opus encoder: {error.value}")
        if self._lib.opus_encoder_ctl(self._state, 4002, C.c_int(20000)) < 0:  # OPUS_SET_BITRATE
            self.close()
            raise ValueError("Opus bitrate rejected")

    def encode(self, pcm):
        if not self._state:
            raise ValueError("encoder is closed")
        self._pending.extend(pcm)
        packets = []
        size = self.frame_samples * 2
        while len(self._pending) >= size:
            frame = bytes(self._pending[:size])
            del self._pending[:size]
            samples = (C.c_int16 * self.frame_samples)(*struct.unpack(f"<{self.frame_samples}h", frame))
            output = C.create_string_buffer(MAX_PACKET)
            n = self._lib.opus_encode(self._state, samples, self.frame_samples, output, MAX_PACKET)
            if n < 0:
                raise ValueError(f"Opus encode: {n}")
            packets.append(HEADER.pack(MAGIC, self._timestamp) + output.raw[:n])
            self._timestamp += self.frame_samples
        return packets

    def close(self):
        if self._state:
            self._lib.opus_encoder_destroy(self._state)
            self._state = None
        self._pending.clear()


class Decoder:
    """Decode exactly one framed packet, preserving its sample timestamp."""

    def __init__(self, rate):
        if rate not in RATES:
            raise ValueError("unsupported Opus rate")
        self.rate = rate
        self._lib = _library()
        error = C.c_int()
        self._state = self._lib.opus_decoder_create(rate, 1, C.byref(error))
        if error.value or not self._state:
            raise ValueError(f"Opus decoder: {error.value}")

    def decode(self, packet):
        if not self._state:
            raise ValueError("decoder is closed")
        if not HEADER.size < len(packet) <= HEADER.size + MAX_PACKET:
            raise ValueError("invalid Opus packet size")
        magic, timestamp = HEADER.unpack_from(packet)
        if magic != MAGIC:
            raise ValueError("invalid Opus magic")
        payload = bytes(packet[HEADER.size:])
        size = self.rate // 50
        if self._lib.opus_packet_get_nb_samples(payload, len(payload), self.rate) != size:
            raise ValueError("Opus packet must contain 20 ms")
        samples = (C.c_int16 * size)()
        n = self._lib.opus_decode(self._state, payload, len(payload), samples, size, 0)
        if n != size:
            raise ValueError(f"Opus decode: {n}")
        pcm = bytes(samples)
        if sys.byteorder != "little":
            pcm = struct.pack(f"<{n}h", *samples)
        return timestamp, pcm

    def close(self):
        if self._state:
            self._lib.opus_decoder_destroy(self._state)
            self._state = None
