"""Wyoming TTS server for a Chatterbox Turbo voice runtime, with a loopback HTTP side.

Every host-specific value (binds, runtime path, GPU index, instance name, log path)
comes from the TOML file given with --config, so the same file runs on any GPU host.
"""

import argparse
import asyncio
import gc
import io
import json
import logging
import os
import re
import subprocess
import sys
import threading
import time
import tomllib
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import contextmanager
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import soundfile as sf
from audiotsm import wsola
from audiotsm.io.array import ArrayReader, ArrayWriter
from scipy.signal import resample_poly
from wyoming.audio import AudioChunk, AudioStart, AudioStop
from wyoming.error import Error
from wyoming.event import Event
from wyoming.info import Attribution, Describe, Info, TtsProgram, TtsVoice
from wyoming.server import AsyncEventHandler, AsyncServer
from wyoming.tts import Synthesize

MODEL_RATE, OUT_RATE = 44100, 24000
GROUP_CHARS = 250
log = logging.getLogger("chatterbox-wyoming")


def sentence_groups(text: str) -> list[str]:
    """The first sentence alone (fast first audio), then sentences packed up to GROUP_CHARS."""
    sentences = [s for s in re.split(r"(?<=[.!?])\s+", text.strip()) if s]
    groups: list[str] = []
    for sentence in sentences:
        if len(groups) > 1 and len(groups[-1]) + len(sentence) < GROUP_CHARS:
            groups[-1] += " " + sentence
        else:
            groups.append(sentence)
    return groups


