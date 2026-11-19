"""The command line against a stand-in Wyoming server and a stand-in ffmpeg."""

import contextlib
import io
import socket
import socketserver
import stat
import tempfile
import threading
import unittest
from pathlib import Path

import janet_voice_note as note

# Stands in for ffmpeg: decoding copies the input file to standard output, encoding copies standard
# input to the last argument (the output file), and a file named "broken" fails.
FFMPEG = """#!/bin/sh
for last; do :; done
case "$*" in
  *broken*) echo "bad file" >&2; exit 1 ;;
  *"-f s16le -") while [ "$1" != "-i" ]; do shift; done; cat "$2" ;;
  *) cat > "$last" ;;
esac
"""


class FakeWyoming(socketserver.ThreadingTCPServer):
    """Answers describe, transcribe and synthesize, and keeps what it was sent."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, reply: str = "ok"):
        super().__init__(("127.0.0.1", 0), _Handler)
        self.reply = reply  # "ok", "error", or "hangup" (close in the middle of the audio)
        self.heard = b""
        self.asked: dict = {}
        threading.Thread(target=self.serve_forever, daemon=True).start()

    @property
    def at(self) -> str:
        return f"127.0.0.1:{self.server_address[1]}"


class _Handler(socketserver.StreamRequestHandler):
    def handle(self):
        server, heard = self.server, bytearray()
        while True:
            try:
                kind, fields, payload = note.read_event(self.rfile)
            except note.ServerError:
                return
            if kind == "describe":
                info = {
                    "asr": [{"name": "fake-stt", "models": [{"name": "big"}]}],
                    "tts": [{"name": "fake-tts", "voices": [{"name": "janet"}]}],
                }
                self.wfile.write(note.event("info", info))
            elif kind == "transcribe":
                server.asked = fields
            elif kind == "audio-chunk":
                heard += payload
            elif kind == "audio-stop":
                server.heard = bytes(heard)
                self.wfile.write(note.event("transcript", {"text": " what was said "}))
            elif kind == "synthesize":
                server.asked = fields
                audio = {"rate": 24000, "width": 2, "channels": 1}
                self.wfile.write(note.event("audio-start", audio) + note.event("audio-chunk", audio, b"\x01\x00" * 100))
                if server.reply == "hangup":
                    return
                if server.reply == "error":
                    self.wfile.write(note.event("error", {"text": "out of memory"}))
                    return
                self.wfile.write(note.event("audio-chunk", audio, b"\x02\x00" * 100) + note.event("audio-stop"))


def closed_port() -> str:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return f"127.0.0.1:{sock.getsockname()[1]}"


class NoteTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.ffmpeg = self.dir / "ffmpeg"
        self.ffmpeg.write_text(FFMPEG)
        self.ffmpeg.chmod(self.ffmpeg.stat().st_mode | stat.S_IXUSR)

    def server(self, reply: str = "ok") -> FakeWyoming:
        server = FakeWyoming(reply)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server

    def run_note(self, *argv: str) -> tuple[int, str, str]:
        out, err, status = io.StringIO(), io.StringIO(), 0
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                note.main(["--ffmpeg", str(self.ffmpeg), *argv])
            except SystemExit as stop:
                status = stop.code if isinstance(stop.code, int) else 1
                if isinstance(stop.code, str):
                    err.write(stop.code)
        return status, out.getvalue(), err.getvalue()

    def test_hear_prints_only_the_transcript_and_sends_the_whole_recording(self):
        server = self.server()
        recording = self.dir / "note.ogg"
        recording.write_bytes(bytes(range(256)) * 300)  # more than two one-second chunks
        status, out, err = self.run_note("hear", "--stt", server.at, str(recording))
        self.assertEqual((status, out), (0, "what was said\n"))
        self.assertEqual(server.heard, recording.read_bytes())
        self.assertEqual(server.asked, {"language": "en"})
        self.assertIn("fake-stt big", err)

    def test_hear_reports_an_unreachable_server_with_its_own_status(self):
        recording = self.dir / "note.ogg"
        recording.write_bytes(b"\x00" * 64)
        status, out, err = self.run_note("hear", "--stt", closed_port(), str(recording))
        self.assertEqual((status, out), (note.UNREACHABLE, ""))
        self.assertIn("unreachable", err)

    def test_hear_fails_on_a_file_ffmpeg_cannot_read(self):
        server = self.server()
        status, out, _ = self.run_note("hear", "--stt", server.at, str(self.dir / "broken.ogg"))
        self.assertEqual((status, out), (1, ""))

    def test_say_writes_the_voice_and_prints_only_the_path(self):
        server = self.server()
        out_file = self.dir / "reply.ogg"
        status, out, err = self.run_note("say", "--tts", server.at, "--voice", "janet", "--out", str(out_file), "Hello there.")
        self.assertEqual((status, out), (0, f"{out_file}\n"))
        self.assertEqual(out_file.read_bytes(), b"\x01\x00" * 100 + b"\x02\x00" * 100)
        self.assertEqual(server.asked, {"text": "Hello there.", "voice": {"name": "janet"}})
        self.assertIn("fake-tts janet", err)

    def test_say_writes_no_file_when_the_voice_fails_part_way(self):
        for reply in ("error", "hangup"):
            with self.subTest(reply):
                server = self.server(reply)
                out_file = self.dir / f"{reply}.ogg"
                status, out, _ = self.run_note("say", "--tts", server.at, "--out", str(out_file), "Hello.")
                self.assertEqual((status, out), (1, ""))
                self.assertEqual(list(self.dir.glob(f"{reply}.ogg*")), [])

    def test_say_without_wake_reports_an_unreachable_voice(self):
        status, out, _ = self.run_note("say", "--tts", closed_port(), "--out", str(self.dir / "no.ogg"), "Hello.")
        self.assertEqual((status, out), (note.UNREACHABLE, ""))

    def test_say_wakes_a_sleeping_host_and_gives_up_after_the_wait(self):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as card:
            card.bind(("127.0.0.1", 0))
            card.settimeout(5)
            status, _, err = self.run_note(
                "say", "--tts", closed_port(), "--out", str(self.dir / "no.ogg"),
                "--wake-mac", "aa:bb:cc:00:11:22", "--wake-broadcast", f"127.0.0.1:{card.getsockname()[1]}",
                "--wake-wait", "0", "Hello.",
            )  # fmt: skip
            self.assertEqual(status, note.UNREACHABLE)
            self.assertEqual(card.recv(200), b"\xff" * 6 + bytes.fromhex("aabbcc001122") * 16)
            self.assertIn("wake", err)

    def test_say_refuses_empty_text(self):
        server = self.server()
        status, out, _ = self.run_note("say", "--tts", server.at, "--out", str(self.dir / "no.ogg"), "  ")
        self.assertEqual((status, out), (1, ""))


if __name__ == "__main__":
    unittest.main()
