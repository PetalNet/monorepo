"""Voice notes through the voice system's own speech servers: a recorded file to text, and text to a
voice-note file. Standard library only; ffmpeg does the decoding and encoding."""

import argparse
import json
import socket
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

RATE = 16000  # what the speech-to-text server is sent: mono PCM16 at this rate
UNREACHABLE = 3  # exit status when nothing answers on the server's port, so a caller can fall back
# Phone speakers play a quiet voice note under everything else; this brings it to the level of other media.
LOUDNESS = "loudnorm=I=-14:TP=-1.5:LRA=11"


class Unreachable(Exception):
    """Nothing answers on the server's port."""


class ServerError(Exception):
    """The server answered and then failed."""


@dataclass(frozen=True)
class Wake:
    mac: bytes
    broadcast: tuple[str, int]
    wait: float  # seconds to keep trying after the packet goes out

    def send(self) -> None:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            sock.sendto(b"\xff" * 6 + self.mac * 16, self.broadcast)


def address(text: str) -> tuple[str, int]:
    host, _, port = text.rpartition(":")
    if not host or not port.isdigit():
        raise argparse.ArgumentTypeError(f"{text!r} is not host:port")
    return host, int(port)


def connect(server: tuple[str, int], read_timeout: float, connect_timeout: float = 3.0) -> socket.socket:
    try:
        sock = socket.create_connection(server, timeout=connect_timeout)
    except OSError as error:
        raise Unreachable(f"{server[0]}:{server[1]}: {error}") from None
    sock.settimeout(read_timeout)
    return sock


def event(kind: str, data: dict | None = None, payload: bytes = b"") -> bytes:
    body = json.dumps(data).encode() if data else b""
    header = {"type": kind, "data_length": len(body), "payload_length": len(payload)}
    return json.dumps(header).encode() + b"\n" + body + payload


def read_event(reader) -> tuple[str, dict, bytes]:
    line = reader.readline()
    if not line:
        raise ServerError("the server closed the connection")
    header = json.loads(line)
    fields = dict(header.get("data") or {})
    if header.get("data_length"):
        fields.update(json.loads(_exactly(reader, header["data_length"])))
    return header["type"], fields, _exactly(reader, header.get("payload_length") or 0)


def _exactly(reader, length: int) -> bytes:
    data = reader.read(length)
    if len(data) != length:
        raise ServerError("the server closed the connection")
    return data


def _exchange(server: tuple[str, int], read_timeout: float, request: bytes, on_event):
    """Sends one request and feeds each reply event to on_event until it returns a value."""
    with connect(server, read_timeout) as sock, sock.makefile("rb") as reader:
        try:
            sock.sendall(request)
            while True:
                kind, fields, payload = read_event(reader)
                if kind == "error":
                    raise ServerError(fields.get("text", "server error"))
                if (result := on_event(kind, fields, payload)) is not None:
                    return result
        except (OSError, ValueError) as error:
            raise ServerError(str(error)) from None


def describe(server: tuple[str, int], service: str) -> str:
    """What is serving right now, as "program model, model". The model behind a port can change."""

    def on_event(kind, fields, _payload):
        if kind != "info":
            return None
        return ", ".join(
            f"{program.get('name', '?')} " + "/".join(m.get("name", "?") for m in program.get("models") or program.get("voices") or [])
            for program in fields.get(service) or []
        ) or "unknown"

    return _exchange(server, 10.0, event("describe"), on_event)


def transcribe(server: tuple[str, int], pcm: bytes, language: str) -> str:
    """A whole recording through a Wyoming speech-to-text server."""
    info = {"rate": RATE, "width": 2, "channels": 1}
    second = RATE * 2
    request = event("transcribe", {"language": language}) + event("audio-start", info)
    request += b"".join(event("audio-chunk", info, pcm[at : at + second]) for at in range(0, len(pcm), second))
    request += event("audio-stop")
    # A note runs for minutes and the model may have to load first; allow four times its length on top.
    read_timeout = 180.0 + 4 * len(pcm) / second
    return _exchange(server, read_timeout, request, lambda kind, fields, _: fields.get("text", "").strip() if kind == "transcript" else None)


def synthesize(server: tuple[str, int], text: str, voice: str) -> tuple[int, bytes]:
    """Text through a Wyoming text-to-speech server. Returns the sample rate and mono PCM16."""
    pcm, rate = bytearray(), [0]

    def on_event(kind, fields, payload):
        if kind == "audio-chunk":
            if (fields.get("width"), fields.get("channels")) != (2, 1):
                raise ServerError("the voice server must send mono 16-bit audio")
            rate[0] = fields["rate"]
            pcm.extend(payload)
        if kind == "audio-stop":
            return True
        return None

    # A cold voice model can take minutes to load before the first chunk.
    _exchange(server, 300.0, event("synthesize", {"text": text, "voice": {"name": voice}}), on_event)
    if not pcm:
        raise ServerError("the voice server sent no audio")
    return rate[0], bytes(pcm)


