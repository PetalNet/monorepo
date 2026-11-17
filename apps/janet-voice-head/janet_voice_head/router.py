"""Per-turn routing for the personal desk path, after PetalNet/janet-mini.

janet-mini put a small always-warm "fast" thread in front of a ready fork (wayfinder/tickets/which-models.md,
templates/fast-CLAUDE.md): the fast thread answers what it can, passes the rest up and says a short acknowledgment
first (wayfinder/tickets/when-fast-janet-passes-a-question-up.md). Here a rule layer goes in front of it:

  local  clock and Home Assistant's own intents, no model
  fast   one warm Haiku session shared by every personal conversation, streaming
  fork   the conversation's fork of main, when the turn needs memory, a tool or an action
"""

import json
import re
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from .session import LOCKED_FLAGS, ClaudeSession

ESCALATE = "<escalate/>"
FILLER = "One moment."

FAST_PROFILE = f"""You are Janet's fast thread, speaking aloud with Parker at his desk. Your words go straight to a speech synthesizer.
Answer simple questions and quick chat yourself, in plain sentences, one to three unless he asks for more. No markdown, lists, emoji, or anything that is not meant to be said aloud.
You hold no private memory and have no tools. You never claim to have done something, and you never guess about Parker, his work, his projects, his plans, or anything said earlier: all of that is the escalation case, never an answer.
If the request needs Janet's memory (what he told her, his schedule, his projects, his work), a real action, a lookup, or sending anything, begin the reply with {ESCALATE} and follow it with one short natural sentence saying you are checking. Write nothing after that sentence: no answer and no guess. You never guess about Parker, his work, his projects, his plans, or anything said earlier. Decide fresh each turn from the request alone.
Parker would rather hear something than wait in silence."""

_FORK_WORDS = re.compile(
    r"\b(remember|remind|what did i (tell|say)|did i (tell|say)|my (calendar|schedule|email|emails|messages|class|classes|project|projects|grades?)"
    r"|projects?|status|due|deadline|assignment|homework|exam|class|working on|yesterday|last (week|night)|earlier|today's plan|send|text|email|message|schedule|book|order|buy|call|add (it|that|this) to|save|note that|look up|search|check my|on my)\b", re.I)
_LOCAL_WORDS = re.compile(
    r"\b(turn (on|off)|switch (on|off)|lights?|lamp|timer|alarm|thermostat|temperature|volume|is the .+ (on|off|open|closed)"
    r"|set (a|the)|how (hot|cold|warm)|weather)\b", re.I)
_CLOCK = re.compile(r"^\W*(?:hey janet\W+)?(?:what(?:'s| is)? (?:the )?time(?: is it)?(?: now| right now)?|what time is it(?: now| right now)?|what(?:'s| is) the date(?: today)?|what day is it(?: today)?)\W*$", re.I)


def clock_answer(text: str, now: float | None = None) -> str | None:
    match = _CLOCK.match(text.strip())
    if not match:
        return None
    moment = time.localtime(now)
    if "date" in text.lower() or "day" in text.lower():
        return time.strftime("It's %A, %B %-d.", moment)
    return time.strftime("It's %-I:%M %p.", moment)


def classify(text: str) -> str:
    """Rules only: which lane starts on this turn."""
    if clock_answer(text) is not None:
        return "clock"
    if _FORK_WORDS.search(text):
        return "fork"
    if _LOCAL_WORDS.search(text):
        return "home"
    return "fast"


class HomeAssistant:
    def __init__(self, url: str, token_file: str, timeout: float = 4.0):
        self._url, self._token_file, self._timeout = url.rstrip("/"), token_file, timeout

    def answer(self, text: str) -> str | None:
        """Home Assistant's own sentence for `text`, or None when it has no intent for it."""
        body = json.dumps({"text": text, "language": "en"}).encode()
        request = urllib.request.Request(
            f"{self._url}/api/conversation/process", body,
            {"content-type": "application/json", "Authorization": "Bearer " + Path(self._token_file).read_text().strip()})
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                reply = json.load(response)["response"]
        except (OSError, ValueError, KeyError):
            return None
        if reply.get("response_type") not in ("action_done", "query_answer"):
            return None
        return ((reply.get("speech") or {}).get("plain") or {}).get("speech") or None


class FastLane:
    """One warm Haiku session. It is started ahead of the first turn and replaced when it dies."""

    def __init__(self, argv: list[str], cwd: str, factory=ClaudeSession):
        self._argv, self._cwd, self._factory = argv, cwd, factory
        self._lock = threading.Lock()
        self.turn_lock = threading.Lock()
        self._session = None
        self._turns = 0
        self.warm()

    @staticmethod
    def argv(claude: list[str], model: str) -> list[str]:
        return [*claude, *LOCKED_FLAGS, "--model", model, "--effort", "low", "--system-prompt", FAST_PROFILE]

    def warm(self) -> None:
        with self._lock:
            if self._session is None or self._session.failure:
                self._session = self._factory(self._argv, self._cwd, False)

    @property
    def session(self):
        self.warm()
        return self._session

    def retire_if_old(self, limit: int = 40) -> None:
        """The warm session keeps every personal turn in its context; start a replacement before it grows too long."""
        self._turns += 1
        if self._turns >= limit:
            old, self._session, self._turns = self._session, None, 0
            self.warm()
            threading.Thread(target=old.close, daemon=True).start()

    def close(self) -> None:
        if self._session is not None:
            self._session.close()


class EscalationFilter:
    """Takes the escalation marker out of the delta stream, even when the model splits it across deltas.

    The marker comes first and one acknowledgment sentence may follow; whatever the model says after that is dropped.
    """

    def __init__(self):
        self.escalated = False
        self._held = ""
        self._done = False

    def feed(self, delta: str) -> str:
        if self._done:
            return ""
        text = self._held + delta
        self._held = ""
        if not self.escalated:
            if ESCALATE in text:
                self.escalated = True
                text = text.split(ESCALATE, 1)[0] + text.split(ESCALATE, 1)[1]
            else:
                for size in range(min(len(ESCALATE) - 1, len(text)), 0, -1):
                    if ESCALATE.startswith(text[-size:]):
                        self._held = text[-size:]
                        return text[:-size]
                return text
        end = re.search(r"[.!?](\s|$)", text)
        if end and self.escalated:
            self._done = True
            return text[: end.end()]
        return text

    def finish(self) -> str:
        held, self._held = self._held, ""
        return held
