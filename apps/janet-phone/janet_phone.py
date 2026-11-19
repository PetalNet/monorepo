"""A phone call to Janet: caller audio on one WebSocket, a voice head conversation behind it."""

import argparse
import array
import asyncio
import hashlib
import io
import json
import logging
import os
import socket
import subprocess
import sys
import threading
import time
import tomllib
import urllib.error
import urllib.request
import uuid
import wave
from dataclasses import dataclass, field
from http import HTTPStatus
from pathlib import Path

from websockets.asyncio.server import ServerConnection, serve  # noqa: F401
from websockets.exceptions import ConnectionClosed
from websockets.http11 import Request, Response

import pairing

__version__ = "0.1.0"

log = logging.getLogger("janet-phone")
RATE = 16000  # caller audio: mono PCM16LE
FRAME = RATE // 50 * 2  # bytes in 20 ms
DISCLOSURES: dict[str, tuple[int, bytes]] = {}
RECORD_LIMIT = 20000  # characters; a Matrix event holds about 64 kB
OPEN: set[int] = set()  # calls in progress


class Endpointer:
    """Splits a stream of caller audio into utterances by loudness.

    feed() returns "start" when speech begins, the utterance's PCM when it ends, and None otherwise.
    This is the one place a better end-of-speech detector plugs in.
    """

    def __init__(self, threshold: int = 500, start_ms: int = 100, silence_ms: int = 700, lead_ms: int = 300,
                 max_s: int = 30):
        self.threshold, self.start_frames, self.silence_frames = threshold, start_ms // 20, silence_ms // 20
        self.lead_frames, self.max_frames = lead_ms // 20, max_s * 50
        self._pending = b""
        self._frames: list[bytes] = []
        self._speaking = False
        self._loud = self._quiet = 0

    def feed(self, pcm: bytes) -> list[str | bytes]:
        events: list[str | bytes] = []
        self._pending += pcm
        while len(self._pending) >= FRAME:
            frame, self._pending = self._pending[:FRAME], self._pending[FRAME:]
            samples = array.array("h", frame)
            loud = sum(s * s for s in samples) > self.threshold**2 * len(samples)
            self._frames.append(frame)
            if not self._speaking:
                self._loud = self._loud + 1 if loud else 0
                if self._loud >= self.start_frames:
                    self._speaking, self._quiet = True, 0
                    events.append("start")
                else:
                    del self._frames[: -self.lead_frames - self.start_frames]
            else:
                self._quiet = 0 if loud else self._quiet + 1
                if self._quiet >= self.silence_frames or len(self._frames) >= self.max_frames:
                    events.append(b"".join(self._frames))
                    self._frames, self._speaking, self._loud = [], False, 0
        return events


_WORDS: list = []
LINE_BLOCK_S = 0.05  # the line tone is sent in blocks this long, a block ahead of real time at most


def make_line(config: "Config", rate: int):
    """The shared line tone (packages/janet-line) at `rate`, or None when no code is set or it cannot be made."""
    if not config.line_tone:
        return None
    here = Path(__file__).resolve()
    repo = str(here.parents[2] / "packages" / "janet-line") if len(here.parents) > 2 else ""
    if repo and Path(repo).is_dir() and repo not in sys.path:
        sys.path.append(repo)
    try:
        from janet_line.tone import LineTone

        return LineTone(config.line_tone, rate)
    except Exception as error:  # noqa: BLE001 - a call goes on without its background sound
        log.warning("no line tone: %s", error)
        return None


def mix(pcm: bytes, tone) -> bytes:
    """PCM16 mono with `tone` (float samples, -1..1) added, clipped."""
    import numpy as np

    voice = np.frombuffer(pcm, "<i2").astype(np.float32)
    return np.clip(voice + tone[: len(voice)] * 32768, -32768, 32767).astype("<i2").tobytes()


