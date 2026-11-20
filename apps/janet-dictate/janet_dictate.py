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
from websockets.protocol import OPEN

log = logging.getLogger("janet-dictate")
PCM_TYPE = "audio/x-raw, layout=(string)interleaved, rate=(int)16000, format=(string)S16LE, channels=(int)1"
CHUNK_BYTES = CHUNK * 2
FLUSH_CHUNKS = 7  # The exported model needs about one second after the last sample to release its tail.
# Stock Kõnele starts recording before the socket upgrades and sends up to 35 s in its first frame.
MAX_MESSAGE_BYTES = 35 * RATE * 2
SEND_TIMEOUT = 2


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
        # Kõnele passes an empty protocol to AndroidAsync, which sends an otherwise invalid empty header.
        if request.headers.get_all("Sec-WebSocket-Protocol") == [""]:
            del request.headers["Sec-WebSocket-Protocol"]
        return None

    async def _send(self, connection: ServerConnection, payload: str) -> bool:
        try:
            async with asyncio.timeout(SEND_TIMEOUT):
                await connection.send(payload)
            return True
        except TimeoutError:
            connection.transport.abort()
            return False
        except ConnectionClosed:
            return False

    async def handle(self, connection: ServerConnection) -> None:
        if self.active >= self.config.max_sessions:
            await self._send(connection, json.dumps({"status": 9}))
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
                            await self._send(connection, json.dumps({"status": 5}))
                            return
                        inference = asyncio.create_task(asyncio.to_thread(transcript.finish))
                        text = await asyncio.shield(inference)
                        await self._send(connection, result(text, final=True) if text else json.dumps({"status": 1}))
                        return
                    if not isinstance(message, bytes):
                        await self._send(connection, json.dumps({"status": 5}))
                        return
                    received += len(message)
                    if received > self.config.max_seconds * RATE * 2:
                        await self._send(connection, json.dumps({"status": 2}))
                        return
                    for offset in range(0, len(message), CHUNK_BYTES):
                        if connection.state is not OPEN:
                            return
                        piece = message[offset : offset + CHUNK_BYTES]
                        if len(transcript.pending) + len(piece) < CHUNK_BYTES:
                            transcript.pending += piece
                            continue
                        inference = asyncio.create_task(asyncio.to_thread(transcript.feed, piece))
                        text = await asyncio.shield(inference)
                        if text and text != sent:
                            if not await self._send(connection, result(text)):
                                return
                            sent = text
        except TimeoutError:
            await self._send(connection, json.dumps({"status": 2}))
        except ConnectionClosed:
            pass
        except Exception as error:  # noqa: BLE001 - ONNX failures terminate only the affected connection
            # Neither speech nor the credential-bearing request URL belongs in a server log.
            log.error("decoder failed: %s", type(error).__name__)
            try:
                async with asyncio.timeout(SEND_TIMEOUT):
                    await connection.close(code=1011, reason="Decoder unavailable")
            except TimeoutError:
                connection.transport.abort()
        finally:
            # Cancelling an await doesn't stop ONNX on its worker thread; retain its slot until it exits.
            if inference is not None:
                await asyncio.gather(inference, return_exceptions=True)
            self.active -= 1


def transport_logger() -> logging.Logger:
    """Suppress websockets tracebacks and debug logs that can include credential-bearing request lines."""
    logger = logging.getLogger("janet-dictate.transport")
    logger.handlers = [logging.NullHandler()]
    logger.propagate = False
    logger.setLevel(logging.CRITICAL + 1)
    return logger


def serve_dictation(app: Dictation, host: str, port: int) -> serve:
    return serve(
        app.handle,
        host,
        port,
        process_request=app.authorize,
        max_size=MAX_MESSAGE_BYTES,
        max_queue=4,
        compression=None,
        close_timeout=SEND_TIMEOUT,
        logger=transport_logger(),
    )


async def run(config: Config) -> None:
    words = Words(config.models / "parakeet_realtime_eou_120m.int8.onnx", config.models / "parakeet_vocab.txt")
    app = Dictation(config, words)
    async with serve_dictation(app, config.host, config.port):
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
