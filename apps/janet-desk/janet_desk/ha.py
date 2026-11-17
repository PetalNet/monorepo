import asyncio
from collections.abc import AsyncIterator

import aiohttp

from .audio import MIC_RATE
from .client import Heard, SpeechStarted, Transcript, Unintelligible, WakeWord


class AssistError(Exception):
    pass


class AssistListener:
    def __init__(self, session: aiohttp.ClientSession, url: str, token: str, pipeline: str, run_seconds: int = 3600):
        self._session = session
        self._url = url.rstrip("/").replace("http", "ws", 1) + "/api/websocket"
        self._token = token
        self._pipeline = pipeline
        self._run_seconds = run_seconds
        self._pipeline_id: str | None = None

    async def listen(self, audio: asyncio.Queue[bytes | None], *, wake_word: bool) -> AsyncIterator[Heard]:
        async with self._session.ws_connect(self._url, heartbeat=30) as socket:
            await socket.receive_json()
            await socket.send_json({"type": "auth", "access_token": self._token})
            if (await socket.receive_json())["type"] != "auth_ok":
                raise AssistError("Home Assistant rejected the token")
            if self._pipeline_id is None:
                self._pipeline_id = await self._find_pipeline(socket)
            await socket.send_json(
                {
                    "id": 2,
                    "type": "assist_pipeline/run",
                    "pipeline": self._pipeline_id,
                    "start_stage": "wake_word" if wake_word else "stt",
                    "end_stage": "stt",
                    # A wake word timeout of 0 waits for as long as the run lasts.
                    "input": {"sample_rate": MIC_RATE, "timeout": 0} if wake_word else {"sample_rate": MIC_RATE},
                    "timeout": self._run_seconds,
                }
            )
            sending: asyncio.Task[None] | None = None
            waiting_for_wake_word = wake_word
            try:
                async for message in socket:
                    if message.type is not aiohttp.WSMsgType.TEXT:
                        continue
                    body = message.json()
                    if body["type"] == "result" and not body["success"]:
                        raise AssistError(f"Home Assistant refused the pipeline run: {body['error']}")
                    if body["type"] != "event":
                        continue
                    kind, data = body["event"]["type"], body["event"].get("data") or {}
                    match kind:
                        case "run-start":
                            handler = data["runner_data"]["stt_binary_handler_id"]
                            sending = asyncio.create_task(self._send(socket, audio, handler))
                        case "wake_word-end" if data.get("wake_word_output"):
                            waiting_for_wake_word = False
                            yield WakeWord()
                        case "stt-vad-start":
                            yield SpeechStarted()
                        case "stt-end":
                            text = data["stt_output"]["text"].strip()
                            yield Transcript(text) if text else Unintelligible()
                        case "error":
                            if data.get("code") == "stt-no-text-recognized":
                                yield Unintelligible()
                            elif not (data.get("code") == "timeout" and waiting_for_wake_word):
                                raise AssistError(f"{data.get('code')}: {data.get('message')}")
                            return
                        case "run-end":
                            return
            finally:
                if sending:
                    sending.cancel()

    async def _find_pipeline(self, socket: aiohttp.ClientWebSocketResponse) -> str:
        await socket.send_json({"id": 1, "type": "assist_pipeline/pipeline/list"})
        result = (await socket.receive_json())["result"]
        for pipeline in result["pipelines"]:
            if pipeline["name"] == self._pipeline:
                return pipeline["id"]
        raise AssistError(f"Home Assistant has no Assist pipeline named {self._pipeline!r}")

    @staticmethod
    async def _send(socket: aiohttp.ClientWebSocketResponse, audio: asyncio.Queue[bytes | None], handler: int) -> None:
        prefix = bytes([handler])
        while (frame := await audio.get()) is not None:
            await socket.send_bytes(prefix + frame)
        await socket.send_bytes(prefix)
