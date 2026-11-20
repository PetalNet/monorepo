import json
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Literal

State = Literal["open", "ending", "merged", "archived"]
TIERS = ("personal", "room", "guest")
LEAST_PRIVILEGED = "guest"


@dataclass(frozen=True)
class TranscriptMark:
    """A point in main's transcript. Whatever the hub delivers after the mark was taken lies past it."""

    transcript: str
    size: int


def _mark(value: dict | None) -> TranscriptMark | None:
    return TranscriptMark(**value) if value else None


@dataclass
class Exchange:
    n: int
    heard: str
    said: str
    asks: list[str] = field(default_factory=list)
    commitments: list[str] = field(default_factory=list)
    heard_before_cutoff: str | None = None
    soft: str = "none"
    soft_attempted_at: TranscriptMark | None = None


@dataclass
class Conversation:
    id: str
    channel: str
    tier: str
    client_ref: str | None
    opened_at: float
    lab_access: bool = False
    parent_session: str | None = None
    session_id: str | None = None
    fork_point: TranscriptMark | None = None
    transcript: str | None = None
    state: State = "open"
    end_reason: str | None = None
    ended_at: float | None = None
    summary: str | None = None
    hard_attempted_at: TranscriptMark | None = None
    delivery: str | None = None
    delivered: bool = False
    exchanges: list[Exchange] = field(default_factory=list)

    def exchange(self, n: int) -> Exchange | None:
        return next((x for x in self.exchanges if x.n == n), None)


def apply(conv: Conversation | None, record: dict) -> Conversation:
    kind = record["kind"]
    if kind == "opened":
        return Conversation(id=record["id"], channel=record["channel"], tier=record["tier"],
                            client_ref=record.get("client_ref"), opened_at=record["at"],
                            parent_session=record.get("parent_session"), lab_access=record.get("lab_access", False))
    assert conv is not None, "a journal starts with its opened record"
    if kind == "session":
        conv.session_id, conv.fork_point, conv.transcript = record["session_id"], _mark(record.get("fork_point")), record.get("transcript")
    elif kind == "exchange":
        conv.exchanges.append(Exchange(n=record["n"], heard=record["heard"], said=record["said"],
                                       asks=record.get("asks", []), commitments=record.get("commitments", [])))
    elif kind == "interrupted":
        if (exchange := conv.exchange(record["n"])) is not None:
            exchange.heard_before_cutoff = record["heard_text"]
    elif kind in ("soft_sending", "soft_merged", "soft_refused"):
        if (exchange := conv.exchange(record["n"])) is not None:
            exchange.soft = kind.removeprefix("soft_")
            exchange.soft_attempted_at = _mark(record.get("since")) or exchange.soft_attempted_at
    elif kind == "ending":
        conv.state, conv.end_reason, conv.ended_at = "ending", record["reason"], record["at"]
    elif kind == "summary":
        conv.summary = record["text"]
    elif kind == "hard_sending":
        conv.hard_attempted_at = _mark(record.get("since"))
    elif kind == "merged":
        conv.state, conv.delivery, conv.delivered = "merged", record["delivery"], True
    elif kind == "undeliverable":
        conv.state, conv.delivery, conv.delivered = "archived", record["delivery"], False
    elif kind == "archived":
        conv.state = "archived"
    return conv


class Journal:
    def __init__(self, path: Path):
        self.path = path

    def append(self, conv: Conversation | None, **record) -> Conversation:
        line = json.dumps(record, ensure_ascii=False, default=asdict) + "\n"
        fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(fd, line.encode())
            os.fsync(fd)
        finally:
            os.close(fd)
        return apply(conv, json.loads(line))

    def load(self) -> Conversation | None:
        conv, good = None, 0
        with open(self.path, "rb") as lines:
            for line in lines:
                try:
                    record = json.loads(line)
                except ValueError:
                    break
                conv, good = apply(conv, record), good + len(line)
        self._drop_torn_last_line(good)
        return conv

    def _drop_torn_last_line(self, complete_bytes: int) -> None:
        """A crash mid-write leaves half a line; the next record has to start on a line of its own."""
        if complete_bytes < self.path.stat().st_size:
            os.truncate(self.path, complete_bytes)
