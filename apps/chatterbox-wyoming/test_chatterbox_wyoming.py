import sys
import http.client
import json
import threading
import types
import unittest
import weakref
from http.server import ThreadingHTTPServer
from unittest import mock

import numpy as np

from chatterbox_wyoming import MODEL_RATE, SynthesisError, Voice, http_handler, louder, time_stretch

FAKE_TORCH = types.SimpleNamespace(
    cuda=types.SimpleNamespace(synchronize=lambda: None, empty_cache=lambda: None, memory_reserved=lambda: 0)
)


class UnloadTest(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch.dict(sys.modules, torch=FAKE_TORCH))
        self.voice = Voice(runtime="", gpu_index=0, idle_unload=600)
        self.addCleanup(self.voice.worker.shutdown)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), http_handler(self.voice, "test"))
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def unload(self):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        self.addCleanup(connection.close)
        connection.request("POST", "/unload")
        response = connection.getresponse()
        return response.status, json.loads(response.read())

    def test_unloads_and_is_idempotent(self):
        class Model:
            pass

        self.voice.model = Model()
        reference = weakref.ref(self.voice.model)
        with mock.patch.object(FAKE_TORCH.cuda, "empty_cache") as empty_cache:
            self.assertEqual(self.unload(), (200, {"unloaded": True}))
            self.assertIsNone(reference())
            self.assertEqual(self.unload(), (200, {"unloaded": False}))
            empty_cache.assert_called_once()

    def test_refuses_active_and_queued_synthesis(self):
        started, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)

        def synthesize(text):
            started.set()
            self.assertTrue(release.wait(3))
            return np.array([0.1])

        self.voice._synthesize = synthesize
        first = self.voice.speak("first")
        self.assertTrue(started.wait(3))
        self.assertEqual(self.unload(), (409, {"error": "synthesis in progress or queued"}))
        second = self.voice.speak("second")
        self.assertEqual(self.unload(), (409, {"error": "synthesis in progress or queued"}))
        release.set()
        first.result(timeout=3)
        second.result(timeout=3)

    def test_refuses_queued_synthesis_before_worker_starts(self):
        started, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        self.voice.worker.submit(lambda: (started.set(), release.wait(3)))
        self.assertTrue(started.wait(3))
        self.voice._synthesize = lambda text: np.array([0.1])
        queued = self.voice.speak("queued")
        self.assertEqual(self.unload(), (409, {"error": "synthesis in progress or queued"}))
        release.set()
        queued.result(timeout=3)

    def test_synthesis_submitted_during_unload_waits_for_release(self):
        started, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        self.voice.model = object()
        original_unload = self.voice._unload

        def blocked_unload(reason):
            started.set()
            self.assertTrue(release.wait(3))
            original_unload(reason)

        self.voice._unload = blocked_unload
        self.voice._synthesize = lambda text: np.array([0.1]) if self.voice.model is None else self.fail("model still loaded")
        responses = []
        thread = threading.Thread(target=lambda: responses.append(self.unload()))
        thread.start()
        self.addCleanup(thread.join)
        self.assertTrue(started.wait(3))
        synthesis = self.voice.speak("after unload")
        self.assertFalse(synthesis.done())
        release.set()
        thread.join(timeout=3)
        self.assertEqual(responses, [(200, {"unloaded": True})])
        synthesis.result(timeout=3)


class FailedSynthesisTest(unittest.TestCase):
    def test_failed_model_is_gone_before_the_next_load(self):
        models: list[weakref.ref] = []
        alive_at_load: list[list[bool]] = []

        class FakeModel:
            def __init__(self):
                alive_at_load.append([ref() is not None for ref in models])
                models.append(weakref.ref(self))

            def speak(self, text, seed):
                raise MemoryError("CUDA out of memory")

        runtime = types.SimpleNamespace(OptimizedTurboVoice=FakeModel)
        self.enterContext(mock.patch.dict(sys.modules, torch=FAKE_TORCH, optimized_voice=runtime))
        voice = Voice(runtime="", gpu_index=0, idle_unload=600)

        failed, queued = voice.speak("One."), voice.speak("Two.")
        for future in (failed, queued):
            with self.assertRaises(SynthesisError) as caught:
                future.result()
            self.assertIn("CUDA out of memory", str(caught.exception))

        self.assertEqual(alive_at_load, [[], [False]])
        self.assertEqual([ref() for ref in models], [None, None])


