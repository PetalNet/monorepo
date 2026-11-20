import sys
import threading

from tests.harness import HeadCase


class CallLifecycleTest(HeadCase):
    def configure_unload(self, **overrides):
        self.stop_head()
        self.unloaded = self.root / "unloaded"
        self.busy = self.root / "tts-busy"
        worker = self.root / "unload.py"
        worker.write_text(
            "from pathlib import Path\nimport sys\n"
            f"if Path({str(self.busy)!r}).exists(): sys.exit(1)\n"
            f"Path({str(self.unloaded)!r}).write_text('unloaded')\n"
        )
        self.start_head(tts_unload_command=[sys.executable, str(worker)], **overrides)

    def test_call_state_requires_authentication(self):
        self.assertEqual(self.request("GET", "/v1/calls", token=None)[0], 401)
        self.assertEqual(self.request("GET", "/v1/calls", token="wrong")[0], 401)
        self.assertEqual(self.request("GET", "/v1/calls")[1], {"active_calls": 0})

    def test_last_call_releases_tts_for_each_client_channel(self):
        self.configure_unload()
        for channel in ("phone-app", "desk", "gateway"):
            with self.subTest(channel=channel):
                conv = self.open(channel=channel)
                self.assertEqual(self.request("GET", "/v1/calls")[1], {"active_calls": 1})
                self.end(conv)
                self.assertEqual(self.request("GET", "/v1/calls")[1], {"active_calls": 0})
                self.assertTrue(self.unloaded.exists())
                self.unloaded.unlink()

    def test_another_live_call_keeps_tts_loaded(self):
        self.configure_unload()
        first, second = self.open(), self.open()
        self.end(first)
        self.assertEqual(self.request("GET", "/v1/calls")[1], {"active_calls": 1})
        self.assertFalse(self.unloaded.exists())
        self.end(second)
        self.assertTrue(self.unloaded.exists())

    def test_busy_tts_is_retried_without_waiting_for_idle_unload(self):
        self.configure_unload()
        conv = self.open()
        self.busy.touch()
        self.end(conv)
        self.assertFalse(self.unloaded.exists())
        self.busy.unlink()
        self.wait_for(self.unloaded.exists, "TTS unload was not retried")

    def test_idle_timeout_releases_tts(self):
        self.configure_unload(idle_timeout_s=0.1)
        self.open()
        self.wait_for(self.unloaded.exists, "idle timeout did not unload TTS")
        self.assertEqual(self.request("GET", "/v1/calls")[1], {"active_calls": 0})

    def test_shutdown_releases_tts(self):
        self.configure_unload()
        self.open()
        self.stop_head()
        self.assertTrue(self.unloaded.exists())

    def test_merge_failure_does_not_keep_gpu_reserved(self):
        self.configure_unload()
        conv = self.open()
        self.turn(conv, "hello")
        self.hub.down = True
        self.assertEqual(self.request("POST", f"/v1/conversations/{conv}/end", {"reason": "hangup"})[0], 503)
        self.assertEqual(self.request("GET", "/v1/calls")[1], {"active_calls": 0})
        self.assertTrue(self.unloaded.exists())

    def test_restart_recovery_releases_tts(self):
        self.configure_unload()
        self.open()
        self.kill_head()
        self.configure_unload()
        self.wait_for(self.unloaded.exists, "recovered call did not release TTS")
        self.assertEqual(self.request("GET", "/v1/calls")[1], {"active_calls": 0})

    def test_slow_summary_does_not_delay_gpu_release(self):
        self.claude_extra = ["--fake-slow-summary"]
        self.configure_unload()
        conv = self.open()
        self.turn(conv, "hello")
        self.turn(conv, "more")
        ending = threading.Thread(target=self.end, args=(conv,))
        ending.start()
        try:
            self.wait_for(lambda: "conversation is over" in self.claude_log.read_text(), "summary never started")
            self.assertTrue(ending.is_alive())
            self.assertTrue(self.unloaded.exists(), "GPU release waited for the model's summary")
        finally:
            ending.join(timeout=10)
