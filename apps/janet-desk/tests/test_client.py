import asyncio
import contextlib
import tempfile
import unittest
from collections.abc import AsyncIterator
from pathlib import Path

from janet_desk.__main__ import stop_when_file_appears
from janet_desk.audio import FRAME_SECONDS, Clip, MicHub, MicStep, RecordingSpeaker, Say, ScriptedMic, Silence, WaitFor
from janet_desk.client import (
    APOLOGY,
    WARM_UP,
    DeskClient,
    Heard,
    Settings,
    SpeechStarted,
    Trace,
    Transcript,
    Unintelligible,
    WakeWord,
)
from janet_desk.head import Done, Sentence
from janet_desk.tts import WyomingSynthesizer

PACE = 0.05
HEADPHONES = "Headphones"
SECONDS_PER_WORD = 0.5


def sound(code: int, seconds: float) -> Say:
    return Say(code.to_bytes(2, "little") * round(seconds * 16000))


WAKE = sound(1, 0.5)
QUESTION = sound(2, 0.6)
FOLLOW_UP = sound(3, 0.6)
GOODBYE = sound(4, 0.6)
COUGH = sound(9, 2 * FRAME_SECONDS)
UTTERANCES = {2: "what time is it", 3: "and tomorrow", 4: "that's all"}


def code_of(frame: bytes) -> int:
    return int.from_bytes(frame[:2], "little")


class FakeAssist:
    async def listen(self, audio: asyncio.Queue[bytes | None], *, wake_word: bool) -> AsyncIterator[Heard]:
        awake = not wake_word
        utterance, heard_frames, quiet_frames = 0, 0, 0
        while (frame := await audio.get()) is not None:
            code = code_of(frame)
            if not awake:
                if code == code_of(WAKE.pcm):
                    awake = True
                    yield WakeWord()
            elif code in UTTERANCES:
                if not utterance:
                    yield SpeechStarted()
                utterance, heard_frames, quiet_frames = code, heard_frames + 1, 0
            elif utterance:
                quiet_frames += 1
                if quiet_frames == 5:
                    whole = heard_frames * FRAME_SECONDS >= 0.55
                    yield Transcript(UTTERANCES[utterance]) if whole else Unintelligible()
                    return


class StalledAssist(FakeAssist):
    async def listen(self, audio: asyncio.Queue[bytes | None], *, wake_word: bool) -> AsyncIterator[Heard]:
        async for event in super().listen(audio, wake_word=wake_word):
            if isinstance(event, Transcript | Unintelligible):
                await asyncio.Future()
            yield event


class FakeHead:
    def __init__(self, replies: dict[str, tuple[list[str], bool]]):
        self.replies = replies
        self.calls: list[tuple] = []

    async def open(self, tier: str) -> str:
        self.calls.append(("open", tier))
        return "c1"

    async def turn(self, conversation: str, text: str) -> AsyncIterator[Sentence | Done]:
        self.calls.append(("turn", conversation, text))
        sentences, end_conversation = self.replies[text]
        for sentence in sentences:
            yield Sentence(sentence)
        yield Done(end_conversation)

    async def interrupt(self, conversation: str, heard_text: str) -> None:
        self.calls.append(("interrupt", conversation, heard_text))

    async def end(self, conversation: str, reason: str) -> None:
        self.calls.append(("end", conversation, reason))


class FlakyEnd(FakeHead):
    def __init__(self, failures: int):
        super().__init__(REPLIES)
        self.failures = failures

    async def end(self, conversation: str, reason: str) -> None:
        self.calls.append(("end", conversation, reason))
        if len([call for call in self.calls if call[0] == "end"]) <= self.failures:
            raise ConnectionError("head unreachable")


class HungAfterFirstSentence(FakeHead):
    def __init__(self) -> None:
        super().__init__(REPLIES)
        self.stream_closed = False

    async def turn(self, conversation: str, text: str) -> AsyncIterator[Sentence | Done]:
        self.calls.append(("turn", conversation, text))
        try:
            yield Sentence(ANSWER)
            await asyncio.Future()
        finally:
            self.stream_closed = True


class HungHead(FakeHead):
    async def turn(self, conversation: str, text: str) -> AsyncIterator[Sentence | Done]:
        self.calls.append(("turn", conversation, text))
        await asyncio.Future()
        yield Done(False)


class BrokenSpeaker(RecordingSpeaker):
    async def play(self, clip: Clip) -> float:
        raise OSError("output device gone")


