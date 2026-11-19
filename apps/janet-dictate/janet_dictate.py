"""Live dictation for Kõnele, using the shared Parakeet streaming decoder."""

import argparse
import asyncio
import hmac
import json
import logging
import tomllib
from dataclasses import dataclass
from http import HTTPStatus
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import numpy as np
from janet_turn.turn_judge import CHUNK, RATE, Words
from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed
from websockets.http11 import Request, Response

log = logging.getLogger("janet-dictate")
PCM_TYPE = "audio/x-raw, layout=(string)interleaved, rate=(int)16000, format=(string)S16LE, channels=(int)1"
CHUNK_BYTES = CHUNK * 2
FLUSH_CHUNKS = 7  # The exported model needs about one second after the last sample to release its tail.


@dataclass(frozen=True)
class Config:
    models: Path
    token: str
    host: str = "127.0.0.1"
    port: int = 8795
    max_sessions: int = 2
    max_seconds: int = 120
    idle_seconds: int = 10

    def __post_init__(self):
        if len(self.token) < 32 or not self.token.isascii() or any(c.isspace() for c in self.token):
            raise ValueError("dictation token must contain at least 32 non-whitespace ASCII characters")
        if not 0 < self.port < 65536 or min(self.max_sessions, self.max_seconds, self.idle_seconds) <= 0:
            raise ValueError("port and session limits must be positive; port must be below 65536")


def result(text: str, final: bool = False) -> str:
    return json.dumps({"status": 0, "result": {"hypotheses": [{"transcript": text}], "final": final}})


class Transcript:
    """One connection's decoder state and the cumulative text Kõnele composes in the field."""

    def __init__(self, words: Words):
        self.words = words.fresh()
        self.pending = b""
        self.text = ""

    def feed(self, pcm: bytes) -> str:
        self.pending += pcm
        while len(self.pending) >= CHUNK_BYTES:
            chunk, self.pending = self.pending[:CHUNK_BYTES], self.pending[CHUNK_BYTES:]
            pieces, _ = self.words(np.frombuffer(chunk, dtype="<i2").astype(np.float32) / 32768)
            self.text += "".join(piece.replace("▁", " ") for piece, _ in pieces)
        return self.text.strip()

    def finish(self) -> str:
        padding = (-len(self.pending)) % CHUNK_BYTES
        return self.feed(bytes(padding + FLUSH_CHUNKS * CHUNK_BYTES))


class Dictation:
    def __init__(self, config: Config, words: Words):
        self.config = config
        self.words = words
        self.active = 0

    def authorize(self, connection: ServerConnection, request: Request) -> Response | None:
        url = urlsplit(request.path)
        query = parse_qs(url.query, keep_blank_values=True)
        keys = query.get("key", [])
        # Kõnele cannot set Authorization headers. Keep this token out of proxy access logs too.
        if len(keys) != 1 or not hmac.compare_digest(keys[0].encode(), self.config.token.encode()):
            return connection.respond(HTTPStatus.UNAUTHORIZED, "Unauthorized\n")
        if request.headers.get_all("Origin"):
            return connection.respond(HTTPStatus.FORBIDDEN, "Browser origins are not supported\n")
        if url.path != "/client/ws/speech":
            return connection.respond(HTTPStatus.NOT_FOUND, "Not found\n")
        if query.get("content-type") != [PCM_TYPE]:
            return connection.respond(HTTPStatus.BAD_REQUEST, "Use raw PCM16LE mono at 16000 Hz\n")
        if query.get("lang", ["en-US"]) not in (["en-US"], ["en"]):
            return connection.respond(HTTPStatus.BAD_REQUEST, "Only English is supported\n")
        return None

    async def handle(self, connection: ServerConnection) -> None:
        if self.active >= self.config.max_sessions:
            await connection.send(json.dumps({"status": 9}))
            return
        self.active += 1
        inference = None
        try:
            transcript = Transcript(self.words)
            sent = ""
            received = 0
            async with asyncio.timeout(self.config.max_seconds):
                while True:
                    message = await asyncio.wait_for(connection.recv(), self.config.idle_seconds)
                    if message == "EOS":
                        if received == 0 or len(transcript.pending) % 2:
                            await connection.send(json.dumps({"status": 5}))
                            return
                        inference = asyncio.create_task(asyncio.to_thread(transcript.finish))
                        text = await asyncio.shield(inference)
                        await connection.send(result(text, final=True) if text else json.dumps({"status": 1}))
                        return
                    if not isinstance(message, bytes):
                        await connection.send(json.dumps({"status": 5}))
                        return
                    received += len(message)
                    if received > self.config.max_seconds * RATE * 2:
                        await connection.send(json.dumps({"status": 2}))
                        return
                    inference = asyncio.create_task(asyncio.to_thread(transcript.feed, message))
                    text = await asyncio.shield(inference)
                    if text and text != sent:
                        await connection.send(result(text))
                        sent = text
        except TimeoutError:
            await connection.send(json.dumps({"status": 2}))
        except ConnectionClosed:
            pass
        except Exception as error:  # noqa: BLE001 - ONNX failures terminate only the affected connection
            # Neither speech nor the credential-bearing request URL belongs in a server log.
            log.error("decoder failed: %s", type(error).__name__)
            await connection.close(code=1011, reason="Decoder unavailable")
        finally:
            # Cancelling an await doesn't stop ONNX on its worker thread; retain its slot until it exits.
            if inference is not None:
                await asyncio.gather(inference, return_exceptions=True)
            self.active -= 1


async def run(config: Config) -> None:
    words = Words(config.models / "parakeet_realtime_eou_120m.int8.onnx", config.models / "parakeet_vocab.txt")
    app = Dictation(config, words)
    async with serve(
        app.handle,
        config.host,
        config.port,
        process_request=app.authorize,
        max_size=32000,
        max_queue=4,
        compression=None,
        close_timeout=2,
    ):
        log.info("ready on %s:%s", config.host, config.port)
        await asyncio.Future()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    args = parser.parse_args()
    data = tomllib.loads(args.config.read_text())
    token = Path(data.pop("token_file")).read_text().strip()
    config = Config(models=Path(data.pop("models")), token=token, **data)
    logging.basicConfig(level=logging.INFO, format="%(name)s: %(message)s")
    asyncio.run(run(config))


if __name__ == "__main__":
    main()
