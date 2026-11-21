import sys
import asyncio
import http.client
import json
import threading
import types
import unittest
import weakref
from http.server import ThreadingHTTPServer
from unittest import mock

import numpy as np

from chatterbox_wyoming import MODEL_RATE, SynthesisError, Voice, WyomingHandler, http_handler, louder, reaper, time_stretch
from wyoming.tts import Synthesize


class CudaOutOfMemoryError(RuntimeError):
    pass


FAKE_TORCH = types.SimpleNamespace(
    cuda=types.SimpleNamespace(
        synchronize=lambda: None,
        empty_cache=lambda: None,
        memory_reserved=lambda: 0,
        OutOfMemoryError=CudaOutOfMemoryError,
    )
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

    def test_unload_between_http_sentence_groups(self):
        gap, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        self.voice.model = object()
        self.voice._synthesize = lambda text: np.array([0.1])
        speak = self.voice.speak
        calls = []

        def pause_before_second(text):
            calls.append(text)
            if len(calls) == 2:
                gap.set()
                if not release.wait(3):
                    raise TimeoutError("sentence gap")
            return speak(text)

        self.voice.speak = pause_before_second
        responses = []

        def request():
            connection = http.client.HTTPConnection(*self.server.server_address, timeout=5)
            try:
                connection.request("POST", "/tts", body="First. Second.")
                response = connection.getresponse()
                responses.append(response.status)
                response.read()
            finally:
                connection.close()

        thread = threading.Thread(target=request)
        thread.start()
        self.addCleanup(thread.join)
        self.assertTrue(gap.wait(3))
        self.assertEqual(self.voice.pending, 0)
        self.assertEqual(self.unload(), (409, {"error": "synthesis in progress or queued"}))
        self.assertIsNotNone(self.voice.model)
        release.set()
        thread.join(timeout=3)
        self.assertEqual(responses, [200])
        self.assertEqual(self.unload(), (200, {"unloaded": True}))

    def test_idle_reaper_and_status_respect_request(self):
        self.voice.model = object()
        with self.voice.request():
            self.assertTrue(self.voice.status()["busy"])
            self.voice.worker.submit(self.voice.unload_if_idle).result(timeout=3)
            self.assertIsNotNone(self.voice.model)
        self.assertFalse(self.voice.status()["busy"])
        self.voice.last_used = 0
        self.voice.worker.submit(self.voice.unload_if_idle).result(timeout=3)
        self.assertIsNone(self.voice.model)

    def test_http_failure_releases_request(self):
        self.voice._synthesize = mock.Mock(side_effect=RuntimeError("failed"))
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        self.addCleanup(connection.close)
        connection.request("POST", "/tts", body="Hello.")
        response = connection.getresponse()
        self.assertEqual(response.status, 500)
        response.read()
        self.assertEqual(self.unload(), (200, {"unloaded": False}))

    def test_wyoming_cancellation_releases_request(self):
        async def run():
            handler = object.__new__(WyomingHandler)
            handler.voice = self.voice
            entered = asyncio.Event()

            async def write_event(event):
                entered.set()
                await asyncio.Event().wait()

            handler.write_event = write_event
            task = asyncio.create_task(handler.handle_event(Synthesize(text="Hello.").event()))
            await entered.wait()
            self.assertTrue(self.voice.status()["busy"])
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

        asyncio.run(run())
        self.assertEqual(self.unload(), (200, {"unloaded": False}))

    def test_cancelled_queued_group_releases_pending(self):
        started, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        self.voice.worker.submit(lambda: (started.set(), release.wait(3)))
        self.assertTrue(started.wait(3))
        future = self.voice.speak("queued")
        self.assertTrue(future.cancel())
        self.assertEqual(self.voice.pending, 0)
        release.set()
        self.assertEqual(self.unload(), (200, {"unloaded": False}))

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


class ColdLoadTest(unittest.TestCase):
    def setUp(self):
        self.runtime = types.SimpleNamespace(OptimizedTurboVoice=mock.Mock())
        self.enterContext(mock.patch.dict(sys.modules, torch=FAKE_TORCH, optimized_voice=self.runtime))
        self.enterContext(mock.patch("chatterbox_wyoming.gpu_stats", return_value={"free_vram_gb": 0}))
        self.now = 0.0
        self.enterContext(mock.patch("chatterbox_wyoming.time.monotonic", side_effect=lambda: self.now))
        self.sleep = self.enterContext(mock.patch("chatterbox_wyoming.time.sleep", side_effect=self.advance))
        self.voice = Voice("", 0, 600)
        self.addCleanup(self.voice.worker.shutdown)
        self.model = mock.Mock()
        self.model.speak.return_value = np.array([0.1])
        self.runtime.OptimizedTurboVoice.return_value = self.model

    def advance(self, seconds):
        self.now += seconds

    def speak(self):
        with self.voice.request():
            result = self.voice.speak("Hello.").result(timeout=3)
        self.assertEqual(self.voice.pending, 0)
        self.assertFalse(self.voice.status()["busy"])
        return result

    def test_normal_load_and_warm_synthesis_never_wait(self):
        self.speak()
        self.speak()
        self.runtime.OptimizedTurboVoice.assert_called_once_with()
        self.sleep.assert_not_called()
        self.assertIs(self.voice.model, self.model)

    def enable_cpu_cache(self):
        self.voice.retain_cpu_model = True
        self.cache = mock.Mock()
        self.cache.reload.return_value = self.model
        self.adapter = mock.Mock(return_value=self.cache)
        self.enterContext(mock.patch.dict(sys.modules, resident_voice=types.SimpleNamespace(ResidentVoice=self.adapter)))

    def test_unloaded_model_serves_the_next_call_without_construction(self):
        self.enable_cpu_cache()
        first = self.speak()
        self.assertTrue(self.voice.unload().result(timeout=3))
        self.assertFalse(self.voice.status()["loaded"])
        self.assertTrue(self.voice.status()["cpu_cached"])
        np.testing.assert_array_equal(self.speak(), first)
        self.assertFalse(self.voice.status()["cpu_cached"])
        self.runtime.OptimizedTurboVoice.assert_called_once_with()

    def test_startup_prepares_cpu_cache_and_releases_gpu(self):
        self.enable_cpu_cache()
        self.voice.worker.submit(self.voice.prepare).result(timeout=3)
        self.assertFalse(self.voice.status()["loaded"])
        self.assertTrue(self.voice.status()["cpu_cached"])
        self.speak()
        self.runtime.OptimizedTurboVoice.assert_called_once_with()

    def test_idle_unload_keeps_cpu_cache(self):
        self.enable_cpu_cache()
        self.speak()
        self.advance(601)
        self.voice.worker.submit(self.voice.unload_if_idle).result(timeout=3)
        self.assertFalse(self.voice.status()["loaded"])
        self.assertTrue(self.voice.status()["cpu_cached"])
        self.speak()
        self.runtime.OptimizedTurboVoice.assert_called_once_with()

    def test_failed_cached_synthesis_discards_cpu_model(self):
        self.enable_cpu_cache()
        self.speak()
        self.voice.unload().result(timeout=3)
        self.model.speak.side_effect = RuntimeError("broken synthesis")
        with self.assertRaisesRegex(SynthesisError, "broken synthesis"):
            self.speak()
        self.assertFalse(self.voice.status()["loaded"])
        self.assertFalse(self.voice.status()["cpu_cached"])
        self.model.speak.side_effect = None
        self.speak()
        self.assertEqual(self.runtime.OptimizedTurboVoice.call_count, 2)

    def test_failed_offload_discards_model_and_allows_reload(self):
        self.enable_cpu_cache()
        self.speak()
        self.cache.offload.side_effect = RuntimeError("offload failed")
        with self.assertRaisesRegex(SynthesisError, "offload failed"):
            self.voice.unload().result(timeout=3)
        self.assertFalse(self.voice.status()["loaded"])
        self.assertFalse(self.voice.status()["cpu_cached"])
        self.speak()
        self.assertEqual(self.runtime.OptimizedTurboVoice.call_count, 2)

    def test_idle_offload_failure_does_not_stop_server_upkeep(self):
        self.enable_cpu_cache()
        self.speak()
        self.advance(601)
        self.cache.offload.side_effect = RuntimeError("offload failed")

        async def run():
            with mock.patch("chatterbox_wyoming.asyncio.sleep", new=mock.AsyncMock(
                    side_effect=[None, None, asyncio.CancelledError])) as sleep:
                with self.assertRaises(asyncio.CancelledError):
                    await reaper(self.voice)
                self.assertEqual(sleep.await_count, 3)

        asyncio.run(run())
        self.assertFalse(self.voice.status()["loaded"])
        self.assertFalse(self.voice.status()["cpu_cached"])
        self.speak()
        self.assertEqual(self.runtime.OptimizedTurboVoice.call_count, 2)

    def test_reload_oom_discards_partial_cache_before_retry(self):
        self.enable_cpu_cache()
        self.speak()
        self.voice.unload().result(timeout=3)
        self.cache.reload.side_effect = CudaOutOfMemoryError("upload exhausted")
        self.speak()
        self.assertEqual(self.runtime.OptimizedTurboVoice.call_count, 2)
        self.assertFalse(self.voice.status()["cpu_cached"])

    def test_memory_recovers_after_renderer_exit(self):
        def load():
            self.assertTrue(self.voice.status()["busy"])
            self.assertIsNone(self.voice.unload())
            if self.now < 2.0:
                raise CudaOutOfMemoryError("CUDA out of memory")
            return self.model

        self.runtime.OptimizedTurboVoice.side_effect = load
        np.testing.assert_allclose(self.speak(), [0.1])
        self.assertEqual(self.now, 2.0)
        self.assertEqual(self.runtime.OptimizedTurboVoice.call_count, 5)

    def test_exhaustion_is_bounded_and_releases_request(self):
        self.runtime.OptimizedTurboVoice.side_effect = CudaOutOfMemoryError("CUDA out of memory")
        with self.assertRaisesRegex(SynthesisError, "CUDA out of memory"):
            self.speak()
        self.assertEqual(self.now, 5.0)
        self.assertEqual(self.runtime.OptimizedTurboVoice.call_count, 10)
        self.assertIsNone(self.voice.model)
        self.assertEqual(self.voice.pending, 0)
        self.assertFalse(self.voice.status()["busy"])

    def test_slow_failed_load_does_not_restart_after_deadline(self):
        def load():
            self.advance(6.0)
            raise CudaOutOfMemoryError("CUDA out of memory")

        self.runtime.OptimizedTurboVoice.side_effect = load
        with self.assertRaisesRegex(SynthesisError, "CUDA out of memory"):
            self.speak()
        self.runtime.OptimizedTurboVoice.assert_called_once_with()
        self.sleep.assert_not_called()

    def test_non_memory_load_failures_are_not_retried(self):
        for error in (ValueError("bad checkpoint"), RuntimeError("CUDA device error"), MemoryError("CPU memory")):
            with self.subTest(error=error):
                self.runtime.OptimizedTurboVoice.reset_mock()
                self.runtime.OptimizedTurboVoice.side_effect = error
                with self.assertRaisesRegex(SynthesisError, str(error)):
                    self.speak()
                self.runtime.OptimizedTurboVoice.assert_called_once_with()
                self.sleep.assert_not_called()
                self.assertIsNone(self.voice.model)

    def test_partial_model_is_collected_before_retry(self):
        partials = []

        class PartialModel:
            def __init__(self):
                partials.append(weakref.ref(self))
                self.cycle = self
                raise CudaOutOfMemoryError("CUDA out of memory")

        def load():
            if not partials:
                return PartialModel()
            self.assertIsNone(partials[0]())
            return self.model

        self.runtime.OptimizedTurboVoice.side_effect = load
        with mock.patch.object(FAKE_TORCH.cuda, "empty_cache") as empty_cache:

            def wait(seconds):
                self.assertIsNone(partials[0]())
                empty_cache.assert_called_once()
                self.advance(seconds)

            self.sleep.side_effect = wait
            self.speak()
        self.assertEqual(self.runtime.OptimizedTurboVoice.call_count, 2)

    def test_warm_synthesis_oom_is_not_retried(self):
        self.model.speak.side_effect = CudaOutOfMemoryError("CUDA out of memory")
        with self.assertRaisesRegex(SynthesisError, "CUDA out of memory"):
            self.speak()
        self.runtime.OptimizedTurboVoice.assert_called_once_with()
        self.model.speak.assert_called_once()
        self.sleep.assert_not_called()
        self.assertIsNone(self.voice.model)


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
