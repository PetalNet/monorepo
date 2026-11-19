import re
from dataclasses import dataclass, field

RELAY_TAGS = ("<relay>", "[relay]")
_RELAY_OPEN = re.compile(r"<relay>|\[relay\]", re.I)
_RELAY_CLOSE = re.compile(r"</relay>|\[/relay\]", re.I)
_RELAY_BLOCK = re.compile(r"(?:<relay>|\[relay\]).*?(?:</relay>|\[/relay\]|\Z)", re.I | re.S)
END_PHRASES = {
    "that's all", "thats all", "that is all", "that's it", "thats it", "that's everything",
    "goodbye", "good bye", "bye", "bye bye", "never mind", "nevermind", "stop listening",
    "we're done", "i'm done", "that'll be all", "that will be all",
    "hang up", "hang up the call", "end the call", "end call", "end the call now", "hang up the phone",
}  # a clear goodbye is the whole utterance: "don't hang up" or "can you end the call on the other line" is not one
SIGN_OFF = "Okay, talk later."
_SENTENCE_END = re.compile(r"""([.!?]["')\]]?)\s+|\n+""")
_ABBREVIATION = re.compile(r"\b(?:Mr|Mrs|Ms|Dr|St|vs|etc|e\.g|i\.e|a\.m|p\.m)\.$", re.I)
_MARKUP = re.compile(r"[*_`#]+|^\s*[-•]\s+", re.M)


_LISTENING = ("go ahead", "go on", "keep going", "carry on", "i'm listening", "im listening", "i am listening", "i'm here", "im here",
              "i'm still here", "i'm all ears", "i'm still listening", "i'm ready", "take your time", "no rush", "ready when you are",
              "i'm with you", "i hear you", "[silent]", "<silent>")
_FILLER = ("parker",)


def is_backchannel(sentence: str) -> bool:
    """A sentence that only tells the speaker the line is open ("Go ahead, I'm listening."), which is noise when they paused mid-thought."""
    text = re.sub(r"[.!?…\u2019]+$", "", sentence.lower().replace("\u2019", "'").strip())
    parts = [p.strip() for p in re.split(r"[,;:]| and | - |\s{2,}", text) if p.strip()]
    return bool(parts) and all(p in _LISTENING or p in _FILLER for p in parts) and any(p in _LISTENING for p in parts)


def is_end_phrase(text: str) -> bool:
    words = re.sub(r"[^a-z' ]", "", text.lower().replace("’", "'")).split()
    for filler in ("okay", "ok", "thanks", "thank", "you", "janet", "alright", "no", "for", "now", "please"):
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
    """The tail of `text` that the next delta could complete into a relay tag, such as "<rel"."""
    lowered = text.lower()
    return next((text[i:] for i in range(len(text)) if any(tag.startswith(lowered[i:]) for tag in RELAY_TAGS)), "")


class SpeechStream:
    def __init__(self, redact: str | None = None):
        self.text = ""
        self._pending = ""
        self._block: str | None = None
        self._relay = Relay()
        self._redact = re.compile(re.escape(redact), re.I) if redact else None
        self._dropped: list[str] = []

    def feed(self, delta: str) -> list[str]:
        self.text += delta
        if self._block is None:
            self._pending += delta
        else:
            self._block += delta
        out: list[str] = []
        while True:
            if self._block is not None:
                if (close := _RELAY_CLOSE.search(self._block)) is None:
                    return out
                self._absorb(self._block[: close.start()])
                self._pending, self._block = self._block[close.end():], None
            if (opened := _RELAY_OPEN.search(self._pending)) is None:
                return out + self._sentences(final=False)
            self._pending, self._block = self._pending[: opened.start()], self._pending[opened.end():]
            out += self._sentences(final=True)

    def finish(self) -> list[str]:
        if self._block is None:
            return self._sentences(final=True, drop_partial_tag=True)
        self._absorb(self._block)
        self._block = None
        return []

    @property
    def relay(self) -> Relay:
        open_block = parse_relay(self._block or "")
        return Relay(self._relay.asks + open_block.asks, self._relay.commitments + open_block.commitments)

    @property
    def spoken(self) -> str:
        text = _speakable(_RELAY_BLOCK.sub("", self.text))
        for dropped in self._dropped:
            text = text.replace(dropped, "", 1)
        return " ".join(text.split())

    def _absorb(self, block: str) -> None:
        parsed = parse_relay(block)
        self._relay.asks += parsed.asks
        self._relay.commitments += parsed.commitments

    def _sentences(self, final: bool, drop_partial_tag: bool = False) -> list[str]:
        out, start = [], 0
        for match in _SENTENCE_END.finditer(self._pending):
            if _ABBREVIATION.search(self._pending[start:match.end()].rstrip()):
                continue
            out.append(self._pending[start:match.end()])
            start = match.end()
        rest = self._pending[start:]
        if final:
            out.append(rest.removesuffix(_unfinished_relay_tag(rest)) if drop_partial_tag else rest)
            rest = ""
        self._pending = rest
        sentences = [_speakable(s) for s in out]
        if self._redact:
            sentences = [self._redact.sub("a private address", s) for s in sentences]
        self._dropped += [s for s in sentences if re.search(r"\w", s) and is_backchannel(s)]
        return [s for s in sentences if re.search(r"\w", s) and not is_backchannel(s)]