def to_pcm16(audio: np.ndarray) -> bytes:
    # resample_poly applies a Kaiser-windowed FIR low-pass at the 12 kHz output Nyquist.
    resampled = resample_poly(audio.astype(np.float64), OUT_RATE // 300, MODEL_RATE // 300)
    return (np.clip(resampled, -1.0, 1.0) * 32767).astype("<i2").tobytes()


def louder(audio: np.ndarray, gain: float, knee: float = 0.8) -> np.ndarray:
    """Scale by gain, then bend only the samples above the knee smoothly toward full scale instead of clipping them."""
    scaled = audio * gain
    over = np.abs(scaled) - knee
    bent = np.sign(scaled) * (knee + (1 - knee) * np.tanh(over / (1 - knee)))
    return np.where(over > 0, bent, scaled)


def time_stretch(audio: np.ndarray, tempo: float) -> np.ndarray:
    """Change speech duration with WSOLA while retaining its pitch."""
    if tempo == 1.0 or len(audio) == 0:
        return audio
    # audiotsm flushes complete frames only. Supply silence so it also processes the final phoneme.
    padded = np.pad(audio, (0, 4096)).astype(np.float32, copy=False)
    writer = ArrayWriter(channels=1)
    # A 128-sample alignment search (2.9 ms at 44.1 kHz) keeps per-group CPU latency small.
    wsola(channels=1, speed=tempo, tolerance=128).run(ArrayReader(padded[np.newaxis, :]), writer)
    out = writer.data[0]
    # Frame alignment can move the final sound past the nominal duration. Trim only
    # appended silence there, otherwise a sentence ending in a short consonant is cut off.
    nonzero = np.flatnonzero(out)
    end = max(round(len(audio) / tempo), int(nonzero[-1]) + 1 if len(nonzero) else 0)
    return out[:end]


def gpu_stats(index: int) -> dict:
    """Read the GPU from nvidia-smi so status checks never create a CUDA context in this process."""
    try:
        out = subprocess.run(
            [
                "nvidia-smi",
                "-i",
                str(index),
                "--query-gpu=name,memory.free,memory.total",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=5,
            check=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout.strip()
        name, free, total = (part.strip() for part in out.split(","))
        return {
            "gpu_name": name,
            "free_vram_gb": round(int(free) / 1024, 2),
            "total_vram_gb": round(int(total) / 1024, 2),
        }
    except (OSError, subprocess.SubprocessError, ValueError) as e:
        return {"gpu_name": None, "free_vram_gb": None, "total_vram_gb": None, "gpu_error": repr(e)}


class SynthesisError(RuntimeError):
    """A failed synthesis, carrying the runtime's error as text rather than its traceback."""


class Voice:
    """Owns the model. All model work runs on one worker thread, which serializes requests."""

    def __init__(self, runtime: str, gpu_index: int, idle_unload: float, gain: float = 1.0, tempo: float = 1.0):
        if not 0.5 <= tempo <= 2.0:
            raise ValueError("tempo must be finite and between 0.5 and 2.0")
        self.tempo = tempo
        self.runtime, self.gpu_index, self.idle_unload, self.gain = runtime, gpu_index, idle_unload, gain
        self.model = None
        self.last_used = 0.0
        self.last_rtf: float | None = None
        self.pending = 0
        self.active_requests = 0
        self.busy = False
        self.counter_lock = threading.Lock()
        self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="gpu")

    @contextmanager
    def request(self):
        with self.counter_lock:
            self.active_requests += 1
        try:
            yield
        finally:
            with self.counter_lock:
                self.active_requests -= 1
                self.last_used = time.monotonic()

    def speak(self, text: str) -> Future:
        with self.counter_lock:
            self.pending += 1
            future = self.worker.submit(self._speak, text)
        future.add_done_callback(self._release_cancelled_group)
        return future

    def _release_cancelled_group(self, future: Future) -> None:
        if future.cancelled():
            with self.counter_lock:
                self.pending -= 1

    def unload(self) -> Future | None:
        with self.counter_lock:
            if self.pending or self.active_requests:
                return None
            return self.worker.submit(self._unload_requested)

    def _unload_requested(self) -> bool:
        if self.model is None:
            return False
        self._unload("on request")
        return True

    def _speak(self, text: str) -> np.ndarray:
        self.busy = True
        try:
            try:
                audio = self._synthesize(text)
                start = time.perf_counter()
                audio = time_stretch(audio, self.tempo)
                log.info("tempo %.3f: %.1f ms", self.tempo, (time.perf_counter() - start) * 1000)
                return louder(audio, self.gain)
            except Exception as e:
                log.exception("synthesis failed")
                failure = repr(e)
            # The runtime's traceback holds its frames, and through them the model and its tensors. Unload only once
            # the except clause has dropped it, and give the future an error that does not carry it.
            self._unload("after error")
            raise SynthesisError(failure)
        finally:
            self.last_used = time.monotonic()
            self.busy = False
            with self.counter_lock:
                self.pending -= 1

    def _synthesize(self, text: str) -> np.ndarray:
        import torch

        if self.model is None:
            free = gpu_stats(self.gpu_index)["free_vram_gb"]
            start = time.perf_counter()
            sys.path.insert(0, self.runtime)
            from optimized_voice import OptimizedTurboVoice

            deadline = time.monotonic() + 5.0
            while True:
                try:
                    self.model = OptimizedTurboVoice()
                    break
                except torch.cuda.OutOfMemoryError as e:
                    failure = repr(e)
                # Drop the failed constructor's traceback before collecting its partial model.
                self._unload("after cold-load OOM")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise SynthesisError(failure)
                log.warning("cold load waiting for VRAM: %s", failure)
                time.sleep(min(0.5, remaining))
                if time.monotonic() >= deadline:
                    raise SynthesisError(failure)
            log.info(
                "cold load %.1fs (free VRAM %s GB before, %s GB after)",
                time.perf_counter() - start,
                free,
                gpu_stats(self.gpu_index)["free_vram_gb"],
            )
        torch.cuda.synchronize()
        start = time.perf_counter()
        audio = self.model.speak(text, seed=42)
        torch.cuda.synchronize()
        secs = time.perf_counter() - start
        self.last_rtf = secs / (len(audio) / MODEL_RATE)
        reserved = torch.cuda.memory_reserved() / 2**30
        # Hand cached blocks back so a crowded GPU does not push the next new-length allocation into system RAM.
        torch.cuda.empty_cache()
        log.info(
            "synth %d chars -> %.2fs audio in %.2fs (RTF %.2f, reserved %.2f GB, free VRAM %s GB)",
            len(text),
            len(audio) / MODEL_RATE,
            secs,
            self.last_rtf,
            reserved,
            gpu_stats(self.gpu_index)["free_vram_gb"],
        )
        return audio

    def unload_if_idle(self) -> None:
        with self.counter_lock:
            if not self.pending and not self.active_requests and self.model is not None and time.monotonic() - self.last_used >= self.idle_unload:
                self._unload("after idle")

    def _unload(self, why: str) -> None:
        import torch

        self.model = None
        gc.collect()
        torch.cuda.empty_cache()
        log.info("unloaded %s (free VRAM %s GB)", why, gpu_stats(self.gpu_index)["free_vram_gb"])

    def status(self) -> dict:
        with self.counter_lock:
            busy = bool(self.busy or self.pending or self.active_requests)
            queue_depth = max(self.pending - self.busy, 0)
        return {
            "loaded": self.model is not None,
            "busy": busy,
            "queue_depth": queue_depth,
            "last_synth_rtf": None if self.last_rtf is None else round(self.last_rtf, 3),
            "tempo": self.tempo,
            **gpu_stats(self.gpu_index),
        }


class WyomingHandler(AsyncEventHandler):
    def __init__(self, info: Info, voice: Voice, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.info, self.voice = info, voice

    async def handle_event(self, event: Event) -> bool:
        if Describe.is_type(event.type):
            await self.write_event(self.info.event())
            return True
        if not Synthesize.is_type(event.type):
            return True
        groups = sentence_groups(Synthesize.from_event(event).text)
        with self.voice.request():
            await self.write_event(AudioStart(rate=OUT_RATE, width=2, channels=1).event())
            try:
                for group in groups:
                    audio = await asyncio.wrap_future(self.voice.speak(group))
                    await self.write_event(AudioChunk(rate=OUT_RATE, width=2, channels=1, audio=to_pcm16(audio)).event())
            except Exception as e:
                log.exception("synthesis failed")
                await self.write_event(Error(text=f"synthesis failed: {e!r}"[:500], code="synthesis-failed").event())
                return False
            await self.write_event(AudioStop().event())
            return True

    async def disconnect(self) -> None:
        # The library's default leaves the socket open, so a client never sees EOF after an error.
        self.writer.close()


def http_handler(voice: Voice, name: str) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, code: int, body: bytes, content_type: str, headers: dict | None = None) -> None:
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path not in ("/", "/status"):
                self.send_error(404)
                return
            self.reply(200, json.dumps({"name": name, **voice.status()}).encode(), "application/json")

        def do_POST(self):
            if self.path == "/unload":
                future = voice.unload()
                if future is None:
                    self.reply(409, b'{"error": "synthesis in progress or queued"}', "application/json")
                else:
                    self.reply(200, json.dumps({"unloaded": future.result()}).encode(), "application/json")
                return
            if self.path != "/tts":
                self.send_error(404)
                return
            text = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode("utf-8").strip()
            if not text:
                self.send_error(400, "empty text")
                return
            try:
                with voice.request():
                    cold, start = voice.model is None, time.perf_counter()
                    audio = np.concatenate([voice.speak(group).result() for group in sentence_groups(text)])
                    secs = time.perf_counter() - start
                    buf = io.BytesIO()
                    sf.write(buf, audio, MODEL_RATE, format="WAV", subtype="PCM_16")
                    self.reply(200, buf.getvalue(), "audio/wav", {"X-Synth-Seconds": f"{secs:.2f}", "X-Cold-Load": str(cold)})
            except Exception as e:
                log.exception("http synthesis failed")
                self.send_error(500, repr(e)[:200])
                return

    return Handler


async def reaper(voice: Voice) -> None:
    while True:
        await asyncio.sleep(30)
        await asyncio.wrap_future(voice.worker.submit(voice.unload_if_idle))


async def serve(config: dict) -> None:
    name, gpu_index = config["name"], config.get("gpu_index", 0)
    voice = Voice(
        config["runtime"],
        gpu_index,
        config.get("idle_unload_seconds", 600),
        config.get("gain", 1.0),
        config.get("tempo", 1.0),
    )
    upstream = Attribution(name="Resemble AI", url="https://github.com/resemble-ai/chatterbox")
    voice_info = TtsVoice(
        name=config.get("voice_name", "default"),
        description="Chatterbox Turbo voice",
        version=None,
        installed=True,
        languages=["en"],
        attribution=upstream,
    )
    program = TtsProgram(
        name="chatterbox",
        description=f"Chatterbox Turbo + Resemble Enhance ({name})",
        version="0.1.0",
        installed=True,
        attribution=upstream,
        voices=[voice_info],
    )
    for bind in config.get("http", []):
        host, port = bind.rsplit(":", 1)
        server = ThreadingHTTPServer((host, int(port)), http_handler(voice, name))
        threading.Thread(target=server.serve_forever, daemon=True).start()
    servers = [AsyncServer.from_uri(uri) for uri in config["wyoming"]]
    log.info("ready: %s wyoming=%s http=%s gpu=%s", name, config["wyoming"], config.get("http", []), gpu_index)
    handler = partial(WyomingHandler, Info(tts=[program]), voice)
    await asyncio.gather(reaper(voice), *(server.run(handler) for server in servers))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--config", required=True, help="TOML file with host-specific settings")
    with open(parser.parse_args().config, "rb") as f:
        config = tomllib.load(f)
    # Pin the GPU before torch is imported; PCI order makes the index match nvidia-smi.
    os.environ["CUDA_DEVICE_ORDER"] = "PCI_BUS_ID"
    os.environ["CUDA_VISIBLE_DEVICES"] = str(config.get("gpu_index", 0))
    if sys.stdout is None:
        # pythonw has no console: send our log and the runtime's progress bars to the log file.
        sys.stdout = sys.stderr = open(config["log"], "a", buffering=1, encoding="utf-8")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stderr)
    asyncio.run(serve(config))


if __name__ == "__main__":
    main()
