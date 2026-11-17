import asyncio
import enum
import logging
import time
from collections.abc import AsyncIterator, Callable, Coroutine
from dataclasses import dataclass, field
from typing import ClassVar, Protocol

from .audio import FRAME_SECONDS, Clip, MicHub, SpeechGate
from .head import Done, Sentence

log = logging.getLogger("janet-desk")

PREROLL_MARGIN_SECONDS = 0.4
APOLOGY = "Sorry, something went wrong on my end."
# A voice server that unloads its model when idle takes many seconds to load it again. Asking for a throwaway word
# at the wake word starts that load while the user is still talking.
WARM_UP = "Okay."


@dataclass(frozen=True)
class WakeWord:
    pass


@dataclass(frozen=True)
class SpeechStarted:
    pass


@dataclass(frozen=True)
class Transcript:
    text: str


@dataclass(frozen=True)
class Unintelligible:
    pass


Heard = WakeWord | SpeechStarted | Transcript | Unintelligible


class Listener(Protocol):
    def listen(self, audio: "asyncio.Queue[bytes | None]", *, wake_word: bool) -> AsyncIterator[Heard]: ...


class Head(Protocol):
    async def open(self, tier: str) -> str: ...
    def turn(self, conversation: str, text: str) -> AsyncIterator[Sentence | Done]: ...
    async def interrupt(self, conversation: str, heard_text: str) -> None: ...
    async def end(self, conversation: str, reason: str) -> None: ...


class Synthesizer(Protocol):
    async def synthesize(self, text: str) -> Clip: ...


class Speaker(Protocol):
    device: str

    async def play(self, clip: Clip) -> float: ...

    def stop(self) -> None: ...


class VoiceDetector(Protocol):
    def is_speech(self, frame: bytes) -> bool: ...


class Tier(enum.StrEnum):
    PERSONAL = "personal"
    ROOM = "room"


@dataclass(frozen=True)
class Settings:
    headphones: frozenset[str]
    follow_up_seconds: float = 6.0
    barge_in_seconds: float = 0.3
    stall_seconds: float = 30.0


class Trace:
    def __init__(self) -> None:
        self._start = time.monotonic()
        self.records: list[dict] = []
        self.observers: list[Callable[[dict], None]] = []

    def mark(self, event: str, **fields: object) -> None:
        record = {"t": round(time.monotonic() - self._start, 3), "event": event, **fields}
        self.records.append(record)
        log.info("%s", " ".join(f"{key}={value}" for key, value in record.items() if key not in ("text", "heard")))
        for observer in self.observers:
            observer(record)


@dataclass
class Conversation:
    tier: Tier
    on_headphones: bool
    id: asyncio.Task[str]


@dataclass
class Reply:
    clips: asyncio.Queue[tuple[str, Clip] | None] = field(default_factory=asyncio.Queue)
    composing: asyncio.Task[None] = field(init=False)
    end_conversation: bool = False
    cut: bool = False


@dataclass
class Idle:
    name: ClassVar = "idle"


@dataclass
class Waking:
    name: ClassVar = "waking"
    hearing: AsyncIterator[Heard]


@dataclass
class Listening:
    name: ClassVar = "listening"
    conversation: Conversation
    hearing: AsyncIterator[Heard]


@dataclass
class Thinking:
    name: ClassVar = "thinking"
    conversation: Conversation
    text: str


@dataclass
class Speaking:
    name: ClassVar = "speaking"
    conversation: Conversation
    reply: Reply
    first: tuple[str, Clip]


@dataclass
class FollowUp:
    name: ClassVar = "follow_up"
    conversation: Conversation
    speech_began_at: int | None = None


State = Idle | Waking | Listening | Thinking | Speaking | FollowUp