class UnpluggedMic:
    def __init__(self, inner: ScriptedMic):
        self._inner = inner

    async def __aiter__(self) -> AsyncIterator[bytes]:
        async for frame in self._inner:
            yield frame
        raise OSError("microphone unplugged")


class FakeVoice:
    def __init__(self) -> None:
        self.synthesized: list[str] = []

    async def synthesize(self, text: str) -> Clip:
        self.synthesized.append(text)
        return Clip(bytes(round(len(text.split()) * SECONDS_PER_WORD * 1000) * 2), rate=1000)

    def is_speech(self, frame: bytes) -> bool:
        return any(frame)


ANSWER = "it is nine in the morning right now"
REPLIES = {
    "what time is it": ([ANSWER, "anything else"], False),
    "and tomorrow": (["tomorrow is friday"], False),
    "that's all": (["okay"], True),
}


class Desk:
    def __init__(
        self,
        script: list[MicStep],
        output: str = HEADPHONES,
        listener: FakeAssist | None = None,
        head: FakeHead | None = None,
        speaker: RecordingSpeaker | None = None,
        unplug: bool = False,
        **settings: object,
    ):
        self.head = head or FakeHead(REPLIES)
        self.speaker = speaker or RecordingSpeaker(output, PACE)
        self.trace = Trace()
        mic = ScriptedMic(script, PACE)
        self.trace.observers.append(lambda record: mic.notice(record["event"]))
        self.reached: dict[str, asyncio.Event] = {}
        self.trace.observers.append(lambda record: self.reached.setdefault(record["event"], asyncio.Event()).set())
        self.voice = voice = FakeVoice()
        self.client = DeskClient(
            mic=MicHub(UnpluggedMic(mic) if unplug else mic),
            listener=listener or FakeAssist(),
            head=self.head,
            synthesizer=voice,
            speaker=self.speaker,
            voice=voice,
            settings=Settings(
                headphones=frozenset({HEADPHONES}),
                **{
                    "follow_up_seconds": 6 * PACE,
                    "stall_seconds": 10 * PACE,
                    "end_retry_seconds": (PACE, PACE),
                    **settings,
                },
            ),
            trace=self.trace,
        )

    async def run(self) -> "Desk":
        await asyncio.wait_for(self.client.run(), 20)
        return self

    async def cancelled_at(self, event: str) -> "Desk":
        running = asyncio.create_task(self.client.run())
        await asyncio.wait_for(self.reached.setdefault(event, asyncio.Event()).wait(), 20)
        running.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await running
        return self

    def played_seconds(self) -> float:
        return sum(clip.seconds for clip in self.speaker.played)

    def events(self) -> list[str]:
        return [record["event"] for record in self.trace.records]


def seconds_of(*sentences: str) -> float:
    return sum(len(sentence.split()) for sentence in sentences) * SECONDS_PER_WORD


