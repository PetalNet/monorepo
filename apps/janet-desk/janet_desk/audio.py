import asyncio
import contextlib
import wave
from collections import Counter, deque
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass

MIC_RATE = 16000
FRAME_SAMPLES = 512
FRAME_BYTES = FRAME_SAMPLES * 2
FRAME_SECONDS = FRAME_SAMPLES / MIC_RATE
SILENT_FRAME = bytes(FRAME_BYTES)


@dataclass(frozen=True)
class Clip:
    pcm: bytes
    rate: int

    @property
    def seconds(self) -> float:
        return len(self.pcm) / 2 / self.rate


def read_mic_wav(path: str) -> bytes:
    with wave.open(path, "rb") as wav:
        if (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) != (MIC_RATE, 1, 2):
            raise ValueError(f"{path}: microphone input must be {MIC_RATE} Hz mono 16-bit")
        return wav.readframes(wav.getnframes())


def write_wav(path: str, clip: Clip) -> None:
    with wave.open(path, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(clip.rate)
        wav.writeframes(clip.pcm)


class MicHub:
    def __init__(self, frames: AsyncIterator[bytes], history_seconds: float = 3.0):
        self._frames = frames
        self._history: deque[bytes] = deque(maxlen=round(history_seconds / FRAME_SECONDS))
        self._taps: set[asyncio.Queue[bytes | None]] = set()
        self.position = 0
        self.ended = False

    async def run(self) -> None:
        async for frame in self._frames:
            self._history.append(frame)
            self.position += 1
            for tap in self._taps:
                tap.put_nowait(frame)
        self.ended = True
        for tap in self._taps:
            tap.put_nowait(None)

    @contextlib.contextmanager
    def tap(self, start: int | None = None) -> Iterator[asyncio.Queue[bytes | None]]:
        queue: asyncio.Queue[bytes | None] = asyncio.Queue()
        count = 0 if start is None else min(len(self._history), self.position - start)
        for frame in list(self._history)[len(self._history) - count :]:
            queue.put_nowait(frame)
        if self.ended:
            queue.put_nowait(None)
        self._taps.add(queue)
        try:
            yield queue
        finally:
            self._taps.discard(queue)


class SpeechGate:
    def __init__(self, min_speech: float, max_gap: float = 0.1):
        self._min_speech = min_speech
        self._max_gap = max_gap
        self._gap = 0.0
        self.heard_seconds = 0.0

    def feed(self, speaking: bool, seconds: float = FRAME_SECONDS) -> bool:
        if speaking:
            self.heard_seconds += seconds + self._gap
            self._gap = 0.0
        elif self.heard_seconds:
            self._gap += seconds
            if self._gap > self._max_gap:
                self.heard_seconds = self._gap = 0.0
        return self.heard_seconds >= self._min_speech


@dataclass(frozen=True)
class Say:
    pcm: bytes


@dataclass(frozen=True)
class Silence:
    seconds: float


@dataclass(frozen=True)
class WaitFor:
    event: str


MicStep = Say | Silence | WaitFor


def parse_mic_script(script: str) -> list[MicStep]:
    steps: list[MicStep] = []
    for token in script.split():
        kind, _, value = token.partition(":")
        match kind:
            case "wav":
                steps.append(Say(read_mic_wav(value)))
            case "silence":
                steps.append(Silence(float(value)))
            case "wait":
                steps.append(WaitFor(value))
            case _:
                raise ValueError(f"unknown microphone script step {token!r}")
    return steps


class ScriptedMic:
    def __init__(self, steps: list[MicStep], pace: float = 1.0):
        self._steps = steps
        self._pace = pace
        self._seen: Counter[str] = Counter()

    def notice(self, event: str) -> None:
        self._seen[event] += 1

    async def __aiter__(self) -> AsyncIterator[bytes]:
        loop = asyncio.get_running_loop()
        due = loop.time()
        seen_at_say: Counter[str] = Counter()

        async def tick() -> None:
            nonlocal due
            due += FRAME_SECONDS * self._pace
            await asyncio.sleep(max(0.0, due - loop.time()))

        for step in self._steps:
            match step:
                case Say(pcm):
                    seen_at_say = self._seen.copy()
                    for start in range(0, len(pcm), FRAME_BYTES):
                        yield pcm[start : start + FRAME_BYTES].ljust(FRAME_BYTES, b"\0")
                        await tick()
                case Silence(seconds):
                    for _ in range(round(seconds / FRAME_SECONDS)):
                        yield SILENT_FRAME
                        await tick()
                case WaitFor(event):
                    while self._seen[event] <= seen_at_say[event]:
                        yield SILENT_FRAME
                        await tick()


class RecordingSpeaker:
    def __init__(self, device: str, pace: float = 1.0):
        self.device = device
        self._pace = pace
        self._stop = asyncio.Event()
        self.played: list[Clip] = []

    async def play(self, clip: Clip) -> float:
        self._stop.clear()
        loop = asyncio.get_running_loop()
        start = loop.time()
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self._stop.wait(), clip.seconds * self._pace)
        fraction = min(1.0, (loop.time() - start) / (clip.seconds * self._pace)) if self._stop.is_set() else 1.0
        self.played.append(Clip(clip.pcm[: round(len(clip.pcm) / 2 * fraction) * 2], clip.rate))
        return fraction

    def stop(self) -> None:
        self._stop.set()

    def recording(self) -> Clip | None:
        if not self.played:
            return None
        return Clip(b"".join(clip.pcm for clip in self.played), self.played[0].rate)


class SileroVoice:
    def __init__(self, threshold: float = 0.5):
        from pysilero_vad import SileroVoiceActivityDetector

        self._detector = SileroVoiceActivityDetector()
        self._threshold = threshold

    def is_speech(self, frame: bytes) -> bool:
        return self._detector(frame) >= self._threshold
