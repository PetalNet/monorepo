import asyncio
import json
import threading
import time
import unittest
from unittest import mock

import numpy as np

import janet_phone


def config():
    return janet_phone.Config(listen="", gateway="", stt="", tier="guest", channel="test", disclosure="")


class SynthesisTest(unittest.IsolatedAsyncioTestCase):
    async def test_speech_failure_interrupts_without_waiting_for_the_head_stream_to_end(self):
        release = threading.Event()

        def stream(*args):
            yield "sentence", {"text": "Fails."}
            release.wait(5)
            yield "done", {}

        gateway = mock.Mock()
        gateway.turn.side_effect = stream
        gateway.speech.side_effect = OSError("TTS failed")
        call = janet_phone.Call(mock.AsyncMock(ring=None), config(), gateway, "test")
        reply = asyncio.create_task(call.reply("hello", time.monotonic(), {"endpoint_ms": 0}))
        try:
            with self.assertRaisesRegex(OSError, "TTS failed"):
                await asyncio.wait_for(reply, .5)
            gateway.post.assert_called_once_with("/v1/conversations/test/interrupt", {"heard_text": ""})
        finally:
            release.set()
            reply.cancel()
            await asyncio.gather(reply, return_exceptions=True)

    async def test_speech_is_requested_in_order_while_the_previous_chunk_plays(self):
        first_started, release_first, second_started = threading.Event(), threading.Event(), threading.Event()
        requested = []
        gateway = mock.Mock()
        gateway.turn.return_value = iter([
            ("sentence", {"text": text}) for text in ("First.", "Second.", "Third.")
        ] + [("done", {})])

        def speech(text):
            requested.append(text)
            if text == "First.":
                first_started.set()
                release_first.wait(5)
            elif text == "Second.":
                second_started.set()
            return 16000, np.full(16000, 8000, dtype="<i2").tobytes()

        gateway.speech.side_effect = speech
        ws = mock.AsyncMock(ring=None)
        call = janet_phone.Call(ws, config(), gateway, "test")
        reply = asyncio.create_task(call.reply("hello", time.monotonic(), {"endpoint_ms": 0}))
        try:
            self.assertTrue(await asyncio.to_thread(first_started.wait, 2))
            await asyncio.sleep(.05)
            self.assertEqual(requested, ["First."])
            release_first.set()
            self.assertTrue(await asyncio.to_thread(second_started.wait, 2))
            self.assertFalse(reply.done())
            await reply
            self.assertEqual(requested, ["First.", "Second.", "Third."])
            words = [json.loads(args.args[0])["text"] for args in ws.send.call_args_list
                     if isinstance(args.args[0], str) and json.loads(args.args[0])["type"] == "words"]
            self.assertEqual(words, requested)
        finally:
            release_first.set()
            reply.cancel()
            await asyncio.gather(reply, return_exceptions=True)

    async def test_interruption_drops_queued_speech_and_next_reply_waits_for_inflight_request(self):
        started, release = threading.Event(), threading.Event()
        gateway = mock.Mock()
        gateway.turn.side_effect = [iter([("sentence", {"text": text}) for text in ("Old.", "Dropped.")]
                                        + [("done", {})]),
                                    iter([("sentence", {"text": "New."}), ("done", {})])]
        requested = []

        def speech(text):
            requested.append(text)
            if text == "Old.":
                started.set()
                release.wait(5)
            return 16000, np.full(1600, 8000, dtype="<i2").tobytes()

        gateway.speech.side_effect = speech
        call = janet_phone.Call(mock.AsyncMock(ring=None), config(), gateway, "test")
        old = asyncio.create_task(call.reply("old", time.monotonic(), {"endpoint_ms": 0}))
        new = None
        try:
            self.assertTrue(await asyncio.to_thread(started.wait, 2))
            old.cancel()
            await asyncio.gather(old, return_exceptions=True)
            new = asyncio.create_task(call.reply("new", time.monotonic(), {"endpoint_ms": 0}))
            await asyncio.sleep(.05)
            self.assertEqual(requested, ["Old."])
            release.set()
            await new
            self.assertEqual(requested, ["Old.", "New."])
            self.assertEqual(call.heard, ["New."])
        finally:
            release.set()
            for task in (old, new):
                if task is not None:
                    task.cancel()
            await asyncio.gather(*(task for task in (old, new) if task is not None), return_exceptions=True)


class TrimTest(unittest.IsolatedAsyncioTestCase):
    async def test_edges_are_trimmed_before_tone_and_word_timing(self):
        rate = 16000
        voice = np.full(rate, 8000, dtype="<i2")
        pcm = np.concatenate([np.zeros(3200, dtype="<i2"), voice, np.zeros(6400, dtype="<i2")]).tobytes()
        ws = mock.AsyncMock(ring=None)
        call = janet_phone.Call(ws, config(), mock.Mock(), "test")
        line = mock.Mock()
        line.render.side_effect = lambda count, phase: np.full((count, 1), .01)
        audio = asyncio.get_running_loop().create_future()
        audio.set_result((rate, pcm))
        with mock.patch.object(janet_phone, "make_line", return_value=line):
            await call.say("Quiet edges.", audio)
        frames = b"".join(args.args[0] for args in ws.send.call_args_list if isinstance(args.args[0], bytes))
        self.assertEqual(len(frames) // 2, int(1.25 * rate))
        self.assertTrue(np.all(np.frombuffer(frames, "<i2")[800:16800] == 8327))
        words = [json.loads(args.args[0]) for args in ws.send.call_args_list
                 if isinstance(args.args[0], str) and json.loads(args.args[0])["type"] == "words"][0]
        self.assertAlmostEqual(sum(word["d"] for word in words["words"]), 1.25, places=2)

    def test_fades_leave_interior_speech_and_short_or_silent_clips_intact(self):
        for rate in (16000, 24000, 44100):
            with self.subTest(rate=rate):
                quiet = np.full(rate // 5, 20, dtype="<i2")
                voice = np.full(rate, 8000, dtype="<i2")
                pcm = np.concatenate([quiet, voice, quiet, quiet]).tobytes()
                trimmed = np.frombuffer(janet_phone.trim_edges(pcm, rate), "<i2")
                self.assertEqual(len(trimmed), round(1.25 * rate))
                np.testing.assert_array_equal(trimmed[round(.05 * rate):round(1.05 * rate)], voice)
                self.assertEqual(trimmed[0], 0)
                self.assertEqual(trimmed[-1], 0)
                self.assertEqual(janet_phone.trim_edges(b"", rate), b"")
                self.assertEqual(janet_phone.trim_edges(quiet.tobytes(), rate), quiet.tobytes())
                self.assertEqual(janet_phone.trim_edges(voice[:3].tobytes(), rate), voice[:3].tobytes())

    def test_a_fade_shorter_than_five_ms_stays_inside_the_quiet_guard(self):
        voice = np.full(1600, 8000, dtype="<i2")
        pcm = np.concatenate([voice, np.array([20], dtype="<i2")]).tobytes()
        trimmed = np.frombuffer(janet_phone.trim_edges(pcm, 16000), "<i2")
        np.testing.assert_array_equal(trimmed[:1600], voice)
        self.assertEqual(trimmed[-1], 0)
