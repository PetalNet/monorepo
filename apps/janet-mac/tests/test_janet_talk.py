"""Runs the real janet-talk script against the real voice gateway, with stand-ins for the
head, the voice server, and the Mac programs the script calls."""

import importlib.util
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import shutil
import signal
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
    # The secrets come from the test's environment, so none is written to disk.
    "security": '#!/usr/bin/env bash\n[ -e "$STUB/no-secrets" ] && exit 44\ncase "$5" in cf-access-client-id) echo cf-id;; '
    'cf-access-client-secret) echo "$STUB_CF_SECRET";; head-token) echo "$STUB_HEAD_TOKEN";; esac\n',
    # Appends the audio it was asked to play, then takes as long as the test says.
    "afplay": '#!/usr/bin/env bash\ntail -c +45 "$1" >>"$STUB/played"; echo >>"$STUB/played"\n'
    'cat "$STUB/media-state" >>"$STUB/media-at-play" 2>/dev/null\n'
    'sleep "$(cat "$STUB/afplay-seconds")"\n',
    # Stands in for the MediaRemote adapter: one player whose state is a file, and a log of its calls.
    "media": '#!/usr/bin/env bash\necho "$*" >>"$STUB/media-calls"\n[ -e "$STUB/media-state" ] || { echo null; exit 0; }\n'
    'case "$1 $2" in\n  "get "*) echo "{\\"bundleIdentifier\\":\\"com.example.show\\",\\"playing\\":$(cat "$STUB/media-state")}";;\n'
    '  "send pause") echo false >"$STUB/media-state";;\n  "send play") echo true >"$STUB/media-state";;\nesac\n',
    "osascript": '#!/usr/bin/env bash\necho "$3" >>"$STUB/notifications"\n',
    "curl": '#!/usr/bin/env bash\necho "$*" >>"$STUB/curl-args"\nexec "$REAL_CURL" "$@"\n',
}


# How a real room's level wandered around its middle, in dB, sample by sample: taken from four
# seconds of a MacBook microphone in a quiet room, including its louder instants.
ROOM_WANDER = [
    -1, -2, -1, -2, 1, 0, 1, 1, 1, -1, 0, -2, -1, 0, 0, 1, 0, 7, 4, -2, 2, 3, 1, 1, 0, 1, 2, 0, 0, 0, -1, 1, 0, 2, 0,
    3, -1, -1, -3, 2, 2, 1, 0, 1, 2, 0, 1, 0, 1, 3, 3, -1, 0, 1, -3, 1, 0, 0, 2, -2, 0, 0, -1, -2, 0, 3, 2, 3, 3, -2,
    1, -1, 3, 1, 1, 1, -2, 2, -2, -3, -2, -4, -3, -2, -1, 2, 1, 2, 2, -3, -4, -3, 1, -2, 1, 0, 4, 4, 2, 1, -1, 2, 1,
]


class FakeHex(ThreadingHTTPServer):
    """Hex's local dictation API. What it does comes from files the test writes, and it logs each call."""

    daemon_threads = True

    def __init__(self, stub: Path):
        super().__init__(("127.0.0.1", 0), _HexHandler)
        self.stub = stub
        # (seconds, dB) steps the microphone level goes through while a recording runs.
        self.levels = [(0.0, -50.0)]
        self.heartbeats = 0
        self.sample = 0
        # When each call arrived, by name, in seconds on the monotonic clock.
        self.at: dict[str, float] = {}
        threading.Thread(target=self.serve_forever, daemon=True).start()
        (stub / "local-api.json").write_text(json.dumps({"port": self.server_address[1], "token": "hex-token"}))


