import asyncio
import unittest
from collections.abc import AsyncIterator

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
    def __init__(self, script: list[MicStep], output: str = HEADPHONES, listener: FakeAssist | None = None):
        self.head = FakeHead(REPLIES)
        self.speaker = RecordingSpeaker(output, PACE)
        self.trace = Trace()
        mic = ScriptedMic(script, PACE)
        self.trace.observers.append(lambda record: mic.notice(record["event"]))
        self.voice = voice = FakeVoice()
        self.client = DeskClient(
            mic=MicHub(mic),
            listener=listener or FakeAssist(),
            head=self.head,
            synthesizer=voice,
            speaker=self.speaker,
            voice=voice,
            settings=Settings(headphones=frozenset({HEADPHONES}), follow_up_seconds=6 * PACE, stall_seconds=10 * PACE),
            trace=self.trace,
        )

    async def run(self) -> "Desk":
        await asyncio.wait_for(self.client.run(), 20)
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
