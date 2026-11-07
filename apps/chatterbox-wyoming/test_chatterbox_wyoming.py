import sys
import types
import unittest
import weakref
from unittest import mock

from chatterbox_wyoming import SynthesisError, Voice

FAKE_TORCH = types.SimpleNamespace(
    cuda=types.SimpleNamespace(synchronize=lambda: None, empty_cache=lambda: None, memory_reserved=lambda: 0)
)


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


if __name__ == "__main__":
    unittest.main()
