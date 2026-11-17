import json
import urllib.error
import urllib.request
from pathlib import Path

from .conversation import TranscriptMark
from .session import transcript_path


class HubError(Exception):
    pass


class HubRefused(HubError):
    """The hub read the message and said no, and saying it again will not change that."""


_RETRYABLE_REFUSALS = {401, 403, 408, 425, 429}


def marker(key: str) -> str:
    return f"key={key}]"


class Hub:
    def __init__(self, url: str, token_file: Path, state_file: Path, main_cwd: str):
        self.url, self.token_file, self.state_file, self.main_cwd = url.rstrip("/"), token_file, state_file, main_cwd

    def _call(self, path: str, body: dict | None = None) -> dict:
        request = urllib.request.Request(
            self.url + path, method="POST" if body is not None else "GET",
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": "Bearer " + self.token_file.read_text(encoding="utf-8").strip(),
                     "content-type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            refused = 400 <= error.code < 500 and error.code not in _RETRYABLE_REFUSALS
            raise (HubRefused if refused else HubError)(f"hub {path}: HTTP {error.code} {_error_text(error)}") from error
        except (urllib.error.URLError, OSError, ValueError) as error:
            raise HubError(f"hub {path}: {getattr(error, 'reason', error)}") from error

    def drops_repeats(self) -> bool:
        return self._call("/health").get("inject_keys") is True

    def _state(self) -> dict:
        try:
            return json.loads(self.state_file.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise HubError(f"hub state: {error}") from error

    def main_session(self) -> str:
        session = self._state().get("sid")
        if not isinstance(session, str) or not session:
            raise HubError("the hub has no session")
        return session

    def transcript_mark(self) -> TranscriptMark:
        path = transcript_path(self.main_cwd, self.main_session())
        try:
            return TranscriptMark(str(path), path.stat().st_size)
        except OSError:
            return TranscriptMark(str(path), 0)

    def has(self, key: str, attempted_at: TranscriptMark) -> str | None:
        # cc-link removes a message from its queue only after the prompt is in the transcript,
        # so reading the queue first cannot miss a message that moves between the two reads.
        needle = marker(key)
        if self._queued(needle):
            return "hub queue"
        if self._delivered(needle, attempted_at):
            return "main transcript"
        return None

    def _queued(self, needle: str) -> bool:
        state = self._state()
        messages = list(state.get("inbox", [])) + list(state.get("inflight", {}).values())
        return any(needle in str(message.get("text", "")) for message in messages)

    def _delivered(self, needle: str, attempted_at: TranscriptMark) -> bool:
        if _in_transcript_after(Path(attempted_at.transcript), attempted_at.size, needle):
            return True
        now = self.transcript_mark().transcript
        return now != attempted_at.transcript and _in_transcript_after(Path(now), 0, needle)

    def inject(self, source: str, text: str, key: str) -> str:
        body = self._call("/inject", {"source": source, "text": text, "key": key})
        if not body.get("ok"):
            raise HubRefused("hub refused the message: " + str(body.get("error", "")))
        return str(body.get("id"))


def _error_text(error: urllib.error.HTTPError) -> str:
    try:
        return error.read(500).decode("utf-8", "replace")
    except OSError:
        return ""


def _in_transcript_after(path: Path, offset: int, needle: str) -> bool:
    try:
        with open(path, "rb") as lines:
            lines.seek(offset)
            return any(needle.encode() in line and _is_hub_delivery(line) for line in lines)
    except OSError:
        return False


def _is_hub_delivery(line: bytes) -> bool:
    try:
        row = json.loads(line)
    except ValueError:
        return False
    origin = row.get("origin") or {}
    content = (row.get("message") or {}).get("content")
    if not isinstance(content, str):
        content = "".join(part.get("text", "") for part in content or [] if isinstance(part, dict))
    return row.get("type") == "user" and origin.get("name") == "hermes-link" and 'sender="cron voice-' in content


