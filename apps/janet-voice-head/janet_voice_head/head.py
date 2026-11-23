import json
import logging
import subprocess
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from . import prompts, lab_tools, call_tools
from .conversation import Conversation, Exchange, Journal, TranscriptMark
from .merge import Hub, HubError, HubRefused
from . import cache_splice, snapshot, web_guard
from .render import fallback_summary, hard_text, soft_text, stub_text
from .session import ClaudeSession, locked_flags, SessionError, UnspokenText, session_env, transcript_path
from .speech import SpeechStream

log = logging.getLogger("janet-voice-head")
NO_ANSWER = "Sorry, I could not answer that."
RELAYED = "Okay, I will pass that to main Janet."
ASK_TO_CONTINUE = "Could you say a little more?"
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
    # A first turn that has to wait for a cold fork says one short line after this many seconds. 0 turns it off.
    bridge_after_s: float = 1.0
    bridge_phrases: list[str] = field(default_factory=lambda: ["Mm, one sec.", "Let me think.", "Hang on a sec."])
    # A fork resumes a copy of main's transcript from its last compaction on, not the whole file.
    trim_transcript: bool = True
    trim_max_bytes: int = 64 * 1024 * 1024
    # 0 makes a fresh copy for every conversation. Forks of one copy share the model's prompt cache.
    trim_reuse_s: float = 0
    # The fork's request matches main's prompt cache only when it carries main's tools, so this launches it as main is
    # launched (main's plugins and tool set from main_like_args, main_like_env) with permission mode dontAsk and no
    # settings files, so no allow rule can run a tool. Plugin hooks still run and read-only tools are still allowed:
    # deny them with permissions.deny in a --settings file passed in main_like_args. The fork then runs in
    # main's directory. cache_splice adds a loopback proxy that gives the fork's request main's exact prefix (see
    # cache_splice.py). Off by default: the lean fork below has no tools at all. web_tools works in this mode too: its
    # settings are merged into the --settings file in main_like_args (see web_guard.main_like_args).
    main_like_fork: bool = False
    main_like_args: list[str] = field(default_factory=list)
    main_like_env: dict[str, str] = field(default_factory=dict)
    cache_splice: bool = True
    unmerged_channels: list[str] = field(default_factory=list)
    # Public web tools from web_guard.TOOLS. Guests never get them; the lab MCP server is gated separately.
    web_tools: list[str] = field(default_factory=list)
    lab_token_file: str = ""
    tts_unload_command: list[str] = field(default_factory=list)


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
    # True once the fork has answered anything, the warm-up included. Until then its first word is slow.
    answered: bool = False
    # A turn has arrived and is waiting for the warm-up or running; a second one is refused at once.
    turn_pending: bool = False
    timing_turn: int = 0
    # A barge-in that arrived while that turn was still waiting.
    early_cut: str | None = None
    ending: threading.Event = field(default_factory=threading.Event)

    def record(self, **fields) -> None:
        with self.lock:
            self.conv = self.journal.append(self.conv, at=time.time(), **fields)