class _HexHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def _reply(self, status, body=None):
        data = json.dumps(body).encode() if body is not None else b""
        self.send_response(status)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read(self, name):
        return (self.server.stub / name).read_text().strip()

    def _log(self, line):
        with (self.server.stub / "hex.log").open("a") as log:
            log.write(line + "\n")

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if self.headers.get("Authorization") != "Bearer hex-token":
            return self._reply(401)
        if self.path == "/dictations":
            time.sleep(float(self._read("hex-start-seconds")))
            if self._read("hex-start-status") != "0":
                return self._reply(503)
            # A start is logged once the recording has begun.
            self.server.at["start"] = time.monotonic()
            self._log("start")
            return self._reply(201, {"id": 7, "ownerToken": "owner-token", "sampleRate": 48000})
        if self.headers.get("X-Hex-Dictation-Token") != "owner-token":
            return self._reply(403)
        action = self.path.rpartition("/")[2]
        if action == "heartbeat":
            self.server.heartbeats += 1
            return self._reply(204)
        self.server.at[action] = time.monotonic()
        self._log(action)
        if action == "finish":
            heard = "" if self._read("hex-status") == "4" else self._read("transcript")
            return self._reply(200, {"transcript": heard, "durationMs": 1000})
        self._reply(200, {})

    def do_GET(self):
        if self.path.endswith("/audio"):
            return self._audio()
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        try:
            for seconds, level in self.server.levels:
                until = time.monotonic() + seconds
                syllable = 0
                while True:
                    # Speech is uneven: loud and soft instants alternate. A room wanders.
                    syllable += 1
                    self.server.sample += 1
                    if isinstance(level, list):
                        now = level[syllable % len(level)]
                    elif level > -30:
                        now = level - 15 if syllable % 2 else level
                    else:
                        now = level + ROOM_WANDER[self.server.sample % len(ROOM_WANDER)]
                    self.wfile.write(f'data: {{"peakDb":{now},"rmsDb":{now}}}\n\n'.encode())
                    self.wfile.flush()
                    if time.monotonic() >= until:
                        break
                    time.sleep(0.05)
        except OSError:
            pass


    def _audio(self):
        # The microphone as 48 kHz float32, for as long as the listener stays.
        self.send_response(200)
        self.send_header("content-type", "application/octet-stream")
        self.end_headers()
        try:
            while True:
                self.wfile.write(bytes(4 * 480))
                self.wfile.flush()
                time.sleep(0.01)
        except OSError:
            pass


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
        self.hex = FakeHex(self.stub)
        self.addCleanup(self.hex.shutdown)

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
            "JANET_TALK_HEX_API": str(self.stub / "local-api.json"),
            "JANET_TALK_MEDIA": str(self.stub / "media"),
            # Every press counts as a hold unless a test says otherwise.
            "JANET_TALK_LATCH_MS": "-1000000",
            "JANET_TALK_END_OF_SPEECH_S": "0.4",
            "JANET_TALK_NO_SPEECH_S": "6",
            "JANET_TALK_MAX_LISTEN_S": "20",
            # The tests wait for each key event to finish, so it stays in the foreground.
            "JANET_TALK_DETACHED": "1",
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

    def talk(self, action, wait=True, status=0, within=60):
        process = subprocess.Popen(["bash", str(APP / "janet-talk"), action], env=self.env)
        if wait:
            self.assertEqual(process.wait(within), status)
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


class TurnEndModelsTest(TalkCase):
    def test_with_the_models_installed_they_hear_the_microphone_and_end_the_listening(self):
        home = self.root / "turn-end"
        (home / "venv" / "bin").mkdir(parents=True)
        # Stands in for the Python that runs turn_end.py: hears a little audio, then calls the turn finished.
        python = home / "venv" / "bin" / "python"
        python.write_text('#!/usr/bin/env bash\necho "$*" >"$STUB/turn-end-args"\nhead -c 9600 | wc -c >"$STUB/turn-end-heard"\necho finished\n')
        python.chmod(0o755)
        self.env["JANET_TALK_TURN_END"] = str(home)
        self.env["JANET_TALK_LATCH_MS"] = "1000000"
        self.talk("start")
        self.talk("stop")
        self.assertIn("--rate 48000 ", self.lines("turn-end-args")[0])
        self.assertEqual(int(self.lines("turn-end-heard")[0]), 9600)
        self.assertIn("stopped listening: finished", (Path(self.env["JANET_TALK_STATE"]) / "talk.log").read_text())
        self.assertEqual(self.lines("hex.log"), ["start", "finish"])
        self.assertEqual(self.head_calls("/turns"), [{"text": "what time is it"}])


    def test_models_that_fail_to_run_leave_the_level_rule_to_end_the_listening(self):
        home = self.root / "turn-end"
        (home / "venv" / "bin").mkdir(parents=True)
        python = home / "venv" / "bin" / "python"
        python.write_text("#!/usr/bin/env bash\nexit 1\n")
        python.chmod(0o755)
        self.env["JANET_TALK_TURN_END"] = str(home)
        self.env["JANET_TALK_LATCH_MS"] = "1000000"
        self.hex.levels = [(1.0, -50.0), (1.5, -22.0), (30.0, -50.0)]
        self.talk("start")
        self.talk("stop")
        listened = self.hex.at["finish"] - self.hex.at["start"]
        self.assertGreater(listened, 2.5 + 0.3, "it stopped listening while the speaker was talking")
        self.assertLess(listened, 2.5 + 1.6)
        self.assertEqual(self.head_calls("/turns"), [{"text": "what time is it"}])