class ConversationTest(unittest.IsolatedAsyncioTestCase):
    async def test_wake_word_and_question_get_a_spoken_answer(self):
        desk = await Desk([Silence(0.3), WAKE, QUESTION, WaitFor("playback_stop")]).run()

        self.assertEqual(desk.head.calls[:2], [("open", "personal"), ("turn", "c1", "what time is it")])
        self.assertAlmostEqual(desk.played_seconds(), seconds_of(ANSWER, "anything else"), places=2)
        states = [event for event in desk.events() if event in ("idle", "waking", "listening", "thinking", "speaking")]
        self.assertEqual(states[:5], ["idle", "waking", "listening", "thinking", "speaking"])

    async def test_the_voice_is_warmed_at_the_wake_word_and_the_warm_up_is_not_played(self):
        desk = await Desk([Silence(0.3), WAKE, WaitFor("idle")]).run()

        self.assertEqual(desk.voice.synthesized, [WARM_UP])
        self.assertEqual(desk.speaker.played, [])

    async def test_speech_without_the_wake_word_is_ignored_while_idle(self):
        desk = await Desk([Silence(0.3), FOLLOW_UP, Silence(1.0)]).run()

        self.assertEqual(desk.head.calls, [])
        self.assertEqual(desk.speaker.played, [])
        self.assertEqual(desk.voice.synthesized, [])

    async def test_follow_up_needs_no_wake_word(self):
        desk = await Desk(
            [WAKE, QUESTION, WaitFor("playback_stop"), Silence(1.0), FOLLOW_UP, WaitFor("playback_stop")]
        ).run()

        turns = [call[2] for call in desk.head.calls if call[0] == "turn"]
        self.assertEqual(turns, ["what time is it", "and tomorrow"])
        self.assertEqual([call for call in desk.head.calls if call[0] == "open"], [("open", "personal")])
        self.assertAlmostEqual(
            desk.played_seconds(), seconds_of(ANSWER, "anything else", "tomorrow is friday"), places=2
        )

    async def test_silence_after_the_answer_ends_the_conversation(self):
        desk = await Desk([WAKE, QUESTION, WaitFor("idle"), Silence(0.5), FOLLOW_UP, Silence(1.0)]).run()

        self.assertEqual(desk.head.calls[-1], ("end", "c1", "silence"))
        self.assertEqual([call[2] for call in desk.head.calls if call[0] == "turn"], ["what time is it"])

    async def test_the_heads_end_of_conversation_ends_it_without_waiting(self):
        desk = await Desk([WAKE, GOODBYE, WaitFor("idle"), Silence(0.5), FOLLOW_UP, Silence(1.0)]).run()

        self.assertEqual(desk.head.calls[-1], ("end", "c1", "end_phrase"))
        self.assertNotIn("follow_up", desk.events())
        self.assertAlmostEqual(desk.played_seconds(), seconds_of("okay"), places=2)

    async def test_wake_word_alone_waits_for_the_question(self):
        desk = await Desk([WAKE, Silence(1.5), QUESTION, WaitFor("playback_stop")]).run()

        self.assertEqual(desk.head.calls[:2], [("open", "personal"), ("turn", "c1", "what time is it")])

    async def test_wake_word_followed_by_silence_ends_the_conversation(self):
        desk = await Desk([WAKE, WaitFor("idle")]).run()

        self.assertEqual(desk.head.calls, [("open", "personal"), ("end", "c1", "silence")])
        self.assertEqual(desk.speaker.played, [])

    async def test_a_stalled_pipeline_ends_the_conversation_with_an_apology(self):
        desk = await Desk([WAKE, QUESTION, WaitFor("idle")], listener=StalledAssist()).run()

        self.assertEqual(desk.head.calls, [("open", "personal"), ("end", "c1", "error")])
        self.assertAlmostEqual(desk.played_seconds(), seconds_of(APOLOGY), places=2)


class ShutdownTest(unittest.IsolatedAsyncioTestCase):
    async def test_stopping_while_listening_for_a_follow_up_ends_the_conversation(self):
        script = [WAKE, QUESTION, WaitFor("follow_up"), Silence(30)]
        desk = await Desk(script, follow_up_seconds=100).cancelled_at("follow_up")

        self.assertEqual(desk.head.calls[-1], ("end", "c1", "client_exit"))

    async def test_stopping_while_speaking_ends_the_conversation(self):
        desk = await Desk([WAKE, QUESTION, WaitFor("playback_start"), Silence(30)]).cancelled_at("playback_start")

        self.assertEqual(desk.head.calls[-1], ("end", "c1", "client_exit"))
        self.assertEqual([call for call in desk.head.calls if call[0] == "end"], [("end", "c1", "client_exit")])

    async def test_stopping_while_idle_has_nothing_to_end(self):
        desk = await Desk([Silence(30)]).cancelled_at("idle")

        self.assertEqual(desk.head.calls, [])

    async def test_a_microphone_that_fails_stops_the_client_with_the_error_after_ending_the_conversation(self):
        desk = Desk([WAKE, QUESTION, WaitFor("playback_start")], unplug=True)

        with self.assertRaisesRegex(OSError, "unplugged"):
            await desk.run()

        self.assertEqual(desk.head.calls[-1], ("end", "c1", "client_exit"))

    async def test_a_failed_end_is_retried_and_then_succeeds(self):
        desk = await Desk([WAKE, WaitFor("head_ended")], head=FlakyEnd(failures=2)).run()

        self.assertEqual(desk.head.calls.count(("end", "c1", "silence")), 3)
        self.assertIn("head_ended", desk.events())

    async def test_a_head_that_never_takes_the_end_is_given_up_on_without_stopping_the_client(self):
        desk = await Desk([WAKE, WaitFor("idle")], head=FlakyEnd(failures=99)).run()

        self.assertEqual(desk.head.calls.count(("end", "c1", "silence")), 3)
        self.assertNotIn("head_ended", desk.events())

    async def test_the_stop_file_cancels_the_client(self):
        with tempfile.TemporaryDirectory() as folder:
            stop = Path(folder) / "stop"
            desk = Desk([WAKE, QUESTION, WaitFor("playback_start"), Silence(30)])
            running = asyncio.create_task(desk.client.run())
            watcher = asyncio.create_task(stop_when_file_appears(stop, running, interval=PACE))
            await asyncio.wait_for(desk.reached.setdefault("playback_start", asyncio.Event()).wait(), 20)
            stop.touch()
            await asyncio.wait_for(watcher, 5)
            with contextlib.suppress(asyncio.CancelledError):
                await running

            self.assertEqual(desk.head.calls[-1], ("end", "c1", "client_exit"))
            self.assertFalse(stop.exists())


