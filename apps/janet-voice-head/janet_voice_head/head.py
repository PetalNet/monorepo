import logging
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from . import prompts
from .conversation import Conversation, Exchange, Journal, TranscriptMark
from .merge import Hub, HubError, HubRefused
from .render import fallback_summary, hard_text, soft_text, stub_text
from .session import LOCKED_FLAGS, ClaudeSession, SessionError, transcript_path
from .speech import SIGN_OFF, SpeechStream, is_end_phrase

log = logging.getLogger("janet-voice-head")
NO_ANSWER = "Sorry, I could not answer that."
RELAYED = "Okay, I will pass that to main Janet."
IDLE_TIMEOUT = "idle_timeout"
Emit = Callable[[str, dict], None]


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


@dataclass
class Config:
    state_dir: Path
    hub: Hub
    main_cwd: str
    claude: list[str] = field(default_factory=lambda: ["claude"])
    model: str = "opus"
    cold_model: str = "haiku"
    effort: str = "low"
    soft_merge: str = "asks"
    idle_timeout_s: float = 120
    ready_timeout_s: float = 30
    turn_timeout_s: float = 60
    max_open: int = 2
    warm_up: bool = True
    unmerged_channels: list[str] = field(default_factory=list)


def _set_event() -> threading.Event:
    event = threading.Event()
    event.set()
    return event


@dataclass
class Live:
    conv: Conversation
    journal: Journal
    session: ClaudeSession | None = None
    # Where main's transcript stood when a fork was started from it.
    fork_point: TranscriptMark | None = None
    last_activity: float = field(default_factory=time.monotonic)
    in_turn: bool = False
    cut_off: str | None = None
    lock: threading.RLock = field(default_factory=threading.RLock)
    turn_lock: threading.Lock = field(default_factory=threading.Lock)
    end_lock: threading.Lock = field(default_factory=threading.Lock)
    merge_lock: threading.Lock = field(default_factory=threading.Lock)
    # Clear while a fork's warm-up call is running; the speaker's first turn waits for it.
    warm: threading.Event = field(default_factory=lambda: _set_event())

    def record(self, **fields) -> None:
        with self.lock:
            self.conv = self.journal.append(self.conv, at=time.time(), **fields)


