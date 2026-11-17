import re
from dataclasses import dataclass, field

RELAY_OPEN, RELAY_CLOSE = "<relay>", "</relay>"
END_PHRASES = {
    "that's all", "thats all", "that is all", "that's it", "thats it", "that's everything",
    "goodbye", "good bye", "bye", "bye bye", "never mind", "nevermind", "stop listening",
    "we're done", "i'm done", "that'll be all", "that will be all",
}
SIGN_OFF = "Okay, talk later."
_SENTENCE_END = re.compile(r"""([.!?]["')\]]?)\s+|\n+""")
_ABBREVIATION = re.compile(r"\b(?:Mr|Mrs|Ms|Dr|St|vs|etc|e\.g|i\.e|a\.m|p\.m)\.$", re.I)
_MARKUP = re.compile(r"[*_`#]+|^\s*[-•]\s+", re.M)


def is_end_phrase(text: str) -> bool:
    words = re.sub(r"[^a-z' ]", "", text.lower().replace("’", "'")).split()
    for filler in ("okay", "ok", "thanks", "thank", "you", "janet", "alright", "no", "for", "now"):
        words = [w for w in words if w != filler]
    return " ".join(words) in END_PHRASES


@dataclass
class Relay:
    asks: list[str] = field(default_factory=list)
    commitments: list[str] = field(default_factory=list)

    def __bool__(self) -> bool:
        return bool(self.asks or self.commitments)


def parse_relay(block: str) -> Relay:
    relay = Relay()
    for line in block.splitlines():
        label, _, value = line.strip().partition(":")
        value = value.strip()
        if not value:
            continue
        if label.lower() == "commitment":
            relay.commitments.append(value)
        else:
            relay.asks.append(value if label.lower() == "ask" else line.strip())
    return relay


def _speakable(text: str) -> str:
    return " ".join(_MARKUP.sub("", text).split())


def _unfinished_relay_tag(text: str) -> str:
    """The tail of `text` that the next delta could complete into the relay tag, such as "<rel"."""
    return next((text[i:] for i in range(len(text)) if RELAY_OPEN.startswith(text[i:])), "")


class SpeechStream:
    def __init__(self, redact: str | None = None):
        self.text = ""
        self._pending = ""
        self._relay: str | None = None
        self._redact = re.compile(re.escape(redact), re.I) if redact else None

    def feed(self, delta: str) -> list[str]:
        self.text += delta
        if self._relay is not None:
            self._relay += delta
            return []
        self._pending += delta
        if RELAY_OPEN in self._pending:
            self._pending, _, self._relay = self._pending.partition(RELAY_OPEN)
            return self._sentences(final=True)
        return self._sentences(final=False)

    def finish(self) -> list[str]:
        return [] if self._relay is not None else self._sentences(final=True)

    @property
    def relay(self) -> Relay:
        return parse_relay((self._relay or "").partition(RELAY_CLOSE)[0])

    @property
    def spoken(self) -> str:
        return _speakable(self.text.partition(RELAY_OPEN)[0])

    def _sentences(self, final: bool) -> list[str]:
        out, start = [], 0
        for match in _SENTENCE_END.finditer(self._pending):
            if _ABBREVIATION.search(self._pending[start:match.end()].rstrip()):
                continue
            out.append(self._pending[start:match.end()])
            start = match.end()
        rest = self._pending[start:]
        held = _unfinished_relay_tag(rest)
        if final:
            out.append(rest.removesuffix(held) if self._relay is None else rest)
            rest = ""
        self._pending = rest
        sentences = [_speakable(s) for s in out]
        if self._redact:
            sentences = [self._redact.sub("a private address", s) for s in sentences]
        return [s for s in sentences if re.search(r"\w", s)]