class StallTest(unittest.IsolatedAsyncioTestCase):
    async def test_a_head_that_never_answers_ends_the_conversation_and_returns_to_idle(self):
        desk = await Desk([WAKE, QUESTION, WaitFor("idle")], head=HungHead(REPLIES), think_seconds=8 * PACE).run()

        self.assertEqual(desk.head.calls[-1], ("end", "c1", "error"))
        self.assertIn("error", desk.events())
        self.assertEqual(desk.events()[-1], "idle")

    async def test_an_error_while_speaking_stops_the_head_stream(self):
        head = HungAfterFirstSentence()
        desk = await Desk([WAKE, QUESTION, WaitFor("idle")], head=head, speaker=BrokenSpeaker(HEADPHONES, PACE)).run()

        self.assertTrue(head.stream_closed)
        self.assertEqual(desk.head.calls[-1], ("end", "c1", "error"))

    async def test_a_voice_server_that_never_answers_times_out(self):
        async def say_nothing(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            await reader.read()

        server = await asyncio.start_server(say_nothing, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        try:
            started = asyncio.get_running_loop().time()
            with self.assertRaises(TimeoutError):
                await asyncio.wait_for(WyomingSynthesizer("127.0.0.1", port, "janet", timeout=0.3).synthesize("hi"), 3)
            self.assertLess(asyncio.get_running_loop().time() - started, 1.5)
        finally:
            server.close()


class BargeInTest(unittest.IsolatedAsyncioTestCase):
    async def test_talking_over_the_answer_stops_it_and_becomes_the_next_turn(self):
        desk = await Desk([WAKE, QUESTION, WaitFor("playback_start"), Silence(1.0), FOLLOW_UP, WaitFor("idle")]).run()

        interrupts = [call for call in desk.head.calls if call[0] == "interrupt"]
        self.assertEqual(len(interrupts), 1)
        heard = interrupts[0][2]
        self.assertTrue(heard, "some of the answer was heard before the interruption")
        self.assertTrue(ANSWER.startswith(heard) and heard != ANSWER, f"heard {heard!r}")
        self.assertLess(desk.speaker.played[0].seconds, seconds_of(ANSWER) - 1.0)
        self.assertEqual(
            [call[2] for call in desk.head.calls if call[0] == "turn"], ["what time is it", "and tomorrow"]
        )
        self.assertAlmostEqual(
            desk.played_seconds(), desk.speaker.played[0].seconds + seconds_of("tomorrow is friday"), places=2
        )

    async def test_a_cough_does_not_stop_the_answer(self):
        desk = await Desk([WAKE, QUESTION, WaitFor("playback_start"), Silence(1.0), COUGH, WaitFor("idle")]).run()

        self.assertEqual([call for call in desk.head.calls if call[0] == "interrupt"], [])
        self.assertAlmostEqual(desk.played_seconds(), seconds_of(ANSWER, "anything else"), places=2)

    async def test_on_speakers_only_the_wake_word_interrupts(self):
        desk = await Desk(
            [
                WAKE,
                QUESTION,
                WaitFor("playback_start"),
                Silence(0.5),
                FOLLOW_UP,
                Silence(0.5),
                WAKE,
                FOLLOW_UP,
                WaitFor("idle"),
            ],
            output="Monitor speakers",
        ).run()

        self.assertEqual(desk.head.calls[0], ("open", "room"))
        interrupts = [call for call in desk.head.calls if call[0] == "interrupt"]
        self.assertEqual(len(interrupts), 1)
        self.assertGreater(desk.speaker.played[0].seconds, 1.5, "plain speech did not stop the answer")
        self.assertLess(desk.speaker.played[0].seconds, seconds_of(ANSWER))
        self.assertEqual(
            [call[2] for call in desk.head.calls if call[0] == "turn"], ["what time is it", "and tomorrow"]
        )


if __name__ == "__main__":
    unittest.main()
