"""Runs the real janet-talk script against the real voice gateway, with stand-ins for the
head, the voice server, and the Mac programs the script calls."""

import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

APP = Path(__file__).resolve().parent.parent
GATEWAY = APP.parent / "janet-voice-gateway"

_spec = importlib.util.spec_from_file_location("gateway_fakes", GATEWAY / "tests" / "fakes.py")
fakes = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fakes)

CF_SECRET = "cf-secret-value"

STUBS = {
    # The transcript and exit status come from files the test writes.
    # A start is logged once the recording has begun, which takes as long as the test says.
    "hex": '#!/usr/bin/env bash\n[ "$2" = start ] && sleep "$(cat "$STUB/hex-start-seconds")"\n'
    'echo "$*" >>"$STUB/hex.log"\n'
    'if [ "$2" = stop ]; then cat "$STUB/transcript"; exit "$(cat "$STUB/hex-status")"; fi\n'
    'if [ "$2" = start ]; then exit "$(cat "$STUB/hex-start-status")"; fi\n',
    # The secrets come from the test's environment, so none is written to disk.
    "security": '#!/usr/bin/env bash\n[ -e "$STUB/no-secrets" ] && exit 44\ncase "$5" in cf-access-client-id) echo cf-id;; '
    'cf-access-client-secret) echo "$STUB_CF_SECRET";; head-token) echo "$STUB_HEAD_TOKEN";; esac\n',
    # Appends the audio it was asked to play, then takes as long as the test says.
    "afplay": '#!/usr/bin/env bash\ntail -c +45 "$1" >>"$STUB/played"; echo >>"$STUB/played"\n'
    'sleep "$(cat "$STUB/afplay-seconds")"\n',
    "osascript": '#!/usr/bin/env bash\necho "$3" >>"$STUB/notifications"\n',
    "curl": '#!/usr/bin/env bash\necho "$*" >>"$STUB/curl-args"\nexec "$REAL_CURL" "$@"\n',
}


class TalkCase(unittest.TestCase):
    voice_up = True

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.stub = self.root / "stub"
        self.stub.mkdir()
        for name, text in STUBS.items():
            path = self.stub / name
            path.write_text(text)
            path.chmod(path.stat().st_mode | stat.S_IEXEC)
        (self.stub / "hex-status").write_text("0")
        (self.stub / "afplay-seconds").write_text("0")
        (self.stub / "hex-start-seconds").write_text("0")
        (self.stub / "hex-start-status").write_text("0")
        self.say("what time is it")

        self.head = fakes.FakeHead()
        self.head.release_turn.set()
        self.wake = fakes.WakeListener()
        self.voice_address = fakes.closed_port()
        self.voice = None
        if self.voice_up:
            self.start_voice()
        self.addCleanup(self.head.shutdown)
        self.addCleanup(self.wake.close)
        self.addCleanup(lambda: self.voice and self.voice.shutdown())

        port = fakes.closed_port().rpartition(":")[2]
        token_file = self.root / "token"
        token_file.touch(mode=0o600)
        token_file.write_text(fakes.TOKEN + "\n")
        (self.root / "gateway.toml").write_text(
            f'listen = ["127.0.0.1:{port}"]\ntoken_file = "{self.root / "token"}"\nhead = "{self.head.url}"\n'
            f'[voice]\nwyoming = "{self.voice_address}"\nname = "janet"\nmac = "{fakes.MAC}"\n'
            f'broadcast = "{self.wake.address}"\n'
        )
        self.gateway = subprocess.Popen(
            [sys.executable, str(GATEWAY / "janet_voice_gateway.py"), "--config", str(self.root / "gateway.toml")]
        )
        self.addCleanup(self.gateway.wait, 5)
        self.addCleanup(self.gateway.terminate)
        (self.root / "config").write_text(f'JANET_VOICE_URL="http://127.0.0.1:{port}"\n')
        real_curl = subprocess.run(["which", "curl"], capture_output=True, text=True, check=True).stdout.strip()
        self.env = {
            **os.environ,
            "PATH": f"{self.stub}:{os.environ['PATH']}",
            "STUB": str(self.stub),
            "REAL_CURL": real_curl,
            "STUB_CF_SECRET": CF_SECRET,
            "STUB_HEAD_TOKEN": fakes.TOKEN,
            "JANET_TALK_CONFIG": str(self.root / "config"),
            "JANET_TALK_STATE": str(self.root / "state"),
            "JANET_TALK_HEX": str(self.stub / "hex"),
            "JANET_TALK_RETRY_S": "0.2",
            "JANET_TALK_WAKE_WAIT_S": "20",
        }
        health = [real_curl, "-s", "-o", os.devnull, f"http://127.0.0.1:{port}/health"]
        self.wait_for(lambda: subprocess.run(health).returncode == 0)

    def start_voice(self):
        self.voice = fakes.FakeVoice(port=int(self.voice_address.rpartition(":")[2]))

    def wait_for(self, condition, seconds=10):
        deadline = time.monotonic() + seconds
        while not condition():
            self.assertLess(time.monotonic(), deadline, "timed out")
            time.sleep(0.05)

    def say(self, text):
        (self.stub / "transcript").write_text(text + "\n")

    def talk(self, action, wait=True, status=0):
        process = subprocess.Popen(["bash", str(APP / "janet-talk"), action], env=self.env)
        if wait:
            self.assertEqual(process.wait(60), status)
        return process

    def notified(self, expected):
        # The script posts notifications in the background, so they can land just after it exits.
        self.wait_for(lambda: len(self.lines("notifications")) >= len(expected), 3)
        time.sleep(0.2)
        self.assertEqual(self.lines("notifications"), expected)

    def lines(self, name):
        path = self.stub / name
        return path.read_text().splitlines() if path.exists() else []

    def head_calls(self, suffix):
        return [body for path, body in self.head.calls if path.endswith(suffix)]