def new_endpointer(config: "Config"):
    """The shared turn detector (packages/janet-turn) when its models are installed, else the loudness rule above."""
    models = Path(config.turn_models) if config.turn_models else None
    here = Path(__file__).resolve()
    repo = str(here.parents[2] / "packages" / "janet-turn") if len(here.parents) > 2 else ""
    if repo and Path(repo).is_dir() and repo not in sys.path:  # in the repository; the image has the package beside this file
        sys.path.append(repo)
    if models and (models / "silero_vad.onnx").exists():
        try:
            from janet_turn.turn_end import Policy, Utterances
            from janet_turn.turn_judge import Words

            parakeet = models / "parakeet_realtime_eou_120m.int8.onnx"
            if not _WORDS and parakeet.exists():
                _WORDS.append(Words(parakeet, models / "parakeet_vocab.txt"))
            return Utterances(models, Policy(nothing_said_s=1e9), words=_WORDS[0] if _WORDS else None)
        except Exception as error:  # noqa: BLE001 - a call must go on with the loudness rule
            log.warning("no shared turn detector, using the loudness rule: %s", error)
    return Endpointer(**config.endpoint)


@dataclass(frozen=True)
class Config:
    listen: str
    gateway: str  # janet-voice-gateway: the head's conversation routes and /v1/tts
    stt: str  # host:port of a Wyoming speech-to-text server
    tier: str
    channel: str
    disclosure: str
    # What kind of line this bridge answers. Only "inbound" is a real call from the outside.
    source: str = "test"
    # Command that gets the call record on stdin and where it goes in JANET_PHONE_DESTINATION.
    notify: list[str] = field(default_factory=list)
    record_dir: str = ""  # keep both sides of every call as WAV files here
    cache_dir: str = ""  # keep the disclosure's audio here across restarts
    max_calls: int = 2
    max_call_s: int = 900
    # Who may call: a phone presents its own device token, which works only here. The bridge then
    # speaks to the gateway with the voice head's token, which never leaves the lab.
    head_token_file: str = ""
    devices_file: str = ""
    # Pairing a phone: the plain-HTTP listener, the public wss:// address phones are told to call,
    # the Cloudflare Access service token they need to reach it, and who may open the pairing page.
    http_listen: str = ""
    public_url: str = ""
    access_file: str = ""
    pair_users: list[str] = field(default_factory=list)
    pair_path: str = "/pair"
    proxy_secret_file: str = ""  # what the single-sign-on proxy sends to prove a page request is its own
    pair_ttl_s: int = 600
    # Signing in from the app: the [signin] table, whose keys are pairing.SignIn's fields. Empty turns it off.
    signin: dict = field(default_factory=dict)
    endpoint: dict = field(default_factory=dict)
    # Directory holding silero_vad.onnx and the Parakeet speech model for the shared turn detector. Empty uses the loudness rule.
    turn_models: str = ""
    # The call's background sound, as the tuning page's code (packages/janet-line), e.g. "AL6 AT45 AW83 BC2 BL11 BR7 BF2 BO6 DL0 DW48 U37 V80".
    # Empty is off. It plays while the line is open: comfort noise, a hum while a reply is worked on, ducked under Janet's voice.
    line_tone: str = ""


def transcribe(address: str, pcm: bytes) -> str:
    """One utterance through a Wyoming speech-to-text server."""
    host, _, port = address.rpartition(":")
    info = {"rate": RATE, "width": 2, "channels": 1}

    def event(kind: str, data: dict, payload: bytes = b"") -> bytes:
        return json.dumps({"type": kind, "data": data, "payload_length": len(payload)}).encode() + b"\n" + payload

    with socket.create_connection((host, int(port)), timeout=10) as sock, sock.makefile("rb") as reader:
        sock.settimeout(60)
        sock.sendall(event("transcribe", {"language": "en"}) + event("audio-start", info)
                     + event("audio-chunk", info, pcm) + event("audio-stop", {}))
        while line := reader.readline():
            header = json.loads(line)
            data = dict(header.get("data") or {})
            if header.get("data_length"):
                data.update(json.loads(reader.read(header["data_length"])))
            reader.read(header.get("payload_length") or 0)
            if header["type"] == "transcript":
                return data.get("text", "").strip()
    raise OSError("the speech-to-text server closed the connection")