class GainTest(unittest.TestCase):
    def test_quiet_speech_is_tripled_and_peaks_never_reach_full_scale(self):
        audio = np.array([0.0, 0.1, -0.2, 0.5, -0.9])
        out = louder(audio, 3.0)
        np.testing.assert_allclose(out[:3], [0.0, 0.3, -0.6])
        self.assertTrue(np.all(np.abs(out[3:]) < 1.0))
        self.assertGreater(abs(out[4]), abs(out[3]))
        self.assertEqual(np.sign(out[4]), -1)


class TempoTest(unittest.TestCase):
    def test_default_preserves_samples_exactly(self):
        audio = np.array([0.1, -0.2, 0.3], dtype=np.float32)
        self.assertIs(time_stretch(audio, 1.0), audio)

    def test_duration_changes_but_pitch_and_final_sound_survive(self):
        t = np.arange(MODEL_RATE * 2) / MODEL_RATE
        audio = (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
        for tempo in (0.5, 1.08, 1.15, 1.22, 2.0):
            with self.subTest(tempo=tempo):
                out = time_stretch(audio, tempo)
                self.assertAlmostEqual(len(out), round(len(audio) / tempo), delta=2048)
                self.assertTrue(np.all(np.isfinite(out)))
                # A resampling-only implementation would move the tone to 220 * tempo Hz.
                middle = out[len(out) // 4 : 3 * len(out) // 4]
                spectrum = np.abs(np.fft.rfft(middle * np.hanning(len(middle))))
                pitch = np.fft.rfftfreq(len(middle), 1 / MODEL_RATE)[np.argmax(spectrum)]
                self.assertAlmostEqual(pitch, 220, delta=2)
                self.assertGreater(np.sqrt(np.mean(out[-1000:] ** 2)), 0.1)

    def test_empty_and_short_audio(self):
        for length in (0, 1, 100, 1023):
            audio = np.zeros(length, dtype=np.float32)
            out = time_stretch(audio, 1.08)
            self.assertEqual(len(out), round(length / 1.08))
            self.assertTrue(np.all(out == 0))

    def test_distinct_final_consonant_is_not_trimmed(self):
        rng = np.random.default_rng(42)
        for duration in (2, 30):
            audio = np.zeros(MODEL_RATE * duration, dtype=np.float32)
            # Isolate a final unvoiced consonant from all earlier sound.
            audio[-441:] = rng.normal(0, 0.1, 441)
            for tempo in (1.08, 1.15, 1.22):
                with self.subTest(duration=duration, tempo=tempo):
                    out = time_stretch(audio, tempo)
                    self.assertGreater(np.sum(out**2), 0.1)
        out = time_stretch(np.array([0.5], dtype=np.float32), 1.08)
        self.assertGreater(np.max(np.abs(out)), 0.1)

    def test_invalid_config_is_rejected_before_worker_starts(self):
        for tempo in (0, -1, 0.49, 2.01, float("nan"), float("inf")):
            with self.subTest(tempo=tempo), self.assertRaises(ValueError):
                Voice("", 0, 600, tempo=tempo)

    def test_voice_stretches_before_gain(self):
        audio = np.sin(np.arange(MODEL_RATE) * 2 * np.pi * 220 / MODEL_RATE).astype(np.float32) * 0.2
        voice = Voice("", 0, 600, gain=3.0, tempo=1.08)
        self.addCleanup(voice.worker.shutdown)
        with mock.patch.object(voice, "_synthesize", return_value=audio):
            out = voice.speak("Hello.").result()
        np.testing.assert_allclose(out, louder(time_stretch(audio, 1.08), 3.0))


if __name__ == "__main__":
    unittest.main()