class Head:
    def __init__(self, config: Config, session_factory=ClaudeSession):
        self.config, self._session_factory = config, session_factory
        self._lives: dict[str, Live] = {}
        self._by_ref: dict[str, str] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._journals = config.state_dir / "conversations"
        self._journals.mkdir(parents=True, exist_ok=True)
        (config.state_dir / "cold").mkdir(exist_ok=True)
        (config.state_dir / "fork").mkdir(exist_ok=True)
        self._recover()
        threading.Thread(target=self._upkeep_loop, daemon=True).start()

    def open(self, channel: str, tier: str, client_ref: str | None) -> str:
        with self._lock:
            if client_ref and client_ref in self._by_ref:
                return self._by_ref[client_ref]
            if sum(live.conv.state == "open" for live in self._lives.values()) >= self.config.max_open:
                raise ApiError(429, "too many open conversations")
            conv_id = uuid.uuid4().hex[:12]
            journal = Journal(self._journals / f"{conv_id}.jsonl")
            fork = tier == "personal"
            try:
                fork_point = self.config.hub.transcript_mark() if fork else None
                parent = self.config.hub.main_session() if fork else None
                if parent:
                    self._expose_parent(parent)
            except HubError as error:
                raise ApiError(503, f"cannot find main's session: {error}") from error
            except OSError as error:
                raise ApiError(503, f"cannot link main's transcript: {error}") from error
            conv = journal.append(None, kind="opened", at=time.time(), id=conv_id, channel=channel, tier=tier,
                                  client_ref=client_ref, parent_session=parent)
            live = Live(conv, journal)
            try:
                live.session = self._session_factory(self._argv(conv), self._cwd(conv))
            except OSError as error:
                live.record(kind="ending", reason="session_failed_to_start")
                raise ApiError(503, f"the head session did not start: {error}") from error
            finally:
                self._lives[conv_id] = live
            if client_ref:
                self._by_ref[client_ref] = conv_id
        if fork:
            live.fork_point = fork_point
            threading.Thread(target=self._note_session, args=(live,), daemon=True).start()
        if fork and self.config.warm_up:
            live.warm.clear()
            threading.Thread(target=self._warm_up, args=(live,), daemon=True).start()
        return conv_id

    def turn(self, conv_id: str, text: str, emit: Emit) -> None:
        live = self._open_live(conv_id)
        live.warm.wait(self.config.ready_timeout_s + self.config.turn_timeout_s)
        if not live.turn_lock.acquire(blocking=False):
            raise ApiError(409, "a turn is already in flight; interrupt it first")
        if live.conv.state != "open":
            live.turn_lock.release()
            raise ApiError(409, "the conversation has ended")
        started = time.monotonic()
        latency: dict[str, int | None] = {"first_token": None, "first_sentence": None, "total": None}
        client_connected = True

        def say(sentence: str) -> None:
            nonlocal client_connected
            if latency["first_sentence"] is None:
                latency["first_sentence"] = _ms(started)
            if client_connected:
                try:
                    emit("sentence", {"text": sentence})
                except OSError:
                    client_connected = False
                    live.session.interrupt()

        try:
            with live.lock:
                live.in_turn, live.cut_off, live.last_activity = True, None, time.monotonic()
                number = len(live.conv.exchanges) + 1
                previous_cut = live.conv.exchanges[-1].heard_before_cutoff if live.conv.exchanges else None
            stream, end, session = SpeechStream(), False, live.session
            if is_end_phrase(text):
                say(SIGN_OFF)
                live.record(kind="sign_off", heard=text)
                end = True
            else:
                try:
                    session.wait_ready(self.config.ready_timeout_s)
                    latency["spawn_wait"] = _ms(started)
                    fork = live.conv.tier == "personal"
                    stream = SpeechStream(redact=None if fork else session.account_email)
                    for delta in session.turn(prompts.turn_prompt(text, fork=fork, cut_off=previous_cut), self.config.turn_timeout_s):
                        if latency["first_token"] is None:
                            latency["first_token"] = _ms(started)
                        for sentence in stream.feed(delta):
                            say(sentence)
                    for sentence in stream.finish():
                        say(sentence)
                except SessionError as error:
                    log.warning("conversation %s: %s", conv_id, error)
                    end = True
                relay = stream.relay
                if latency["first_sentence"] is None and live.cut_off is None:
                    say(RELAYED if relay and not end else NO_ANSWER)
                with live.lock:
                    live.record(kind="exchange", n=number, heard=text, said=stream.spoken, asks=relay.asks, commitments=relay.commitments)
                    if live.cut_off is not None:
                        live.record(kind="interrupted", n=number, heard_text=live.cut_off)
                    live.in_turn = False
                self._note_session(live)
                if self._merges(live) and live.conv.tier == "personal" and (relay or self.config.soft_merge == "every"):
                    threading.Thread(target=self._soft_merge, args=(live, number), daemon=True).start()
            with live.lock:
                live.in_turn, live.last_activity = False, time.monotonic()
            latency["total"] = _ms(started)
            if client_connected:
                try:
                    emit("done", {"end_conversation": end, "latency_ms": latency})
                except OSError:
                    pass
        finally:
            live.in_turn = False
            live.turn_lock.release()

    def interrupt(self, conv_id: str, heard_text: str) -> None:
        live = self._open_live(conv_id)
        with live.lock:
            if live.in_turn:
                live.cut_off = heard_text
                live.session.interrupt()
            elif live.conv.exchanges:
                live.record(kind="interrupted", n=live.conv.exchanges[-1].n, heard_text=heard_text)
            live.last_activity = time.monotonic()

    def end(self, conv_id: str, reason: str) -> dict:
        live = self._live(conv_id)
        with live.end_lock:
            if live.conv.state == "open":
                if live.session is not None:
                    live.session.interrupt()
                with live.turn_lock:
                    live.record(kind="ending", reason=reason)
                    self._summarize(live, reason)
                    if live.session is not None:
                        self._note_session(live)
                        live.session.close()
            try:
                self._merge(live)
            except HubError as error:
                log.warning("conversation %s: hard merge waits: %s", conv_id, error)
                raise ApiError(503, "main is unreachable; the merge is retried until it lands") from error
        return {"merged": live.conv.delivered, "delivery": live.conv.delivery}

    def close(self) -> None:
        self._stop.set()
        for live in list(self._lives.values()):
            if live.session is not None:
                live.session.close()

    def _live(self, conv_id: str) -> Live:
        live = self._lives.get(conv_id)
        if live is None:
            raise ApiError(404, "no such conversation")
        return live

    def _open_live(self, conv_id: str) -> Live:
        live = self._live(conv_id)
        if live.conv.state != "open":
            raise ApiError(409, "the conversation has ended")
        return live

    def _merges(self, live: Live) -> bool:
        return live.conv.channel not in self.config.unmerged_channels

    def _cwd(self, conv: Conversation) -> str:
        return str(self.config.state_dir / ("fork" if conv.tier == "personal" else "cold"))

    def _expose_parent(self, parent: str) -> None:
        link = transcript_path(str(self.config.state_dir / "fork"), parent)
        link.parent.mkdir(parents=True, exist_ok=True)
        if not link.is_symlink():
            link.symlink_to(transcript_path(self.config.main_cwd, parent))

    def _argv(self, conv: Conversation) -> list[str]:
        if conv.parent_session:
            identity = ["--resume", conv.parent_session, "--fork-session", "--model", self.config.model]
        else:
            identity = ["--model", self.config.cold_model, "--system-prompt", prompts.COLD_PROFILE]
        return [*self.config.claude, *LOCKED_FLAGS, *identity, "--effort", self.config.effort]

    def _warm_up(self, live: Live) -> None:
        """A fork's first model call reads all of main's context cold and takes seconds. Making it while the speaker is still talking hides that wait."""
        try:
            with live.turn_lock:
                if live.conv.state != "open":
                    return
                live.session.wait_ready(self.config.ready_timeout_s)
                for _ in live.session.turn(prompts.WARM_UP, self.config.turn_timeout_s):
                    pass
        except SessionError as error:
            log.warning("conversation %s: warm-up: %s", live.conv.id, error)
        finally:
            live.warm.set()

    def _note_session(self, live: Live) -> None:
        """Records the session's id once it is known: at resume for some forks, after the first turn otherwise."""
        session = live.session
        try:
            session.wait_ready(self.config.ready_timeout_s)
        except SessionError as error:
            log.warning("conversation %s: %s", live.conv.id, error)
        with live.lock:
            if session.session_id and live.conv.session_id is None:
                live.record(kind="session", session_id=session.session_id, fork_point=live.fork_point,
                            transcript=str(transcript_path(self._cwd(live.conv), session.session_id)))

    def _summarize(self, live: Live, reason: str) -> None:
        if reason == IDLE_TIMEOUT or len(live.conv.exchanges) < 2 or live.session is None or live.session.failure:
            return
        stream = SpeechStream()
        try:
            for delta in live.session.turn(prompts.SUMMARY, self.config.turn_timeout_s):
                stream.feed(delta)
        except SessionError as error:
            log.warning("conversation %s: no summary: %s", live.conv.id, error)
            return
        if stream.spoken:
            live.record(kind="summary", text=stream.spoken)

    def _deliver(self, source: str, key: str, text: str, attempted_at: TranscriptMark | None, record_attempt: Callable[[TranscriptMark], None]) -> str:
        hub = self.config.hub
        if attempted_at is None:
            record_attempt(hub.transcript_mark())
        elif not hub.drops_repeats() and (where := hub.has(key, attempted_at)):
            return f"found in {where}"
        return "injected " + hub.inject(source, text, key)

    def _soft_merge(self, live: Live, number: int) -> None:
        with live.merge_lock:
            exchange = live.conv.exchange(number)
            if exchange is None or exchange.soft == "merged" or live.conv.state != "open":
                return
            key = f"voice-soft:{live.conv.id}:{number}"
            try:
                delivery = self._deliver(
                    "voice-soft", key, soft_text(live.conv, exchange, key, live.journal.path),
                    exchange.soft_attempted_at if exchange.soft == "sending" else None,
                    lambda mark: live.record(kind="soft_sending", n=number, since=mark))
            except HubRefused as error:
                log.error("conversation %s: the hub refused soft merge %d for good: %s", live.conv.id, number, error)
                live.record(kind="soft_refused", n=number, error=str(error))
                return
            except HubError as error:
                log.warning("conversation %s: soft merge %d waits: %s", live.conv.id, number, error)
                return
            live.record(kind="soft_merged", n=number, delivery=delivery)

    def _settle_soft(self, live: Live, exchange: Exchange) -> None:
        if exchange.soft == "sending" and (where := self.config.hub.has(f"voice-soft:{live.conv.id}:{exchange.n}", exchange.soft_attempted_at)):
            live.record(kind="soft_merged", n=exchange.n, delivery=f"found in {where}")

    def _merge(self, live: Live) -> None:
        with live.merge_lock:
            if live.conv.state == "ending":
                if not live.conv.exchanges:
                    live.record(kind="merged", delivery="nothing to deliver")
                elif not self._merges(live):
                    live.record(kind="merged", delivery="channel is not merged")
                else:
                    for exchange in live.conv.exchanges:
                        self._settle_soft(live, exchange)
                    key = f"voice-hard:{live.conv.id}"
                    if live.conv.summary is None:
                        live.record(kind="summary", text=fallback_summary(live.conv))
                    self._send_hard(live, key)
            if live.conv.state == "merged":
                live.record(kind="archived")

    def _send_hard(self, live: Live, key: str) -> None:
        path = live.journal.path
        refusal = ""
        for text in (lambda: hard_text(live.conv, key, path), lambda: stub_text(live.conv, key, path, refusal)):
            try:
                delivery = self._deliver("voice-hard", key, text(), live.conv.hard_attempted_at,
                                         lambda mark: live.record(kind="hard_sending", key=key, since=mark))
            except HubRefused as error:
                refusal = str(error)
                log.error("conversation %s: the hub refused the hard merge for good: %s", live.conv.id, error)
                live.record(kind="hard_refused", error=refusal)
                continue
            live.record(kind="merged", delivery=delivery)
            return
        live.record(kind="undeliverable", delivery=f"undeliverable: {refusal}; the full text stays in {path}")

    def _recover(self) -> None:
        for path in sorted(self._journals.glob("*.jsonl")):
            journal = Journal(path)
            conv = journal.load()
            if conv is None:
                continue
            live = self._lives[conv.id] = Live(conv, journal)
            if conv.client_ref:
                self._by_ref[conv.client_ref] = conv.id
            if conv.state == "open":
                live.record(kind="ending", reason="head_restart")

    def _upkeep_loop(self) -> None:
        while True:
            for live in list(self._lives.values()):
                try:
                    self._finish_or_expire(live)
                except (ApiError, HubError) as error:
                    log.warning("conversation %s: %s", live.conv.id, error)
                except Exception:
                    log.exception("conversation %s: upkeep failed", live.conv.id)
            if self._stop.wait(2):
                return

    def _finish_or_expire(self, live: Live) -> None:
        if live.conv.state == "open":
            if not live.in_turn and time.monotonic() - live.last_activity > self.config.idle_timeout_s:
                self.end(live.conv.id, IDLE_TIMEOUT)
            for exchange in live.conv.exchanges:
                if exchange.soft == "sending":
                    self._soft_merge(live, exchange.n)
        elif live.conv.state != "archived" and live.end_lock.acquire(blocking=False):
            try:
                self._merge(live)
            finally:
                live.end_lock.release()


def _ms(started: float) -> int:
    return round((time.monotonic() - started) * 1000)
