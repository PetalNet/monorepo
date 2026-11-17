"""One Home Assistant conversation is one head conversation. No Home Assistant imports."""

from __future__ import annotations

import re
from collections.abc import AsyncIterator

from .head import Done, HeadClient, HeadError, Sentence

PERSONAL = "personal"
GUEST = "guest"


def tier_for(user_id: str | None, owner_user_id: str) -> str:
    """The owner tier is Parker's Home Assistant user and nobody else; anything unproved is a guest."""
    return PERSONAL if user_id and owner_user_id and user_id == owner_user_id else GUEST


def surface_for(device_name: str | None) -> str:
    """The channel the exchange is filed under in the shared history: ha:<device>."""
    slug = re.sub(r"[^a-z0-9]+", "-", (device_name or "").lower()).strip("-")
    return f"ha:{slug or 'assist'}"


class Sessions:
    def __init__(self, head: HeadClient, owner_user_id: str):
        self._head = head
        self._owner = owner_user_id
        self._open: dict[str, tuple[str, str]] = {}
        self._generation: dict[str, int] = {}

    async def _ensure(self, ha_id: str, channel: str, tier: str) -> str:
        known = self._open.get(ha_id)
        if known is not None and known[1] == tier:
            return known[0]
        generation = self._generation.get(ha_id, 0)
        head_id = await self._head.open(channel, tier, f"{ha_id}:{generation}")
        self._open[ha_id] = (head_id, tier)
        return head_id

    def _forget(self, ha_id: str) -> None:
        self._open.pop(ha_id, None)
        self._generation[ha_id] = self._generation.get(ha_id, 0) + 1

    async def turn(
        self, ha_id: str, user_id: str | None, device_name: str | None, text: str
    ) -> AsyncIterator[Sentence | Done]:
        tier, channel = tier_for(user_id, self._owner), surface_for(device_name)
        for attempt in range(2):
            head_id = await self._ensure(ha_id, channel, tier)
            started = False
            try:
                async for item in self._head.turn(head_id, text):
                    started = True
                    if isinstance(item, Done) and item.end_conversation:
                        self._forget(ha_id)
                        await self._end_quietly(head_id, "end phrase")
                    yield item
                return
            except HeadError as error:
                # 404 and 409 before any speech: the head ended or forgot it (idle timeout). Start a new one once.
                if started or attempt or error.status not in (404, 409):
                    raise
                self._forget(ha_id)

    async def _end_quietly(self, head_id: str, reason: str) -> None:
        try:
            await self._head.end(head_id, reason)
        except HeadError:
            pass
