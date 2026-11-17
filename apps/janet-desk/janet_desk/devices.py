import asyncio
from collections.abc import AsyncIterator

import numpy as np
import sounddevice as sd

from .audio import FRAME_SAMPLES, MIC_RATE, Clip


def _wasapi() -> dict:
    # WASAPI is the Windows host API that reports full device names and opens one specific endpoint.
    return next(api for api in sd.query_hostapis() if "WASAPI" in api["name"])


def device_names(kind: str) -> list[str]:
    devices = (sd.query_devices(index) for index in _wasapi()["devices"])
    return sorted(device["name"] for device in devices if device[f"max_{kind}_channels"])


def _resolve(name: str, kind: str) -> tuple[str, int]:
    api = _wasapi()
    if not name:
        default = sd.query_devices(api[f"default_{kind}_device"])
        return default["name"], default["index"]
    for index in api["devices"]:
        device = sd.query_devices(index)
        if device["name"] == name and device[f"max_{kind}_channels"]:
            return name, index
    raise ValueError(f"no {kind} device named {name!r}; found {device_names(kind)}")


# Lets Windows convert between the client's format and the device's own rate and channel count.
_CONVERT = sd.WasapiSettings(auto_convert=True)


class Microphone:
    def __init__(self, device: str):
        self.device, self._index = _resolve(device, "input")

    async def __aiter__(self) -> AsyncIterator[bytes]:
        loop = asyncio.get_running_loop()
        frames: asyncio.Queue[bytes] = asyncio.Queue()

        def capture(data, _frames, _time, _status) -> None:
            loop.call_soon_threadsafe(frames.put_nowait, bytes(data))

        with sd.RawInputStream(
            samplerate=MIC_RATE,
            blocksize=FRAME_SAMPLES,
            channels=1,
            dtype="int16",
            device=self._index,
            callback=capture,
            extra_settings=_CONVERT,
        ):
            while True:
                yield await frames.get()


class DeviceSpeaker:
    def __init__(self, device: str, volume: float):
        self.device, self._index = _resolve(device, "output")
        self._volume = volume
        self._stream: sd.OutputStream | None = None

    async def play(self, clip: Clip) -> float:
        samples = (np.frombuffer(clip.pcm, "<i2") * self._volume).astype("int16")
        if not len(samples):
            return 1.0
        loop = asyncio.get_running_loop()
        finished = asyncio.Event()
        position = 0

        def fill(out, frames, _time, _status) -> None:
            nonlocal position
            chunk = samples[position : position + frames]
            out[: len(chunk), 0] = chunk
            out[len(chunk) :] = 0
            position += len(chunk)
            if len(chunk) < frames:
                raise sd.CallbackStop

        def done() -> None:
            loop.call_soon_threadsafe(finished.set)

        self._stream = sd.OutputStream(
            samplerate=clip.rate,
            channels=1,
            dtype="int16",
            device=self._index,
            callback=fill,
            finished_callback=done,
            extra_settings=_CONVERT,
        )
        with self._stream:
            await finished.wait()
        return position / len(samples)

    def stop(self) -> None:
        if self._stream:
            self._stream.abort()
