import json
from collections.abc import AsyncIterator
from dataclasses import dataclass

import aiohttp


@dataclass(frozen=True)
class Sentence:
    text: str


@dataclass(frozen=True)
class Done:
    end_conversation: bool


class HeadClient:
    def __init__(self, session: aiohttp.ClientSession, url: str, token: str, channel: str):
        self._session = session
        self._url = url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {token}"}
        self._channel = channel

    async def _post(self, path: str, body: dict) -> dict:
        async with self._session.post(self._url + path, json=body, headers=self._headers) as response:
            response.raise_for_status()
            return await response.json()

    async def open(self, tier: str) -> str:
        return (await self._post("/v1/conversations", {"channel": self._channel, "tier": tier}))["id"]

    async def turn(self, conversation: str, text: str) -> AsyncIterator[Sentence | Done]:
        url = f"{self._url}/v1/conversations/{conversation}/turns"
        timeout = aiohttp.ClientTimeout(total=None, sock_read=120)
        async with self._session.post(url, json={"text": text}, headers=self._headers, timeout=timeout) as response:
            response.raise_for_status()
            event = ""
            async for raw in response.content:
                line = raw.decode().rstrip("\r\n")
                if line.startswith("event:"):
                    event = line[6:].strip()
                elif line.startswith("data:"):
                    data = json.loads(line[5:])
                    if event == "sentence":
                        yield Sentence(data["text"])
                    elif event == "done":
                        yield Done(bool(data["end_conversation"]))
                        return

    async def interrupt(self, conversation: str, heard_text: str) -> None:
        await self._post(f"/v1/conversations/{conversation}/interrupt", {"heard_text": heard_text})

    async def end(self, conversation: str, reason: str) -> None:
        await self._post(f"/v1/conversations/{conversation}/end", {"reason": reason})