class TalkTest(TalkCase):
    def test_a_press_and_release_speaks_the_reply_in_order_and_shows_it(self):
        self.talk("start")
        self.talk("stop")
        self.assertEqual(self.lines("hex.log"), ["dictation start --raw", "dictation stop --print"])
        self.assertEqual(self.head_calls("/turns"), [{"text": "what time is it"}])
        self.assertEqual(self.lines("played"), ["First.", "Second."])
        self.notified(["First. Second."])

    def test_the_conversation_is_personal_on_the_mac_channel_and_reused_for_a_follow_up(self):
        for _ in range(2):
            self.talk("start")
            self.talk("stop")
        opened = self.head_calls("/v1/conversations")
        self.assertEqual(len(opened), 1)
        self.assertEqual((opened[0]["channel"], opened[0]["tier"]), ("mac", "personal"))
        self.assertEqual(len(self.head_calls("/turns")), 2)
        self.assertEqual(self.head_calls("/end"), [])

    def test_an_end_phrase_ends_the_conversation_and_the_next_press_opens_a_new_one(self):
        self.say("goodbye")
        self.talk("start")
        self.talk("stop")
        self.assertEqual(self.head_calls("/end"), [{"reason": "end_phrase"}])
        self.talk("start")
        self.assertEqual(len(self.head_calls("/v1/conversations")), 2)

    def test_silence_sends_nothing_to_janet(self):
        (self.stub / "hex-status").write_text("4")
        self.say("")
        self.talk("start")
        self.talk("stop")
        self.assertEqual(self.head_calls("/turns"), [])
        self.notified(["Didn't catch that."])
        self.assertEqual(self.lines("played"), [])

    def test_the_voice_starts_loading_at_the_press(self):
        self.talk("start")
        self.assertEqual([request["text"] for request in self.voice.requests_seen], ["Hi."])

    def test_no_secret_is_passed_on_a_command_line(self):
        self.talk("start")
        self.talk("stop")
        arguments = "\n".join(self.lines("curl-args"))
        self.assertIn("/v1/tts", arguments)
        self.assertNotIn(fakes.TOKEN, arguments)
        self.assertNotIn(CF_SECRET, arguments)

    def test_pressing_again_stops_the_reply_and_tells_the_head_what_was_heard(self):
        (self.stub / "afplay-seconds").write_text("1.5")
        self.talk("start")
        speaking = self.talk("stop", wait=False)
        self.wait_for(lambda: self.lines("played") == ["First."])
        time.sleep(0.2)
        (self.stub / "afplay-seconds").write_text("0")
        self.talk("start")
        speaking.wait(10)
        self.assertEqual(self.head_calls("/interrupt"), [{"heard_text": ""}])
        time.sleep(0.5)
        self.assertEqual(self.lines("played"), ["First."])


    def test_a_release_that_beats_the_recording_still_ends_it(self):
        # A quick tap: the key is up again before Hex has started recording.
        (self.stub / "hex-start-seconds").write_text("0.6")
        starting = self.talk("start", wait=False)
        time.sleep(0.1)
        self.talk("stop")
        starting.wait(10)
        self.assertEqual(self.lines("hex.log"), ["dictation start --raw", "dictation stop --print"])
        self.assertEqual(self.head_calls("/turns"), [{"text": "what time is it"}])

    def test_a_follow_up_after_a_long_pause_gets_a_new_conversation(self):
        self.talk("start")
        self.talk("stop")
        state = Path(self.env["JANET_TALK_STATE"])
        (state / "conversation.used").write_text(str(int(time.time()) - 600))
        (state / "conversation").write_text("00000000dead\n")
        self.talk("start")
        self.talk("stop")
        self.assertEqual(len(self.head_calls("/v1/conversations")), 2)
        self.assertEqual([path for path, _ in self.head.calls if "00000000dead" in path], [])

    def test_without_hex_it_says_so_and_calls_nobody(self):
        (self.stub / "hex-start-status").write_text("3")
        self.talk("start", status=1)
        self.notified(["Hex is not running."])
        self.assertEqual(self.head.calls, [])

    def test_without_its_secrets_it_says_so_and_drops_the_recording(self):
        (self.stub / "no-secrets").touch()
        self.talk("start", status=1)
        self.notified(["Not set up: run the janet-mac install script."])
        self.assertEqual(self.lines("hex.log"), ["dictation start --raw", "dictation cancel"])
        self.assertEqual(self.head.calls, [])

    def test_a_voice_that_fails_is_not_asked_again(self):
        self.voice.fail_texts = {"First."}
        self.talk("start")
        self.talk("stop")
        asked = [request["text"] for request in self.voice.requests_seen]
        self.assertEqual(sorted(asked), ["First.", "Hi.", "Second."])
        self.assertEqual(self.lines("played"), ["Second."])
        self.notified(["First. Second."])


class InstallTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        stub = self.home / "stub"
        stub.mkdir()
        # A Keychain made of files: `-i` stores what it is told, find prints it back.
        (stub / "security").write_text(
            "#!/usr/bin/env bash\n"
            'if [ "$1" = -i ]; then while read -r _ _ _ _ _ account _ value; do '
            'a=${account//\\"/}; v=${value//\\"/}; [ -e "$HOME/keychain-broken" ] || printf %s "$v" >"$HOME/kc.$a"; done; exit 0; fi\n'
            'cat "$HOME/kc.$5" 2>/dev/null || exit 44\n'
        )
        (stub / "security").chmod(0o755)
        self.env = {**os.environ, "HOME": str(self.home), "PATH": f"{stub}:{os.environ['PATH']}"}
        self.karabiner = self.home / ".config" / "karabiner" / "karabiner.json"
        self.karabiner.parent.mkdir(parents=True)
        self.karabiner.write_text(json.dumps({"profiles": [
            {"name": "Other", "complex_modifications": {"rules": [{"description": "other profile"}]}},
            {"name": "Default", "selected": True, "complex_modifications": {"rules": [{"description": "mine"}]}},
        ]}))

    def install(self, secrets="cf-id.access\ncf-secret\nhead-token\n", url="https://voice.example.com/"):
        return subprocess.run(["bash", str(APP / "install.sh"), url], input=secrets, text=True, env=self.env,
                              capture_output=True)

    def rules(self, profile):
        profiles = json.loads(self.karabiner.read_text())["profiles"]
        return [rule["description"] for rule in profiles[profile]["complex_modifications"]["rules"]]

    def test_it_installs_the_script_the_url_the_secrets_and_the_rule(self):
        self.assertEqual(self.install().returncode, 0)
        self.assertTrue(os.access(self.home / ".local/bin/janet-talk", os.X_OK))
        self.assertEqual((self.home / ".config/janet-talk/config").read_text(),
                         'JANET_VOICE_URL="https://voice.example.com"\n')
        stored = {name: (self.home / f"kc.{name}").read_text() for name in
                  ("cf-access-client-id", "cf-access-client-secret", "head-token")}
        self.assertEqual(stored, {"cf-access-client-id": "cf-id.access", "cf-access-client-secret": "cf-secret",
                                  "head-token": "head-token"})
        self.assertEqual(len(self.rules(1)), 2)
        self.assertIn("double tap", self.rules(1)[0])
        self.assertEqual(self.rules(1)[1], "mine")
        self.assertEqual(self.rules(0), ["other profile"])

    def test_running_it_twice_keeps_one_rule_and_the_original_backup(self):
        self.install()
        self.install()
        self.assertEqual(len(self.rules(1)), 2)
        backup = json.loads((self.karabiner.parent / "karabiner.json.before-janet-talk").read_text())
        self.assertEqual([rule["description"] for rule in backup["profiles"][1]["complex_modifications"]["rules"]],
                         ["mine"])

    def test_a_secret_with_a_quote_or_a_space_is_refused_before_anything_is_stored(self):
        for bad in ('cf-id\nse"cret\ntoken\n', "cf-id\nsecret\nto ken\n", "cf-id\nsecret\n", "cf-id\nsec\\ret\ntoken\n"):
            with self.subTest(bad=bad):
                self.assertNotEqual(self.install(secrets=bad).returncode, 0)
                self.assertEqual(list(self.home.glob("kc.*")), [])

    def test_a_plain_http_gateway_is_refused(self):
        self.assertNotEqual(self.install(url="http://voice.example.com").returncode, 0)
        self.assertFalse((self.home / ".config/janet-talk/config").exists())

    def test_it_fails_when_the_keychain_did_not_keep_the_secret(self):
        (self.home / "keychain-broken").touch()
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Keychain", result.stderr)


class SleepingVoiceTest(TalkCase):
    voice_up = False

    def test_the_text_shows_at_once_and_the_audio_plays_when_the_voice_host_wakes(self):
        self.talk("start")
        self.assertTrue(self.wake.packets(), "the press sent no wake packet")
        speaking = self.talk("stop", wait=False)
        self.wait_for(lambda: "First. Second." in self.lines("notifications"))
        self.wait_for(lambda: "Waking the voice PC. I'll speak as soon as it's up." in self.lines("notifications"))
        self.assertEqual(self.lines("played"), [])
        self.start_voice()
        self.assertEqual(speaking.wait(30), 0)
        self.assertEqual(self.lines("played"), ["First.", "Second."])


if __name__ == "__main__":
    unittest.main()
