import tempfile
import threading
import unittest
from pathlib import Path

from janet_voice_head.head import ApiError, Config, Head
from janet_voice_head.merge import Hub
from tests.harness import FakeHub


class StubSession:
    session_id = "stub-session"
    account_email = None
    failure = None

    def __init__(self, *_, **__):
        pass

    def wait_ready(self, _timeout):
        pass

    def turn(self, _text, _timeout):
        yield "Fine."

    def interrupt(self):
        pass

    def close(self):
        pass


class GatedHead(Head):
    gate = threading.Event()

    def _open_live(self, conv_id):
        live = super()._open_live(conv_id)
        self.gate.wait(10)
        return live


class TurnRacingEndTest(unittest.TestCase):
    def test_a_turn_that_loses_the_race_with_end_is_refused_and_never_journaled_after_archived(self):
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        hub = FakeHub(root)
        self.addCleanup(hub.server.shutdown)
        (root / "hub-token").write_text("t\n")
        config = Config(state_dir=root / "state", hub=Hub(hub.url, root / "hub-token", hub.state_file, str(root)), main_cwd=str(root))
        head = GatedHead(config, StubSession)
        self.addCleanup(head.close)
        conv = head.open("desk", "guest", None)
        head.gate.set()
        head.turn(conv, "first", lambda *_: None)
        head.gate.clear()
        errors = []

        def late_turn():
            try:
                head.turn(conv, "second", lambda *_: None)
            except ApiError as error:
                errors.append(error.status)

        thread = threading.Thread(target=late_turn)
        thread.start()
        head.end(conv, "client")
        head.gate.set()
        thread.join(10)
        self.assertEqual(errors, [409])
        records = (root / "state" / "conversations" / f"{conv}.jsonl").read_text().splitlines()
        self.assertEqual(sum('"kind": "exchange"' in line for line in records), 1)
        self.assertIn('"kind": "archived"', records[-1])
        self.assertIn("1. Speaker: first", hub.texts("voice-hard")[0])
        self.assertNotIn("second", hub.texts("voice-hard")[0])


if __name__ == "__main__":
    unittest.main()
