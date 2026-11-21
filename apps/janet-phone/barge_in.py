"""Audio evidence required to take the turn back after a reply's first sentence."""

import logging
import math
from collections import deque
from pathlib import Path

log = logging.getLogger("janet-phone")


class BargeIn:
    """Requires 480 ms of foreground speech; rejects recent playback correlated with the mic."""

    def __init__(self, vad=None):
        import numpy as np

        self.np = np
        self.vad = vad
        self.pending = b""
        self.reference = np.zeros(0, np.float32)
        self.playback_at = float("-inf")
        self.noise = 50.0
        self.evidence = deque(maxlen=25)
        self.speech_ms = 0
        self.last_frame_at = None
        self.status = {}
        self.caller_audio = b""

    def played(self, pcm: bytes, rate: int, now: float) -> None:
        np = self.np
        samples = np.frombuffer(pcm, "<i2").astype(np.float32)
        if rate != 16000:
            samples = np.interp(np.arange(0, len(samples), rate / 16000), np.arange(len(samples)), samples).astype(np.float32)
        if now - self.playback_at > 1:
            self.reference = np.zeros(0, np.float32)
        self.reference = np.concatenate((self.reference, samples))[-24000:]
        self.playback_at = now

    def gap(self) -> None:
        self.pending = b""
        self.evidence.clear()
        self.last_frame_at = None

    def feed(self, pcm: bytes, *, protected: bool, now: float) -> bool:
        np = self.np
        self.pending += pcm
        frames = len(self.pending) // 1024
        elapsed_ms = (now - self.last_frame_at) * 1000 if self.last_frame_at is not None else 0
        if elapsed_ms > 250:
            self.evidence.clear()
        credit_ms = min(32.0, max(0, elapsed_ms) / max(1, frames))
        if frames:
            self.last_frame_at = now
        filtered = bytearray()
        accepted = False
        while len(self.pending) >= 1024:
            raw, self.pending = self.pending[:1024], self.pending[1024:]
            frame = np.frombuffer(raw, "<i2").astype(np.float32)
            rms = float(np.sqrt(np.mean(frame * frame)))
            probability = self.vad(frame / 32768) if self.vad is not None else 0.0
            if probability < .3:
                self.noise = .98 * self.noise + .02 * rms
            threshold = max(300.0, self.noise * 3)
            correlation, echo = 0.0, 0.0
            reference = self.reference if now - self.playback_at <= 1 else ()
            if len(reference) >= len(frame) and rms > 0:
                # Search recent sent audio, including the device's playout queue and acoustic delay.
                dots = np.correlate(reference, frame, mode="valid")
                power = np.concatenate(([0.0], np.cumsum(reference.astype(np.float64) ** 2)))
                energy = power[len(frame):] - power[:-len(frame)]
                correlations = np.abs(dots) / np.sqrt(np.maximum(energy * float(frame @ frame), 1))
                best = int(np.argmax(correlations))
                correlation = min(1.0, float(correlations[best]))
                echo = rms * correlation
            residual = rms * math.sqrt(max(0, 1 - correlation ** 2))
            foreground = probability >= .7 and residual >= threshold and residual > echo
            echo_dominated = correlation >= .8
            if echo_dominated:
                gain = float(dots[best]) / max(float(energy[best]), 1)
                remaining = frame - gain * reference[best:best + len(frame)]
                filtered.extend(np.clip(np.rint(remaining), -32768, 32767).astype("<i2").tobytes())
            else:
                filtered.extend(raw)
            if protected:
                self.evidence.clear()
            else:
                self.evidence.append((foreground, credit_ms if foreground else 0))
            self.speech_ms = sum(speech for speech, _ in self.evidence) * 32
            receive_ms = sum(credit for _, credit in self.evidence)
            accepted |= foreground and self.speech_ms >= 480 and receive_ms >= 400
            self.status = {"vad": round(probability, 3), "rms": round(rms), "noise_rms": round(self.noise),
                           "echo_rms": round(echo), "correlation": round(correlation, 3),
                           "speech_ms": self.speech_ms, "receive_ms": round(receive_ms),
                           "echo_dominated": echo_dominated, "first_sentence_protected": protected,
                           "accepted": accepted}
        self.caller_audio = bytes(filtered)
        return accepted


def make_barge_in(config):
    """Use audio VAD for interruptions even when the endpoint detector uses the turn judge."""
    model = Path(config.vad_model) if config.vad_model else Path(config.turn_models) / "silero_vad.onnx"
    if (config.vad_model or config.turn_models) and model.exists():
        try:
            from janet_turn.turn_end import Silero

            return BargeIn(Silero(model))
        except Exception as error:  # noqa: BLE001 - keep replies audible if the speech model cannot load
            log.warning("barge-in VAD unavailable, interruptions disabled: %s", error)
    return BargeIn()