class Head:
    def __init__(self, config: Config, session_factory=ClaudeSession):
        self.config, self._session_factory = config, session_factory
        self._lives: dict[str, Live] = {}
        self._snapshot: tuple[str, str, float] | None = None
        self._proxy = None
        self._by_ref: dict[str, str] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._tts_release_pending = False
        self._journals = config.state_dir / "conversations"
        self._journals.mkdir(parents=True, exist_ok=True)
        (config.state_dir / "cold").mkdir(exist_ok=True)
        (config.state_dir / "fork").mkdir(exist_ok=True)
        if config.main_like_fork and config.cache_splice:
            self._proxy = cache_splice.serve_in_background(self._main_transcript, self._main_session)
        self._recover()
        threading.Thread(target=self._upkeep_loop, daemon=True).start()

    def open(self, channel: str, tier: str, client_ref: str | None, lab_access: bool = False) -> str:
        with self._lock:
            if client_ref and client_ref in self._by_ref:
                previous = self._lives[self._by_ref[client_ref]].conv
                if (previous.lab_access, previous.tier, previous.channel) != (lab_access, tier, channel):
                    raise ApiError(403, "client_ref belongs to another caller class")
                return previous.id
            if sum(live.conv.state == "open" for live in self._lives.values()) >= self.config.max_open:
                raise ApiError(429, "too many open conversations")
            if lab_access and (tier != "personal" or self.config.main_like_fork):
                raise ApiError(400, "lab access requires a lean personal head")
            conv_id = uuid.uuid4().hex[:12]
            journal = Journal(self._journals / f"{conv_id}.jsonl")
            fork = tier == "personal"
            try:
                fork_point = self.config.hub.transcript_mark() if fork else None
                parent = self.config.hub.main_session() if fork else None
                resume = self._resume_target(parent) if parent else None
            except HubError as error:
                raise ApiError(503, f"cannot find main's session: {error}") from error
            except OSError as error:
                raise ApiError(503, f"cannot link main's transcript: {error}") from error
            conv = journal.append(None, kind="opened", at=time.time(), id=conv_id, channel=channel, tier=tier,
                                  client_ref=client_ref, parent_session=parent, lab_access=lab_access)
            live = Live(conv, journal)
            try:
                if fork and self.config.main_like_fork:
                    live.session = self._session_factory(self._argv(conv, resume), self._cwd(conv), env=self._main_like_env(), allow_tools=True)
                else:
                    live.session = self._session_factory(self._argv(conv, resume), self._cwd(conv), web_tools=self._web_tools(conv, resume), **({"lab": True} if lab_access else {}))
            except (OSError, ValueError) as error:
                live.record(kind="ending", reason="session_failed_to_start")
                raise ApiError(503, f"the head session did not start: {error}") from error
            finally:
                self._lives[conv_id] = live
                if live.conv.state != "open":
                    self._tts_release_pending = True
            if client_ref:
                self._by_ref[client_ref] = conv_id
        if fork:
            live.fork_point = fork_point
            threading.Thread(target=self._note_session, args=(live,), daemon=True).start()
        if fork and self.config.warm_up:
            live.warm.clear()
            threading.Thread(target=self._warm_up, args=(live,), daemon=True).start()
        return conv_id

    def turn(self, conv_id: str, text: str, emit: Emit, *, allow_silence: bool = False) -> None:
        live = self._open_live(conv_id)
        arrived = time.monotonic()
        arrived_at = time.time()
        spoken, emit_lock, bridge_ms = threading.Event(), threading.Lock(), []
        # A cold fork takes seconds to its first word. Until then one short line keeps the speaker from sitting in silence.
        # Never on a turn that starts warm, and at most once, and never after the real reply has begun.
        cold = (self.config.bridge_after_s > 0 and self.config.bridge_phrases and live.conv.tier == "personal"
                and not live.answered and not live.conv.exchanges)

        def bridge() -> None:
            with emit_lock:
                if spoken.is_set():
                    return
                phrase = self.config.bridge_phrases[int.from_bytes(live.conv.id.encode()[:2], "big") % len(self.config.bridge_phrases)]
                try:
                    emit("sentence", {"text": phrase, "bridge": True, "conversation_id": conv_id, "turn": turn_number})
                    bridge_ms.append(_ms(arrived))
                except OSError:
                    pass

        with live.lock:
            if live.turn_pending:
                raise ApiError(409, "a turn is already in flight; interrupt it first")
            live.turn_pending, live.early_cut = True, None
            live.timing_turn += 1
            turn_number = live.timing_turn
        timer = threading.Timer(self.config.bridge_after_s, bridge)
        timer.daemon = True
        if cold and not allow_silence:
            timer.start()
        try:
            live.warm.wait(self.config.ready_timeout_s + self.config.turn_timeout_s)
            if not live.turn_lock.acquire(blocking=False):
                raise ApiError(409, "a turn is already in flight; interrupt it first")
            if live.conv.state != "open":
                live.turn_lock.release()
                raise ApiError(409, "the conversation has ended")
        except ApiError:
            timer.cancel()
            live.turn_pending = False
            raise
        started = time.monotonic()
        session = live.session

        usage = {}

        def observe(event: str, fields: dict, stamp: float | None = None, at: float | None = None) -> None:
            if event == "model_first_token":
                latency["first_token"] = round(((time.monotonic() if stamp is None else stamp) - started) * 1000)
            if event == "model_usage":
                usage.clear()
                usage.update(fields["usage"])
            log.info("%s", json.dumps({"event": event, "conversation_id": conv_id, "turn": turn_number,
                                     "at": time.time() if at is None else at,
                                     "elapsed_ms": round(((time.monotonic() if stamp is None else stamp) - arrived) * 1000),
                                     **fields}))

        session.timing_observer = observe
        session.call_control.timing_observer = observe
        observe("head_request", {}, arrived, arrived_at)
        latency: dict[str, int | None] = {"first_token": None, "first_sentence": None, "total": None}
        client_connected = True
        said: list[str] = []

        def say(sentence: str) -> None:
            nonlocal client_connected
            said.append(sentence)
            with emit_lock:
                spoken.set()
                if latency["first_sentence"] is None:
                    latency["first_sentence"] = _ms(started)
                    observe("head_first_sentence", {})
                if client_connected:
                    try:
                        emit("sentence", {"text": sentence, "conversation_id": conv_id, "turn": turn_number})
                    except OSError:
                        client_connected = False
                        live.session.call_control.interrupt()
                        live.session.interrupt()

        try:
            with live.lock:
                live.in_turn, live.cut_off, live.last_activity = True, None, time.monotonic()
                number = len(live.conv.exchanges) + 1
                previous_cut = live.conv.exchanges[-1].heard_before_cutoff if live.conv.exchanges else None
            stream, end, hangup, session = SpeechStream(), False, False, live.session
            if live.early_cut is not None:
                pass  # the speaker cut in while this turn was still waiting: nothing is asked of the model
            else:
                pending_speech: list[str] = []
                try:
                    session.wait_ready(self.config.ready_timeout_s)
                    closing_answer = session.call_control.begin_turn()
                    # Hold a closing answer until the model decides whether to end: only the tool's goodbye is spoken then.
                    speak = pending_speech.append if closing_answer else say
                    latency["spawn_wait"] = _ms(started)
                    fork = live.conv.tier == "personal"
                    stream = SpeechStream(redact=None if fork else session.account_email)
                    speaking = True
                    for delta in session.turn(prompts.turn_prompt(text, fork=fork, cut_off=previous_cut, web=self._web_tools(live.conv, True) if fork else (), lab=live.conv.lab_access), self.config.turn_timeout_s):
                        speaking = not isinstance(delta, UnspokenText)
                        for sentence in stream.feed(delta.text if isinstance(delta, UnspokenText) else delta):
                            if speaking:
                                speak(sentence)
                    for sentence in stream.finish():
                        if speaking:
                            speak(sentence)
                    live.answered = True
                except SessionError as error:
                    log.warning("conversation %s: %s", conv_id, error)
                    end = True
                relay = stream.relay
                with live.lock:
                    question, hangup = session.call_control.finish_turn(
                        not end and client_connected and live.cut_off is None and not live.ending.is_set())
                    if not hangup and live.cut_off is None:
                        for sentence in pending_speech:
                            say(sentence)
                    if question or hangup:
                        closing = call_tools.QUESTION if question else call_tools.GOODBYE
                        say(closing)
                        end = hangup and client_connected and live.cut_off is None
                    if latency["first_sentence"] is None and live.cut_off is None and not live.ending.is_set():
                        if end:
                            say(NO_ANSWER)
                        elif relay:
                            say(RELAYED)
                        elif not allow_silence:
                            say(ASK_TO_CONTINUE)
                    live.record(kind="exchange", n=number, heard=text, said=" ".join(said), asks=relay.asks, commitments=relay.commitments)
                    if live.cut_off is not None:
                        live.record(kind="interrupted", n=number, heard_text=live.cut_off)
                    live.in_turn = False
                self._note_session(live)
                if self._merges(live) and live.conv.tier == "personal" and (relay or self.config.soft_merge == "every"):
                    threading.Thread(target=self._soft_merge, args=(live, number), daemon=True).start()
            with live.lock:
                live.in_turn, live.last_activity = False, time.monotonic()
            latency["total"] = _ms(started)
            timer.cancel()
            with live.lock, emit_lock:
                spoken.set()
                if bridge_ms:
                    latency["bridge"] = bridge_ms[0]
                if client_connected:
                    try:
                        end = end and (not hangup or session.call_control.end_requested)
                        emit("done", {"end_conversation": end, "latency_ms": latency, "conversation_id": conv_id, "turn": turn_number})
                        observe("head_done_sent", {"end_conversation": end})
                    except OSError:
                        pass
        finally:
            timing = {"latency_ms": latency, "request_total_ms": _ms(arrived), "usage": usage}
            observe("head_turn_finished", timing)
            session.timing_observer = None
            session.call_control.timing_observer = None
            if live.in_turn:
                live.session.call_control.interrupt()
            timer.cancel()
            live.turn_pending = False
            live.in_turn = False
            live.turn_lock.release()

    def interrupt(self, conv_id: str, heard_text: str) -> None:
        live = self._open_live(conv_id)
        with live.lock:
            live.session.call_control.interrupt()
            if live.in_turn:
                live.cut_off = heard_text
                live.session.interrupt()
            elif live.turn_pending:
                live.early_cut = heard_text
            elif live.conv.exchanges:
                live.record(kind="interrupted", n=live.conv.exchanges[-1].n, heard_text=heard_text)
            live.last_activity = time.monotonic()

    def end(self, conv_id: str, reason: str) -> dict:
        live = self._live(conv_id)
        with live.end_lock:
            if live.conv.state == "open":
                live.ending.set()
                self._tts_release_pending = True
                self._release_tts()
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
        if self._proxy is not None:
            self._proxy.shutdown()
        for live in list(self._lives.values()):
            live.ending.set()
            if live.session is not None:
                live.session.close()
        self._tts_release_pending = True
        self._release_tts()

    def call_status(self) -> dict:
        with self._lock:
            return {"active_calls": sum(live.conv.state == "open" and not live.ending.is_set()
                                        for live in self._lives.values())}

    def _release_tts(self) -> None:
        if not self._tts_release_pending or not self.config.tts_unload_command:
            return
        # Opening a call and releasing its GPU must not race. Busy TTS is retried by upkeep.
        with self._lock:
            if any(live.conv.state == "open" and not live.ending.is_set() for live in self._lives.values()):
                return
            try:
                result = subprocess.run(self.config.tts_unload_command, timeout=5,
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if result.returncode == 0:
                    self._tts_release_pending = False
                    log.info("last call ended; TTS unloaded")
            except (OSError, subprocess.TimeoutExpired):
                log.warning("TTS unload unavailable; will retry")

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
        if conv.tier == "personal" and self.config.main_like_fork:
            return self.config.main_cwd
        return str(self.config.state_dir / ("fork" if conv.tier == "personal" else "cold"))

    def _fork_dir(self) -> Path:
        return transcript_path(self.config.main_cwd if self.config.main_like_fork else str(self.config.state_dir / "fork"), "x").parent

    def _main_transcript(self) -> Path | None:
        try:
            return transcript_path(self.config.main_cwd, self.config.hub.main_session())
        except HubError:
            return None

    def _main_session(self) -> str | None:
        try:
            return self.config.hub.main_session()
        except HubError:
            return None

    def _main_like_env(self) -> dict[str, str]:
        env = {**session_env(), **self.config.main_like_env}
        if self._proxy is not None:
            env["ANTHROPIC_BASE_URL"] = self._proxy.url
        return env

    def _resume_target(self, parent: str) -> str:
        """The session id a fork resumes: a trimmed copy of main's transcript when it has a compact boundary, else main's own."""
        fork_dir = self._fork_dir()
        manifest = self.config.state_dir / "snapshots"
        source = transcript_path(self.config.main_cwd, parent)
        if self.config.trim_transcript and source.exists():
            reusable = self._snapshot
            if reusable and reusable[1] == parent and time.monotonic() - reusable[2] < self.config.trim_reuse_s:
                return reusable[0]
            try:
                copy = snapshot.write_trimmed(source, fork_dir, self.config.trim_max_bytes)
            except OSError as error:
                log.warning("trimmed copy failed, resuming main's whole transcript: %s", error)
                copy = None
            if copy:
                snapshot.remember(manifest, copy)
                self._snapshot = (copy, parent, time.monotonic())
                snapshot.prune(fork_dir, manifest, 3600, keep=copy)
                return copy
        if not self.config.main_like_fork:
            self._expose_parent(parent)
        return parent

    def _expose_parent(self, parent: str) -> None:
        link = transcript_path(str(self.config.state_dir / "fork"), parent)
        link.parent.mkdir(parents=True, exist_ok=True)
        if not link.is_symlink():
            link.symlink_to(transcript_path(self.config.main_cwd, parent))

    def _web_tools(self, conv: Conversation, resume: str | None) -> tuple[str, ...]:
        return tuple(self.config.web_tools) if resume and conv.tier == "personal" else ()

    def _main_like_args(self, conv: Conversation, resume: str | None) -> list[str]:
        tools = self._web_tools(conv, resume)
        return web_guard.main_like_args(self.config.main_like_args, tools) if tools else self.config.main_like_args

    def _argv(self, conv: Conversation, resume: str | None) -> list[str]:
        if resume and conv.tier == "personal" and self.config.main_like_fork:
            return [*self.config.claude, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
                    "--include-partial-messages", "--permission-mode", "dontAsk", "--setting-sources", "", *self._main_like_args(conv, resume),
                    "--resume", resume, "--fork-session", "--model", self.config.model, "--effort", self.config.effort]
        if resume:
            identity = ["--resume", resume, "--fork-session", "--model", self.config.model]
        else:
            identity = ["--model", self.config.cold_model, "--system-prompt", prompts.COLD_PROFILE]
        lab_config = lab_tools.mcp_config(self.config.hub.url, self.config.hub.token_file) if conv.lab_access else None
        return [*self.config.claude, *locked_flags(self._web_tools(conv, resume), lab=conv.lab_access, lab_config=lab_config), *identity, "--effort", self.config.effort]

    def _warm_up(self, live: Live) -> None:
        """A fork's first model call reads all of main's context cold and takes seconds. Making it while the speaker is still talking hides that wait."""
        try:
            live.session.wait_ready(self.config.ready_timeout_s)
            with live.turn_lock:
                if live.conv.state != "open" or live.ending.is_set():
                    return
                for _ in live.session.turn(prompts.WARM_UP, self.config.turn_timeout_s):
                    pass
                live.answered = True
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
                stream.feed(delta.text if isinstance(delta, UnspokenText) else delta)
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
                self._tts_release_pending = True

    def _upkeep_loop(self) -> None:
        while True:
            for live in list(self._lives.values()):
                try:
                    self._finish_or_expire(live)
                except (ApiError, HubError) as error:
                    log.warning("conversation %s: %s", live.conv.id, error)
                except Exception:
                    log.exception("conversation %s: upkeep failed", live.conv.id)
            self._release_tts()
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