class TalkTest(TalkCase):
    def test_a_press_and_release_speaks_the_reply_in_order_and_shows_it(self):
        self.talk("start")
        self.talk("stop")
        self.assertEqual(self.lines("hex.log"), ["start", "finish"])
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


    def test_a_key_event_outlives_the_command_that_started_it(self):
        # Karabiner ends the key-down command when the key-up command arrives. The work must go on.
        env = {k: v for k, v in self.env.items() if k != "JANET_TALK_DETACHED"}
        script = self.root / "janet-talk"
        script.write_text((APP / "janet-talk").read_text().replace("/bin/bash", shutil.which("bash")))
        (self.stub / "hex-start-seconds").write_text("0.5")
        launcher = subprocess.Popen(["bash", str(script), "start"], env=env, start_new_session=True)
        self.assertEqual(launcher.wait(5), 0)
        self.assertEqual(self.lines("hex.log"), [], "the launcher waited for the work")
        try:
            os.killpg(launcher.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        self.wait_for(lambda: self.head_calls("/v1/conversations"), 10)
        self.assertEqual(self.lines("hex.log"), ["start"])

    def test_a_release_that_beats_the_recording_still_ends_it(self):
        # A quick tap: the key is up again before Hex has started recording.
        (self.stub / "hex-start-seconds").write_text("0.6")
        starting = self.talk("start", wait=False)
        time.sleep(0.1)
        self.talk("stop")
        starting.wait(10)
        self.assertEqual(self.lines("hex.log"), ["start", "finish"])
        self.assertEqual(self.head_calls("/turns"), [{"text": "what time is it"}])

    def test_a_release_with_no_recording_leaves_the_next_press_alone(self):
        # The first press never started a recording (Hex was slow), and its release is still waiting.
        orphan = self.talk("stop", wait=False)
        time.sleep(1.3)
        self.talk("start")
        self.assertEqual(orphan.wait(10), 0)
        self.assertEqual(self.lines("hex.log"), ["start"], "the old release ended the new recording")
        self.talk("stop")
        self.assertEqual(self.lines("hex.log"), ["start", "finish"])

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
        self.assertEqual(self.lines("hex.log"), ["start", "cancel"])
        self.assertEqual(self.head.calls, [])

    def test_a_voice_that_fails_is_not_asked_again(self):
        self.voice.fail_texts = {"First."}
        self.talk("start")
        self.talk("stop")
        asked = [request["text"] for request in self.voice.requests_seen]
        self.assertEqual(sorted(asked), ["First.", "Hi.", "Second."])
        self.assertEqual(self.lines("played"), ["Second."])
        self.notified(["First. Second."])


class OrderedSpeechTest(TalkCase):
    def test_sentences_are_synthesized_one_at_a_time_in_order_while_the_first_plays(self):
        self.voice.delays = {"First.": 0.6, "Second.": 0.3}
        (self.stub / "afplay-seconds").write_text("1.5")
        self.talk("start")
        speaking = self.talk("stop", wait=False)
        self.wait_for(lambda: len(self.voice.requests_seen) == 3)
        self.wait_for(lambda: self.lines("played") == ["First."])
        # The second sentence is already made while the first one is still playing.
        self.assertEqual(self.voice.requests_seen[1:], [{"text": "First.", "voice": {"name": "janet"}}, {"text": "Second.", "voice": {"name": "janet"}}])
        self.assertEqual(self.voice.peak_active, 1)
        speaking.wait(20)
        self.assertEqual(self.lines("played"), ["First.", "Second."])


class MediaTest(TalkCase):
    def playing(self, state="true"):
        (self.stub / "media-state").write_text(state)

    def sends(self):
        return [line for line in self.lines("media-calls") if line.startswith("send")]

    def test_what_is_playing_is_paused_while_janet_speaks_and_resumed_after(self):
        self.playing()
        self.talk("start")
        self.talk("stop")
        self.assertEqual(self.sends(), ["send pause", "send play"])
        self.assertEqual(self.lines("media-at-play"), ["false", "false"])
        self.assertEqual((self.stub / "media-state").read_text().strip(), "true")

    def test_nothing_is_paused_or_resumed_when_nothing_was_playing(self):
        self.playing("false")
        self.talk("start")
        self.talk("stop")
        self.assertEqual(self.sends(), [])
        self.assertEqual((self.stub / "media-state").read_text().strip(), "false")

    def test_no_player_at_all_changes_nothing(self):
        self.talk("start")
        self.talk("stop")
        self.assertEqual(self.sends(), [])
        self.assertEqual(self.lines("played"), ["First.", "Second."])

    def test_pressing_again_mid_reply_resumes_what_was_paused(self):
        self.playing()
        (self.stub / "afplay-seconds").write_text("1.5")
        self.talk("start")
        speaking = self.talk("stop", wait=False)
        self.wait_for(lambda: self.sends() == ["send pause"])
        (self.stub / "afplay-seconds").write_text("0")
        self.talk("start")
        speaking.wait(10)
        self.wait_for(lambda: (self.stub / "media-state").read_text().strip() == "true")
        time.sleep(0.5)
        self.assertEqual(self.sends(), ["send pause", "send play"])

    def test_a_cut_off_reply_is_resumed_even_when_the_next_press_cannot_start(self):
        self.playing()
        (self.stub / "afplay-seconds").write_text("1.5")
        self.talk("start")
        speaking = self.talk("stop", wait=False)
        self.wait_for(lambda: self.sends() == ["send pause"])
        (self.stub / "hex-start-status").write_text("3")
        self.talk("start", status=1)
        speaking.wait(10)
        self.wait_for(lambda: (self.stub / "media-state").read_text().strip() == "true")

    def test_a_leftover_pause_from_long_ago_is_not_resumed(self):
        self.playing("false")
        (self.root / "state").mkdir(exist_ok=True)
        (self.root / "state" / "media.paused").write_text(f"{int(time.time()) - 5000} com.example.show")
        self.talk("start")
        time.sleep(0.5)
        self.assertEqual(self.sends(), [])

    def test_an_adapter_that_hangs_does_not_hold_the_reply_back(self):
        self.env["JANET_TALK_MEDIA_TIMEOUT_S"] = "1"
        (self.stub / "media").write_text("#!/usr/bin/env bash\nexec sleep 30\n")
        self.talk("start")
        self.talk("stop", within=15)
        self.assertEqual(self.lines("played"), ["First.", "Second."])

    def test_media_is_paused_even_when_the_first_sentence_could_not_be_spoken(self):
        self.playing()
        self.voice.fail_texts = {"First."}
        self.talk("start")
        self.talk("stop")
        self.assertEqual(self.lines("played"), ["Second."])
        self.assertEqual(self.sends(), ["send pause", "send play"])

    def test_something_the_listener_started_meanwhile_is_left_alone(self):
        self.playing()
        (self.stub / "afplay-seconds").write_text("0.8")
        self.talk("start")
        speaking = self.talk("stop", wait=False)
        self.wait_for(lambda: self.sends() == ["send pause"])
        self.playing()
        speaking.wait(20)
        self.assertEqual(self.sends(), ["send pause"])


class TapTest(TalkCase):
    """The second press was a tap, so Janet listens until the speaker stops.

    Each test plays a microphone level through the fake Hex and checks how long Janet listened:
    the time from Hex starting the recording to Hex being told to finish it. Speech ends
    0.4 s of quiet later in these tests; giving up on silence takes 6 s, far outside every bound,
    so a test cannot pass by giving up.
    """

    ROOM, SPEECH = -50.0, -22.0

    def setUp(self):
        super().setUp()
        self.env["JANET_TALK_LATCH_MS"] = "1000000"

    def listened(self, levels, within=60):
        self.hex.levels = levels
        self.talk("start")
        self.talk("stop", within=within)
        self.assertEqual(self.lines("hex.log"), ["start", "finish"])
        return self.hex.at["finish"] - self.hex.at["start"]

    def assert_ended_after_speech(self, levels, speech_ends_at, within=60):
        seconds = self.listened(levels, within)
        self.assertGreater(seconds, speech_ends_at + 0.3, "it stopped listening while the speaker was talking")
        self.assertLess(seconds, speech_ends_at + 1.6, "it kept listening after the speaker stopped")

    def test_it_sends_what_was_said_once_the_speaker_goes_quiet(self):
        self.assert_ended_after_speech([(1.0, self.ROOM), (1.5, self.SPEECH), (30.0, self.ROOM)], 2.5)
        self.assertEqual(self.head_calls("/turns"), [{"text": "what time is it"}])

    def test_a_pause_shorter_than_the_limit_does_not_end_it(self):
        levels = [(0.8, self.ROOM), (0.8, self.SPEECH), (0.2, self.ROOM), (1.0, self.SPEECH), (30.0, self.ROOM)]
        self.assert_ended_after_speech(levels, 2.8)

    def test_speech_that_starts_at_once_still_ends_on_quiet(self):
        self.assert_ended_after_speech([(2.0, self.SPEECH), (30.0, self.ROOM)], 2.0)

    def test_a_noisy_room_counts_as_quiet_once_the_speaker_stops(self):
        self.assert_ended_after_speech([(1.0, -38.0), (1.5, -18.0), (30.0, -38.0)], 2.5)

    def test_the_microphone_opening_does_not_make_room_noise_look_like_speech(self):
        # Hex reports near-total silence for an instant while the microphone opens. Then the
        # speaker takes two seconds to begin.
        levels = [(0.15, -110.0), (0.15, -75.0), (2.0, -46.0), (1.2, self.SPEECH), (30.0, -46.0)]
        self.assert_ended_after_speech(levels, 3.5)

    def test_one_stray_silent_instant_does_not_set_the_quiet_level(self):
        levels = [(0.9, -46.0), (0.0, -80.0), (1.5, -46.0), (1.2, self.SPEECH), (30.0, -46.0)]
        self.assert_ended_after_speech(levels, 3.6)

    def test_a_click_before_the_speech_does_not_end_the_listening(self):
        levels = [(1.2, self.ROOM), (0.1, -28.0), (1.5, self.ROOM), (1.2, self.SPEECH), (30.0, self.ROOM)]
        self.assert_ended_after_speech(levels, 4.0)

    def test_a_long_sentence_with_a_soft_ending_is_heard_to_the_end(self):
        # The ending is steady and soft: above the room, below the dips of the loud part.
        self.env["JANET_TALK_NO_SPEECH_S"] = "10"
        levels = [(0.8, self.ROOM), (3.0, -20.0), (1.5, -32.0), (30.0, self.ROOM)]
        self.assert_ended_after_speech(levels, 5.3)

    def test_someone_who_talks_for_a_minute_is_heard_to_the_end(self):
        del self.env["JANET_TALK_MAX_LISTEN_S"]  # the limit the script ships with
        self.assert_ended_after_speech([(1.0, self.ROOM), (60.0, self.SPEECH), (30.0, self.ROOM)], 61.0, within=120)

    def test_speech_only_a_little_above_the_room_is_still_speech(self):
        # Eleven dB over a -46 room, with gaps.
        soft = [-35.0, -35.0, -46.0, -35.0]
        self.assert_ended_after_speech([(1.0, -46.0), (1.5, soft), (30.0, -46.0)], 2.5)

    def test_a_room_with_frequent_louder_instants_is_not_speech(self):
        # Seven and eight dB over the room, half the time, and nobody talking.
        self.env["JANET_TALK_NO_SPEECH_S"] = "2"
        (self.stub / "hex-status").write_text("4")
        restless = [-46.0, -46.0, -39.0, -38.0, -46.0, -39.0, -38.0, -46.0]
        seconds = self.listened([(30.0, restless)])
        self.assertGreater(seconds, 1.9)
        self.assertLess(seconds, 3.5)
        self.assertIn("nothing said", (Path(self.env["JANET_TALK_STATE"]) / "talk.log").read_text())

    def test_a_room_that_gets_louder_does_not_keep_it_listening(self):
        # Speech, then a fan starts: nine dB more room, for good.
        levels = [(1.0, self.ROOM), (1.5, self.SPEECH), (30.0, self.ROOM + 9)]
        seconds = self.listened(levels)
        self.assertLess(seconds, 2.5 + 8 + 3, "it never accepted the louder room as the room")

    def test_a_room_that_goes_quiet_does_not_end_the_listening_on_the_spot(self):
        # A fan stops three seconds in. The speaker still gets the usual pause to begin.
        seconds = self.listened([(3.0, self.ROOM + 8), (30.0, self.ROOM)])
        self.assertGreater(seconds, 3.0 + 1.2)

    def test_nothing_said_gives_up(self):
        self.env["JANET_TALK_NO_SPEECH_S"] = "1.5"
        (self.stub / "hex-status").write_text("4")
        seconds = self.listened([(30.0, self.ROOM)])
        self.assertGreater(seconds, 1.4)
        self.assertLess(seconds, 3.5)
        self.assertEqual(self.head_calls("/turns"), [])
        self.notified(["Didn't catch that."])

    def test_a_level_stream_that_ends_does_not_leave_it_listening(self):
        seconds = self.listened([(0.6, self.ROOM)])
        self.assertLess(seconds, 3.0)

    def test_a_second_double_tap_ends_the_listening_at_once(self):
        self.hex.levels = [(0.2, self.ROOM), (60.0, self.SPEECH)]
        self.talk("start")
        listening = self.talk("stop", wait=False)
        self.wait_for(lambda: (Path(self.env["JANET_TALK_STATE"]) / "listening.pid").exists())
        time.sleep(1.0)
        pressed = time.monotonic()
        self.talk("start")
        self.assertEqual(listening.wait(15), 0)
        self.assertLess(self.hex.at["finish"] - pressed, 1.5)
        self.assertEqual(self.lines("hex.log"), ["start", "finish"])
        self.assertEqual(self.head_calls("/turns"), [{"text": "what time is it"}])


class HoldTest(TalkCase):
    def test_hex_hears_from_the_recording_while_the_key_is_held_and_not_after(self):
        # Hex drops a recording whose owner goes quiet.
        self.env["JANET_TALK_HEARTBEAT_S"] = "0.2"
        self.talk("start")
        time.sleep(1.0)
        self.assertGreaterEqual(self.hex.heartbeats, 2)
        self.talk("stop")
        time.sleep(0.5)
        after = self.hex.heartbeats
        time.sleep(0.8)
        self.assertEqual(self.hex.heartbeats, after)

    def test_a_slow_hex_does_not_turn_a_hold_into_a_tap_or_lose_the_recording(self):
        # Hex takes over a second to start, the key is held well past that, then released.
        self.env["JANET_TALK_LATCH_MS"] = "400"
        (self.stub / "hex-start-seconds").write_text("1.2")
        self.hex.levels = [(60.0, -22.0)]
        starting = self.talk("start", wait=False)
        time.sleep(1.6)
        self.talk("stop")
        starting.wait(10)
        self.assertEqual(self.lines("hex.log"), ["start", "finish"])
        self.assertLess(self.hex.at["finish"] - self.hex.at["start"], 3.0)

    def test_a_held_key_ends_on_release_without_waiting_for_quiet(self):
        self.env["JANET_TALK_LATCH_MS"] = "100"
        self.hex.levels = [(60.0, -22.0)]
        self.talk("start")
        time.sleep(0.3)
        started = time.monotonic()
        self.talk("stop")
        self.assertLess(time.monotonic() - started, 6.0)
        self.assertEqual(self.lines("hex.log"), ["start", "finish"])


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

    def test_a_voice_that_stays_asleep_is_waited_for_once_for_the_whole_reply(self):
        self.env["JANET_TALK_WAKE_WAIT_S"] = "3"
        self.talk("start")
        started = time.monotonic()
        self.talk("stop", within=30)
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(self.lines("played"), [])


if __name__ == "__main__":
    unittest.main()