class DeskClient:
    def __init__(
        self,
        *,
        mic: MicHub,
        listener: Listener,
        head: Head,
        synthesizer: Synthesizer,
        speaker: Speaker,
        voice: VoiceDetector,
        settings: Settings,
        trace: Trace,
    ):
        self._mic = mic
        self._listener = listener
        self._head = head
        self._synthesizer = synthesizer
        self._speaker = speaker
        self._voice = voice
        self._settings = settings
        self._trace = trace
        self._background: set[asyncio.Task[None]] = set()

    async def run(self) -> None:
        microphone = asyncio.create_task(self._mic.run())
        state: State = Idle()
        retry_seconds = 1.0
        try:
            while not (isinstance(state, Idle) and self._mic.ended):
                self._trace.mark(state.name)
                try:
                    state = await self._step(state)
                    retry_seconds = 1.0
                except Exception as error:
                    log.exception("%s failed", state.name)
                    self._trace.mark("error", state=state.name, error=repr(error))
                    if not isinstance(state, Idle | Waking):
                        await self._apologize()
                        self._end_in_background(state.conversation, "error")
                    await asyncio.sleep(retry_seconds)
                    retry_seconds = min(retry_seconds * 2, 30.0)
                    state = Idle()
        finally:
            microphone.cancel()
            if self._background:
                await asyncio.wait(self._background)

    async def _step(self, state: State) -> State:
        match state:
            case Idle():
                return await self._idle()
            case Waking():
                return self._waking(state)
            case Listening():
                return await self._listening(state)
            case Thinking():
                return await self._thinking(state)
            case Speaking():
                return await self._speaking(state)
            case FollowUp():
                return await self._follow_up(state)

    async def _hear(self, *, wake_word: bool, start: int | None = None) -> AsyncIterator[Heard]:
        with self._mic.tap(start) as audio:
            async for event in self._listener.listen(audio, wake_word=wake_word):
                yield event

    async def _idle(self) -> State:
        hearing = self._hear(wake_word=True)
        async for event in hearing:
            if isinstance(event, WakeWord):
                return Waking(hearing)
        return Idle()

    def _waking(self, state: Waking) -> State:
        on_headphones = self._speaker.device in self._settings.headphones
        tier = Tier.PERSONAL if on_headphones else Tier.ROOM
        self._trace.mark("wake_detected", tier=tier.value, output=self._speaker.device)
        opening = asyncio.create_task(self._head.open(tier.value))
        self._in_background(self._warm_voice())
        return Listening(Conversation(tier, on_headphones, opening), state.hearing)

    async def _listening(self, state: Listening) -> State:
        return await self._utterance(state.conversation, state.hearing, second_chance=True)

    async def _follow_up(self, state: FollowUp) -> State:
        hearing = self._hear(wake_word=False, start=state.speech_began_at)
        return await self._utterance(state.conversation, hearing, second_chance=False)

    async def _utterance(
        self, conversation: Conversation, hearing: AsyncIterator[Heard], *, second_chance: bool
    ) -> State:
        speech_started = False
        try:
            async with asyncio.timeout(self._settings.follow_up_seconds) as deadline:
                async for event in hearing:
                    match event:
                        case SpeechStarted():
                            speech_started = True
                            deadline.reschedule(asyncio.get_running_loop().time() + self._settings.stall_seconds)
                        case Transcript(text=text):
                            self._trace.mark("stt_final", text=text)
                            return Thinking(conversation, text)
                        case Unintelligible() if second_chance:
                            return FollowUp(conversation)
                        case Unintelligible():
                            break
        except TimeoutError:
            if speech_started:
                raise
        finally:
            await hearing.aclose()
        return self._end_in_background(conversation, "silence")

    async def _thinking(self, state: Thinking) -> State:
        reply = Reply()
        reply.composing = asyncio.create_task(self._compose(state.conversation, state.text, reply))
        first = await reply.clips.get()
        if first is None:
            return await self._after(state.conversation, reply)
        return Speaking(state.conversation, reply, first)

    async def _compose(self, conversation: Conversation, text: str, reply: Reply) -> None:
        sentences = 0
        try:
            async for part in self._head.turn(await conversation.id, text):
                match part:
                    case Sentence(text=sentence):
                        sentences += 1
                        if sentences == 1:
                            self._trace.mark("head_first_sentence")
                        clip = await self._synthesizer.synthesize(sentence)
                        if sentences == 1:
                            self._trace.mark("tts_first_audio", seconds=round(clip.seconds, 2))
                        reply.clips.put_nowait((sentence, clip))
                    case Done(end_conversation=end):
                        reply.end_conversation = end
        finally:
            reply.clips.put_nowait(None)

    async def _speaking(self, state: Speaking) -> State:
        conversation, reply = state.conversation, state.reply
        heard: list[str] = []
        playing = asyncio.create_task(self._play(reply, state.first, heard))
        interruption = asyncio.create_task(self._interruption(conversation))
        try:
            await asyncio.wait({playing, interruption}, return_when=asyncio.FIRST_COMPLETED)
            if not interruption.done():
                await playing
                return await self._after(conversation, reply)
            reply.cut = True
            self._speaker.stop()
            reply.composing.cancel()
            await playing
            heard_text = " ".join(heard)
            self._trace.mark("barge_in", heard=heard_text)
            await self._head.interrupt(await conversation.id, heard_text)
            return interruption.result()
        finally:
            for task in (playing, interruption):
                task.cancel()
            await asyncio.wait({playing, interruption})

    async def _play(self, reply: Reply, first: tuple[str, Clip], heard: list[str]) -> None:
        self._trace.mark("playback_start")
        item: tuple[str, Clip] | None = first
        while item is not None and not reply.cut:
            sentence, clip = item
            fraction = await self._speaker.play(clip)
            words = sentence.split()
            heard.append(" ".join(words[: round(len(words) * fraction)]))
            if fraction < 1.0:
                break
            item = await reply.clips.get()
        self._trace.mark("playback_stop", cut=reply.cut)

    async def _interruption(self, conversation: Conversation) -> State:
        if conversation.on_headphones:
            gate = SpeechGate(self._settings.barge_in_seconds)
            with self._mic.tap() as audio:
                while (frame := await audio.get()) is not None:
                    if gate.feed(self._voice.is_speech(frame)):
                        lead = gate.heard_seconds + PREROLL_MARGIN_SECONDS
                        return FollowUp(conversation, self._mic.position - round(lead / FRAME_SECONDS))
        else:
            while not self._mic.ended:
                hearing = self._hear(wake_word=True)
                try:
                    async for event in hearing:
                        if isinstance(event, WakeWord):
                            return Listening(conversation, hearing)
                except asyncio.CancelledError:
                    await hearing.aclose()
                    raise
        return await asyncio.Future()

    async def _after(self, conversation: Conversation, reply: Reply) -> State:
        await reply.composing
        if reply.end_conversation:
            return self._end_in_background(conversation, "end_phrase")
        return FollowUp(conversation)

    def _end_in_background(self, conversation: Conversation, reason: str) -> State:
        self._trace.mark("conversation_end", reason=reason)
        self._in_background(self._tell_head_it_ended(conversation, reason))
        return Idle()

    def _in_background(self, work: Coroutine[None, None, None]) -> None:
        task = asyncio.create_task(work)
        self._background.add(task)
        task.add_done_callback(self._background.discard)

    async def _warm_voice(self) -> None:
        try:
            await self._synthesizer.synthesize(WARM_UP)
        except Exception:
            log.exception("could not warm the voice up")

    async def _tell_head_it_ended(self, conversation: Conversation, reason: str) -> None:
        try:
            await self._head.end(await conversation.id, reason)
            self._trace.mark("head_ended")
        except Exception:
            log.exception("could not end the conversation with the head")

    async def _apologize(self) -> None:
        try:
            await self._speaker.play(await self._synthesizer.synthesize(APOLOGY))
        except Exception:
            log.exception("could not say that something went wrong")