def awake(server: tuple[str, int], wake: Wake | None) -> None:
    """Returns once the port answers. With a Wake, sends the packet and keeps trying for its wait."""
    try:
        connect(server, 1.0).close()
        return
    except Unreachable:
        if wake is None:
            raise
    wake.send()
    print(f"wake: sent to the voice host, waiting up to {wake.wait:.0f} s", file=sys.stderr)
    deadline = time.monotonic() + wake.wait
    while True:
        try:
            connect(server, 1.0).close()
            return
        except Unreachable:
            if time.monotonic() >= deadline:
                raise
            time.sleep(2)


def decode(ffmpeg: str, path: Path) -> bytes:
    run = subprocess.run(
        [ffmpeg, "-nostdin", "-loglevel", "error", "-i", str(path), "-ar", str(RATE), "-ac", "1", "-f", "s16le", "-"],
        capture_output=True,
    )
    if run.returncode or not run.stdout:
        raise ServerError(f"ffmpeg could not read {path}: {run.stderr.decode(errors='replace').strip()}")
    return run.stdout


def encode(ffmpeg: str, rate: int, pcm: bytes, out: Path) -> None:
    """Writes an Opus voice note. The file appears only when it is whole."""
    part = out.with_name(out.name + ".part")
    run = subprocess.run(
        [ffmpeg, "-nostdin", "-y", "-loglevel", "error", "-f", "s16le", "-ar", str(rate), "-ac", "1", "-i", "-",
         "-af", LOUDNESS, "-c:a", "libopus", "-b:a", "48k", "-ar", "48000", "-ac", "1", "-f", "ogg", str(part)],
        input=pcm, capture_output=True,
    )  # fmt: skip
    if run.returncode:
        part.unlink(missing_ok=True)
        raise ServerError(f"ffmpeg could not write {out}: {run.stderr.decode(errors='replace').strip()}")
    part.replace(out)


def hear(args) -> None:
    started = time.monotonic()
    pcm = decode(args.ffmpeg, args.file)
    model = describe(args.stt, "asr")
    text = transcribe(args.stt, pcm, args.language)
    seconds = len(pcm) / (RATE * 2)
    print(f"hear: {model} at {args.stt[0]}:{args.stt[1]}, {seconds:.1f} s of audio in {time.monotonic() - started:.1f} s", file=sys.stderr)
    print(text)


def say(args) -> None:
    started = time.monotonic()
    text = args.text if args.text != "-" else sys.stdin.read()
    if not text.strip():
        raise SystemExit("say: no text")
    awake(args.tts, args.wake)
    model = describe(args.tts, "tts")
    rate, pcm = synthesize(args.tts, text, args.voice)
    encode(args.ffmpeg, rate, pcm, args.out)
    print(f"say: {model} at {args.tts[0]}:{args.tts[1]}, {len(pcm) / (rate * 2):.1f} s of speech in {time.monotonic() - started:.1f} s", file=sys.stderr)
    print(args.out)


def parse(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ffmpeg", default="ffmpeg", help="the ffmpeg program")
    commands = parser.add_subparsers(dest="command", required=True)

    one = commands.add_parser("hear", help="print the words in an audio file")
    one.add_argument("--stt", type=address, required=True, metavar="HOST:PORT", help="Wyoming speech-to-text server")
    one.add_argument("--language", default="en")
    one.add_argument("file", type=Path)
    one.set_defaults(run=hear)

    two = commands.add_parser("say", help="write text as an Opus voice note and print its path")
    two.add_argument("--tts", type=address, required=True, metavar="HOST:PORT", help="Wyoming text-to-speech server")
    two.add_argument("--voice", default="default", help="the Wyoming voice name")
    two.add_argument("--out", type=Path, required=True, help="the .ogg file to write")
    two.add_argument("--wake-mac", help="the voice host's network card; with it, a host that does not answer is sent Wake-on-LAN")
    two.add_argument("--wake-broadcast", type=address, metavar="HOST:PORT", help="broadcast address of the network both hosts share")
    two.add_argument("--wake-wait", type=float, default=90.0, help="seconds to wait for a woken host")
    two.add_argument("text", help="the words to speak, or - to read them from standard input")
    two.set_defaults(run=say, wake=None)

    args = parser.parse_args(argv)
    if args.command == "say" and args.wake_mac:
        if not args.wake_broadcast:
            parser.error("--wake-mac needs --wake-broadcast")
        try:
            mac = bytes.fromhex(args.wake_mac.replace(":", "").replace("-", ""))
        except ValueError:
            mac = b""
        if len(mac) != 6:
            parser.error(f"{args.wake_mac!r} is not a network card address")
        args.wake = Wake(mac, args.wake_broadcast, args.wake_wait)
    return args


def main(argv: list[str] | None = None) -> None:
    args = parse(argv)
    try:
        args.run(args)
    except Unreachable as error:
        print(f"{args.command}: unreachable: {error}", file=sys.stderr)
        raise SystemExit(UNREACHABLE) from None
    except ServerError as error:
        print(f"{args.command}: {error}", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