def level(pcm: bytes, rate: int) -> float:
    """A meter reading from 0 to 1: the RMS of the last 20 ms of PCM16, over 6000, clamped. The
    calling app computes the same thing locally when no readings arrive, so the scale never jumps."""
    samples = array.array("h", pcm[: len(pcm) & ~1])[-(rate // 50):]
    if not samples:
        return 0.0
    return round(min(1.0, (sum(s * s for s in samples) / len(samples)) ** 0.5 / 6000), 3)


def word_times(sentence: str, seconds: float) -> list[dict]:
    """When each word of a sentence falls in its audio. The voice gives no timing, so each word gets
    a share of the sentence's length in proportion to its letters: an estimate, good enough to
    reveal text in step with speech."""
    words = sentence.split()
    total = sum(len(word) + 1 for word in words) or 1
    times, at = [], 0.0
    for word in words:
        share = (len(word) + 1) / total * seconds
        times.append({"w": word, "t": round(at, 2), "d": round(share, 2)})
        at += share
    return times


DISCLOSING = threading.Lock()


def disclosure_audio(config: Config, gateway: "Gateway") -> tuple[int, bytes]:
    """The disclosure is fixed text, so its audio is synthesized once and kept: in memory, and in
    cache_dir so that the first call after a restart, or while the voice host is asleep, still opens
    with it at once. One caller at a time: a call and a warm-up often want it together."""
    text = config.disclosure
    with DISCLOSING:
        if text in DISCLOSURES:
            return DISCLOSURES[text]
        name = hashlib.sha256(text.encode()).hexdigest() + ".wav"
        cached = Path(config.cache_dir) / name if config.cache_dir else None
        if cached is not None and cached.exists():
            # A file that is empty, cut short or not audio is not the disclosure: synthesize again.
            try:
                with wave.open(str(cached)) as wav:
                    rate, frames, pcm = wav.getframerate(), wav.getnframes(), wav.readframes(wav.getnframes())
                if frames and len(pcm) == frames * 2:
                    DISCLOSURES[text] = (rate, pcm)
                    return DISCLOSURES[text]
            except (OSError, EOFError, wave.Error):
                pass
            log.warning("the cached disclosure is unusable; synthesizing it again")
        rate, pcm = gateway.speech(text)
        if not pcm:
            raise OSError("the voice returned no audio for the disclosure")
        DISCLOSURES[text] = (rate, pcm)
        if cached is not None:
            try:
                cached.parent.mkdir(parents=True, exist_ok=True)
                partial = cached.with_suffix(".tmp")
                with wave.open(str(partial), "wb") as wav:
                    wav.setnchannels(1), wav.setsampwidth(2), wav.setframerate(rate)
                    wav.writeframes(pcm)
                os.replace(partial, cached)
            except OSError as error:
                log.warning("the disclosure was not cached: %s", error)
        return rate, pcm


WARMED = [float("-inf")]


def warm(config: Config, gateway: "Gateway") -> None:
    """Gets the slow parts ready before anyone speaks: wakes the voice host, loads the voice and the
    speech-to-text model, and makes sure the disclosure is cached. At most once a minute."""
    if time.monotonic() - WARMED[0] < 60:
        return
    WARMED[0] = time.monotonic()
    steps = [("speech to text", lambda: transcribe(config.stt, bytes(RATE * 2))),
             ("voice", lambda: gateway.speech("Okay."))]
    if not DISCLOSING.locked():  # a call is already fetching it; do not queue behind that
        steps.insert(1, ("disclosure", lambda: disclosure_audio(config, gateway)))
    for name, step in steps:
        try:
            step()
        except (OSError, ValueError, EOFError, wave.Error) as error:
            log.warning("warm-up: %s failed: %s", name, error)


def destination(config: Config) -> str:
    """Where a call's record goes: "owner" for a real inbound call, "notebook" for everything else.

    A test, a development call or a call on a test channel must never reach the owner's own room, so
    that is the answer unless the bridge is explicitly an inbound line.
    """
    channel = config.channel.lower()
    real = config.source == "inbound" and "test" not in channel and "dev" not in channel
    return "owner" if real else "notebook"


class Ended(Exception):
    """The head no longer has the conversation: it ends one that sits idle."""


class Gateway:
    """The voice gateway's conversation and speech routes, called with the headers it is given."""

    def __init__(self, url: str, headers: dict[str, str]):
        self.url, self.headers = url.rstrip("/"), headers

    def _open(self, path: str, body: dict, timeout: float = 120):
        request = urllib.request.Request(self.url + path, json.dumps(body).encode(),
                                         {**self.headers, "content-type": "application/json"})
        return urllib.request.urlopen(request, timeout=timeout)

    def open(self, config: "Config") -> str:
        opened = {"channel": config.channel, "tier": config.tier, "client_ref": uuid.uuid4().hex}
        return self.post("/v1/conversations", opened)["id"]

    def post(self, path: str, body: dict) -> dict:
        with self._open(path, body) as response:
            return json.loads(response.read() or b"{}")

    def turn(self, conversation: str, text: str):
        """Yields ("sentence", {"text"}) for each sentence of the reply, then ("done", {...})."""
        try:
            response = self._open(f"/v1/conversations/{conversation}/turns", {"text": text})
        except urllib.error.HTTPError as error:
            gone = {404: b"no such conversation", 409: b"ended"}.get(error.code)
            if gone and gone in error.read():
                raise Ended(f"{error.code}: the head no longer has the conversation") from None
            raise
        with response:
            kind = ""
            for raw in response:
                line = raw.decode().rstrip("\n")
                if line.startswith("event: "):
                    kind = line[7:]
                elif line.startswith("data: "):
                    yield kind, json.loads(line[6:])

    def speech(self, text: str) -> tuple[int, bytes]:
        """One sentence as (sample rate, mono PCM16). Waits for a voice host that is waking up."""
        for _ in range(24):
            try:
                with self._open("/v1/tts", {"text": text}, timeout=300) as response:
                    body = io.BytesIO(response.read())
                with wave.open(body) as wav:
                    return wav.getframerate(), wav.readframes(wav.getnframes())
            except urllib.error.HTTPError as error:
                if error.code != 503:
                    raise
                time.sleep(5)
        raise OSError("the voice host did not wake")


class Call:
    def __init__(self, ws: ServerConnection, config: Config, gateway: Gateway, conversation: str, device: str = ""):
        self.ws, self.config, self.gateway, self.conversation, self.device = ws, config, gateway, conversation, device
        self.started = time.time()
        self.connected = time.monotonic()
        self.transcript: list[tuple[str, str]] = []
        self.latency: dict = {"turns": []}
        # A caller who talks faster than turns complete loses the oldest-waiting speech, not memory.
        self.utterances: asyncio.Queue[tuple[bytes, float]] = asyncio.Queue(maxsize=4)
        self.speaking: asyncio.Task | None = None
        self.heard: list[str] = []
        self.rate = 0
        self.over = False
        self.him = 0.0  # the caller's level, as last measured
        self.playing = False
        self.phase = "listening"  # what the pipeline is doing: listening, thinking or speaking
        self.line = None
        # Two WAV tracks on one clock, both starting when the call connected: the caller's microphone as it
        # arrives, and Janet's audio padded with silence to when each piece was sent. The timeline gives
        # each side's words the second they were said.
        self.tape = {"caller": bytearray(), "janet": bytearray()}
        self.timeline: list[dict] = []

    async def run(self) -> None:
        listener = asyncio.create_task(self.listen())
        hum = asyncio.create_task(self.hum())
        try:
            await self.say(self.config.disclosure, asyncio.ensure_future(self.disclosure()))
            while True:
                await self.tell(type="state", value="listening")
                try:
                    pcm, ended = await self.utterances.get()
                except asyncio.QueueShutDown:
                    return
                await self.tell(type="state", value="thinking")
                turn = {"endpoint_ms": self.config.endpoint.get("silence_ms", 700)}
                mark = time.monotonic()
                try:
                    text = await asyncio.to_thread(transcribe, self.config.stt, pcm)
                except (OSError, ValueError) as error:
                    log.warning("call %s: speech to text failed: %s", self.conversation, error)
                    continue
                turn["stt_ms"] = round((time.monotonic() - mark) * 1000)
                if not text:
                    continue
                log.info("call %s: heard %r, %.1f s into the call (stt %d ms)", self.conversation, text[:60], time.monotonic() - self.connected, turn["stt_ms"])
                self.transcript.append(("Caller", text))
                self.timeline.append({"t": round(ended - self.connected, 2), "who": "Caller", "text": text})
                await self.tell(type="words", side="him", text=text, words=[])
                self.speaking = asyncio.create_task(self.reply(text, ended, turn))
                await asyncio.wait([self.speaking])
                if self.speaking.cancelled():
                    continue
                if error := self.speaking.exception():
                    if isinstance(error, ConnectionClosed):
                        return
                    log.warning("call %s: reply failed: %s", self.conversation, error)
                elif self.speaking.result():
                    await self.ws.send(json.dumps({"type": "bye"}))
                    return
        except ConnectionClosed:
            pass
        finally:
            self.over = True
            listener.cancel()
            hum.cancel()
            if self.speaking is not None:
                self.speaking.cancel()
            await self.ws.close()

    async def tell(self, **message) -> None:
        """One event for the caller's screen. A device that does not know an event ignores it."""
        if message.get("type") == "state":
            self.phase = message["value"]
        await self.ws.send(json.dumps(message))

    async def hum(self) -> None:
        """Sends the line tone whenever no speech is going out, in real time, so the caller knows the line is open."""
        if not self.config.line_tone:
            return
        due = time.monotonic()
        while True:
            line = self.line  # made by say() with the rate it announced, so this never plays at another rate
            if self.playing or line is None:
                due = time.monotonic()
                await asyncio.sleep(LINE_BLOCK_S / 2)
                continue
            block = line.render(int(self.rate * LINE_BLOCK_S), self.phase)[:, 0]
            chunk = mix(bytes(int(self.rate * LINE_BLOCK_S) * 2), block)
            await self.ws.send(chunk)
            if self.config.record_dir:
                self.tape_janet(chunk, self.rate)
            due += LINE_BLOCK_S
            await asyncio.sleep(max(0.0, due - LINE_BLOCK_S - time.monotonic()))

    async def disclosure(self) -> tuple[int, bytes]:
        return await asyncio.to_thread(disclosure_audio, self.config, self.gateway)

    async def listen(self) -> None:
        """Reads the caller until the socket closes, however it closes, and then ends the call."""
        endpointer, heard = await asyncio.to_thread(new_endpointer, self.config), 0
        try:
            async with asyncio.timeout(self.config.max_call_s):
                async for message in self.ws:
                    if not isinstance(message, bytes):
                        continue
                    if self.config.record_dir:
                        self.tape["caller"] += message
                    heard += len(message)
                    if heard >= RATE // 5:  # every 100 ms of microphone audio
                        heard, self.him = 0, level(message, RATE)
                        if not self.playing:
                            await self.tell(type="level", her=0.0, him=self.him)
                    for event in endpointer.feed(message):
                        if event == "start":
                            await self.cut_off()
                        elif not self.utterances.full():
                            self.utterances.put_nowait((event, time.monotonic()))
        except (ConnectionClosed, TimeoutError):
            pass
        finally:
            self.utterances.shutdown(immediate=True)
            if close := getattr(endpointer, "close", None):
                close()

    async def cut_off(self) -> None:
        if self.speaking is None or self.speaking.done():
            return
        log.info("call %s: cut off by the caller after %d sentences heard, %.1f s into the call", self.conversation, len(self.heard), time.monotonic() - self.connected)
        self.speaking.cancel()
        await self.ws.send(json.dumps({"type": "clear"}))
        heard = {"heard_text": " ".join(self.heard)}
        try:
            await asyncio.to_thread(self.gateway.post, f"/v1/conversations/{self.conversation}/interrupt", heard)
        except (OSError, ValueError) as error:
            log.warning("call %s: interrupt failed: %s", self.conversation, error)

    async def reply(self, text: str, ended: float, turn: dict) -> bool:
        """Speaks one reply. Each sentence is synthesized as it arrives, while earlier ones play."""
        loop, events, spoken = asyncio.get_running_loop(), asyncio.Queue(), asyncio.Queue()

        def stream():
            try:
                yield from self.gateway.turn(self.conversation, text)
            except Ended:
                # A voice host that was asleep can take longer to say the disclosure than the head
                # keeps an idle conversation. The call goes on in a new one, unless it is already over.
                if self.over:
                    raise
                old, self.conversation = self.conversation, self.gateway.open(self.config)
                log.info("call %s: reopened as %s", old, self.conversation)
                yield from self.gateway.turn(self.conversation, text)

        def produce() -> None:
            try:
                for kind, data in stream():
                    loop.call_soon_threadsafe(events.put_nowait, (kind, data))
            except Exception as error:  # noqa: BLE001 - the consumer must always get a last item
                loop.call_soon_threadsafe(events.put_nowait, ("failed", {"error": str(error)}))

        async def play() -> None:
            while (item := await spoken.get()) is not None:
                await self.say(*item, turn, ended)

        loop.run_in_executor(None, produce)
        player, voices = asyncio.create_task(play()), []
        self.heard = []
        mark = time.monotonic()
        try:
            while True:
                kind, data = await events.get()
                if kind == "sentence":
                    turn.setdefault("head_ms", round((time.monotonic() - mark) * 1000))
                    voices.append(asyncio.create_task(self.synthesize(data["text"], turn)))
                    spoken.put_nowait((data["text"], voices[-1]))
                    continue
                if kind == "failed":
                    log.warning("call %s: turn failed: %s", self.conversation, data["error"])
                spoken.put_nowait(None)
                await player
                return kind == "done" and bool(data.get("end_conversation"))
        finally:
            for task in (player, *voices):
                task.cancel()

    async def synthesize(self, sentence: str, turn: dict | None = None) -> tuple[int, bytes]:
        mark = time.monotonic()
        audio = await asyncio.to_thread(self.gateway.speech, sentence)
        if turn is not None:
            turn.setdefault("tts_ms", round((time.monotonic() - mark) * 1000))
        return audio

    async def say(self, sentence: str, audio: asyncio.Task, turn: dict | None = None, ended: float = 0.0) -> None:
        rate, pcm = await audio
        if rate != self.rate:
            line = await asyncio.to_thread(make_line, self.config, rate)
            await self.ws.send(json.dumps({"type": "audio", "rate": rate}))
            self.rate, self.line = rate, line  # the tone starts only after the device knows the rate
        if turn is not None and "total_ms" not in turn:
            turn["total_ms"] = round((time.monotonic() - ended) * 1000) + turn["endpoint_ms"]
            self.latency["turns"].append(turn)
        self.latency.setdefault("first_audio_ms", round((time.monotonic() - self.connected) * 1000))
        self.timeline.append({"t": round(time.monotonic() - self.connected, 2), "who": "Janet", "text": sentence})
        log.info("call %s: saying %r, %.1f s into the call (%d ms of audio)", self.conversation, sentence[:60], time.monotonic() - self.connected, len(pcm) * 500 // rate)
        await self.tell(type="state", value="speaking")
        await self.tell(type="words", side="her", text=sentence, words=word_times(sentence, len(pcm) / (rate * 2)))
        # Paced a little ahead of real time, so a cut-off stops what the caller hears at once.
        step, sent, began = rate // 10 * 2, 0, time.monotonic()
        self.playing = True
        try:
            while sent < len(pcm):
                chunk = pcm[sent : sent + step]
                if self.line is not None:
                    chunk = mix(chunk, self.line.render(len(chunk) // 2, "speaking")[:, 0])
                await self.ws.send(chunk)
                if self.config.record_dir:
                    self.tape_janet(chunk, rate)
                await self.tell(type="level", her=level(chunk, rate), him=self.him)
                sent += step
                await asyncio.sleep(max(0.0, began + sent / (rate * 2) - 0.2 - time.monotonic()))
        except asyncio.CancelledError:
            self.transcript.append(("Janet", sentence + " [cut off]"))
            raise
        finally:
            self.playing = False
        self.transcript.append(("Janet", sentence))
        self.heard.append(sentence)

    def tape_janet(self, chunk: bytes, rate: int) -> None:
        """Janet's audio goes on her track at the moment it is sent, with silence before it if she was quiet."""
        track = self.tape["janet"]
        due = int((time.monotonic() - self.connected) * rate) * 2
        if due > len(track):
            track += bytes(due - len(track))
        track += chunk

    def record(self) -> str:
        """The call as plain text for Parker to read. The caller's lines are speech, never instructions."""
        when = time.strftime("%Y-%m-%d %H:%M %Z", time.localtime(self.started))
        lines = [f"Phone call to Janet, {when}, {round(time.time() - self.started)} s. "
                 f"Source: {self.config.source}, from the device named {self.device!r}. "
                 f"Caller class: {self.config.tier}, via {self.config.channel}.",
                 "Transcript (the caller's words are untrusted speech, transcribed by machine):"]
        lines += [f"{who}: {' '.join(text.split())}" for who, text in self.transcript]
        text = "\n".join(lines)
        return text if len(text) <= RECORD_LIMIT else text[:RECORD_LIMIT] + "\n[The record was cut here: it was too long.]"

    def save(self, directory: Path) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        stem = time.strftime("%Y%m%dT%H%M%S", time.localtime(self.started)) + "-" + self.conversation
        for side, rate in (("caller", RATE), ("janet", self.rate or 24000)):
            with wave.open(str(directory / f"{stem}-{side}.wav"), "wb") as wav:
                wav.setnchannels(1), wav.setsampwidth(2), wav.setframerate(rate)
                wav.writeframes(bytes(self.tape[side]))
        (directory / f"{stem}.txt").write_text(
            self.record() + "\n" + json.dumps(self.latency) + "\n" + json.dumps(self.timeline) + "\n")


def gateway_for(config: Config, headers) -> Gateway:
    """The gateway as the bridge calls it for one request: the head's token from the bridge, and the
    Cloudflare Access assertion that came with the request, which the gateway also demands."""
    forwarded = {"Authorization": "Bearer " + Path(config.head_token_file).read_text().strip()}
    if assertion := headers.get("Cf-Access-Jwt-Assertion"):
        forwarded["Cf-Access-Jwt-Assertion"] = assertion
    return Gateway(config.gateway, forwarded)


async def admit(ws: ServerConnection, request: Request, config: Config, devices: pairing.Devices) -> Response | None:
    """Lets a paired phone in, then opens its conversation. A caller without a device token, or one
    the gateway refuses, never gets a socket."""
    upgrade = request.headers.get("Upgrade", "").lower() == "websocket" and "Sec-WebSocket-Key" in request.headers
    if request.path != "/v1/call" or not upgrade:
        return ws.respond(HTTPStatus.NOT_FOUND, "not found\n")
    authorization = request.headers.get_all("Authorization")
    device = devices.name_of(pairing.bearer(authorization[0])) if len(authorization) == 1 else None
    if device is None:
        return ws.respond(HTTPStatus.FORBIDDEN, "this phone is not paired\n")
    if len(OPEN) >= config.max_calls:
        return ws.respond(HTTPStatus.SERVICE_UNAVAILABLE, "busy\n")
    ws.device = device
    ws.gateway = gateway_for(config, {"Cf-Access-Jwt-Assertion": (request.headers.get_all("Cf-Access-Jwt-Assertion") or [""])[0]})
    try:
        ws.conversation = await asyncio.to_thread(ws.gateway.open, config)
    except urllib.error.HTTPError as error:
        log.warning("call refused: %s", error)
        return ws.respond(HTTPStatus.FORBIDDEN if error.code in (401, 403) else HTTPStatus.BAD_GATEWAY, "refused\n")
    except (OSError, ValueError, KeyError) as error:
        log.warning("call failed: %s", error)
        return ws.respond(HTTPStatus.BAD_GATEWAY, "the voice gateway is unreachable\n")
    return None


async def handle(ws: ServerConnection, config: Config) -> None:
    call = Call(ws, config, ws.gateway, ws.conversation, ws.device)
    # A sleeping voice host starts waking now, while the caller hears the cached disclosure.
    threading.Thread(target=warm, args=(config, ws.gateway), daemon=True).start()
    OPEN.add(id(call))
    log.info("call %s: answered", call.conversation)
    try:
        await call.run()
    finally:
        OPEN.discard(id(call))
        log.info("call %s: ended %s", call.conversation, json.dumps(call.latency))
        await asyncio.to_thread(finish, call)


def finish(call: Call) -> None:
    """Ends the conversation, keeps the recording and hands the record on. Each step runs whatever the others do."""
    steps = {"end": lambda: call.gateway.post(f"/v1/conversations/{call.conversation}/end", {"reason": "hangup"})}
    if call.config.record_dir:
        steps["save"] = lambda: call.save(Path(call.config.record_dir))
    if call.config.notify:
        env = {**os.environ, "JANET_PHONE_DESTINATION": destination(call.config)}
        steps["notify"] = lambda: subprocess.run(call.config.notify, input=call.record().encode(), check=True,
                                                 capture_output=True, timeout=180, env=env)
    for name, step in steps.items():
        try:
            step()
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            log.warning("call %s: %s failed: %s", call.conversation, name, error)


def paired(config: Config, name: str, by: str) -> None:
    """Says in the notebook that a phone was paired: whoever redeems a pairing code first holds the
    pairing, so a pairing nobody expected must be seen."""
    if not config.notify:
        return
    text = f"A phone was paired with Janet's phone line by {by}: {name!r}. Unpair it with --revoke if that was not you."
    try:
        subprocess.run(config.notify, input=text.encode(), check=True, capture_output=True, timeout=60,
                       env={**os.environ, "JANET_PHONE_DESTINATION": "notebook"})
    except (OSError, subprocess.SubprocessError) as error:
        log.warning("pairing notice failed: %s", error)


def warm_route(config: Config, devices: pairing.Devices):
    """POST /v1/call/warm: a paired phone says a call is likely. Answers at once."""

    def route(headers, body) -> tuple[int, dict]:
        if devices.name_of(pairing.bearer(headers.get("Authorization"))) is None:
            return HTTPStatus.FORBIDDEN, {}
        threading.Thread(target=warm, args=(config, gateway_for(config, headers)), daemon=True).start()
        return HTTPStatus.ACCEPTED, {"ok": True}

    return route


async def serve_forever(config: Config) -> None:
    devices = pairing.Devices(Path(config.devices_file))
    if config.http_listen:
        pairing.serve(config.http_listen, devices, pairing.Codes(config.pair_ttl_s), url=config.public_url,
                      access_file=config.access_file, users=config.pair_users, page_path=config.pair_path,
                      proxy_secret_file=config.proxy_secret_file, on_paired=lambda name, by: paired(config, name, by),
                      signin=pairing.SignIn(**config.signin) if config.signin else None,
                      routes={"/v1/call/warm": warm_route(config, devices)})
        log.info("pairing on %s", config.http_listen)
    host, _, port = config.listen.rpartition(":")
    async with serve(lambda ws: handle(ws, config), host, int(port), max_size=1 << 20,
                     process_request=lambda ws, request: admit(ws, request, config, devices)) as server:
        log.info("listening on %s", config.listen)
        await server.serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--devices", action="store_true", help="list the paired phones and exit")
    parser.add_argument("--revoke", metavar="ID", help="unpair the phone whose id starts with ID and exit")
    parser.add_argument("--pair-link", metavar="FILE", type=Path,
                        help="ask the running bridge for a one-time pairing link and write it to FILE, mode 600")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    config = Config(**tomllib.loads(args.config.read_text()))
    devices = pairing.Devices(Path(config.devices_file))
    if args.pair_link:
        if not config.pair_users:
            parser.error("pair_users is empty: nobody may pair a phone")
        # The running bridge holds the codes, so the link comes from it, asked the way the sign-on
        # proxy asks. Only the file gets the link: it is a credential until it is used or expires.
        request = urllib.request.Request(f"http://{config.http_listen}{config.pair_path}?format=link", headers={
            "X-authentik-username": config.pair_users[0],
            "X-Janet-Pair-Proxy": Path(config.proxy_secret_file).read_text().strip()})
        with urllib.request.urlopen(request, timeout=15) as response:
            link = response.read()
        # A new file of its own, mode 600 from the start, then moved into place: an existing file's
        # looser mode or a symlink at that name cannot leak the link.
        partial = args.pair_link.with_name(args.pair_link.name + ".tmp")
        partial.unlink(missing_ok=True)
        with open(os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), "wb") as out:
            out.write(link)
        os.replace(partial, args.pair_link)
        print(f"wrote a pairing link to {args.pair_link}; it works once and for {config.pair_ttl_s // 60} minutes")
    elif args.revoke:
        print("unpaired:", devices.revoke(args.revoke) or "nothing: the id must match exactly one phone")
    elif args.devices:
        for ident, device in devices.listing():
            print(ident, device["paired"], device["paired_by"], device["name"])
    else:
        asyncio.run(serve_forever(config))


if __name__ == "__main__":
    main()
