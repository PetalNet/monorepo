"""Client for the voice head's conversation API (apps/janet-voice-head). No Home Assistant imports."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass

import aiohttp


class HeadError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class Sentence:
    text: str


@dataclass(frozen=True)
class Done:
    end_conversation: bool
    latency_ms: dict


class HeadClient:
    def __init__(self, session: aiohttp.ClientSession, base_url: str, token: str):
        self._session = session
        self._base = base_url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {token}"}

    async def _json(self, path: str, body: dict) -> dict:
        try:
            async with self._session.post(
                self._base + path, json=body, headers=self._headers, timeout=aiohttp.ClientTimeout(total=30)
            ) as response:
                data = await response.json(content_type=None)
                if response.status != 200:
                    raise HeadError(str(data.get("error", response.status)), response.status)
                return data
        except (aiohttp.ClientError, TimeoutError) as error:
            raise HeadError(f"head unreachable: {error}") from error

    async def check(self) -> None:
        """Raises HeadError(401) for a bad token. The empty channel is refused after the token check, so nothing starts."""
        try:
            await self._json("/v1/conversations", {"channel": ""})
        except HeadError as error:
            if error.status != 400:
                raise

    async def open(self, channel: str, tier: str, client_ref: str) -> str:
        return (await self._json("/v1/conversations", {"channel": channel, "tier": tier, "client_ref": client_ref}))["id"]

    async def end(self, conversation_id: str, reason: str) -> None:
        await self._json(f"/v1/conversations/{conversation_id}/end", {"reason": reason})

    async def interrupt(self, conversation_id: str, heard_text: str) -> None:
        await self._json(f"/v1/conversations/{conversation_id}/interrupt", {"heard_text": heard_text})

    async def turn(self, conversation_id: str, text: str) -> AsyncIterator[Sentence | Done]:
        """Yields each sentence as the head produces it, then Done. A failure before the first byte raises HeadError."""
        try:
            async with self._session.post(
                f"{self._base}/v1/conversations/{conversation_id}/turns",
                json={"text": text},
                headers=self._headers,
                timeout=aiohttp.ClientTimeout(total=120, sock_read=60),
            ) as response:
                if response.status != 200:
                    data = await response.json(content_type=None)
                    raise HeadError(str(data.get("error", response.status)), response.status)
                async for item in parse_events(response.content):
                    yield item
        except (aiohttp.ClientError, TimeoutError) as error:
            raise HeadError(f"head unreachable: {error}") from error


async def parse_events(lines: AsyncIterator[bytes]) -> AsyncIterator[Sentence | Done]:
    event, data = None, []
    async for raw in lines:
        line = raw.decode("utf-8").rstrip("\r\n")
        if line:
            if line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:"):
                data.append(line[5:].lstrip())
            continue
        if event is not None:
            item = _item(event, "\n".join(data))
            if item is not None:
                yield item
        event, data = None, []


def _item(event: str, data: str) -> Sentence | Done | None:
    try:
        body = json.loads(data)
    except ValueError as error:
        raise HeadError(f"malformed {event} event") from error
    if event == "sentence":
        return Sentence(str(body["text"]))
    if event == "done":
        return Done(bool(body.get("end_conversation")), body.get("latency_ms") or {})
    return None
