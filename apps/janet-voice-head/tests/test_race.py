import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from janet_voice_head.head import ApiError, Config, Head
from janet_voice_head.call_tools import CallControl
from janet_voice_head.merge import Hub
from tests.harness import FakeHub


class StubSession:
    session_id = "stub-session"
    account_email = None
    failure = None

    def __init__(self, *_, **__):
        self.call_control = CallControl()

    def wait_ready(self, _timeout):
        pass

    def turn(self, _text, _timeout):
        yield "Fine."

    def interrupt(self):
        pass

    def close(self):
        self.call_control.close()


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

    def stub_call(self):
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        config = Config(state_dir=root / "state", hub=Hub("http://unused", root / "token", root / "hub", str(root)),
                        main_cwd=str(root), warm_up=False)
        head = Head(config, StubSession)
        self.addCleanup(head.close)
        conv = head.open("phone-app", "guest", None)
        return head, conv, head._lives[conv].session

    def test_an_interrupt_after_the_goodbye_was_journaled_cancels_the_end_signal(self):
        head, conv, session = self.stub_call()

        def ask(*_):
            session.call_control.call("ask_to_end_call", {})
            return iter(())

        def end(*_):
            session.call_control.call("end_call", {})
            return iter(())

        with patch.object(session, "turn", side_effect=ask):
            head.turn(conv, "finished", lambda *_: None)
        events = []
        with patch.object(session, "turn", side_effect=end), patch.object(
                head, "_note_session", side_effect=lambda _: head.interrupt(conv, "Okay")):
            head.turn(conv, "nothing else", lambda name, data: events.append((name, data)))
        self.assertFalse(next(data for name, data in events if name == "done")["end_conversation"])

    def test_a_question_that_could_not_be_delivered_never_arms_hangup(self):
        head, conv, session = self.stub_call()

        def ask(*_):
            session.call_control.call("ask_to_end_call", {})
            return iter(())

        def disconnected(*_):
            raise BrokenPipeError()

        with patch.object(session, "turn", side_effect=ask):
            head.turn(conv, "finished", disconnected)

        def end(*_):
            self.assertTrue(session.call_control.call("end_call", {})["isError"])
            return iter(())

        events = []
        with patch.object(session, "turn", side_effect=end):
            head.turn(conv, "nothing else", lambda name, data: events.append((name, data)))
        self.assertFalse(next(data for name, data in events if name == "done")["end_conversation"])


if __name__ == "__main__":
    unittest.main()
