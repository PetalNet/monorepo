"""Parse a Firefox Copy-as-cURL capture in memory; never execute it."""

from dataclasses import dataclass, field
import json
import re
import shlex
import sys
from urllib.parse import urlsplit


MAX_CAPTURE = 8192
COOKIE_FIELDS = {
    "COMPASS": "compass",
    "SSID": "ssid",
    "SID": "sid",
    "OSID": "osid",
    "HSID": "hsid",
    "__Secure-1PSIDTS": "secure_1psidts",
    "SIDCC": "sidcc",
    "__Secure-1PSIDCC": "secure_1psidcc",
    "__Secure-3PSIDCC": "secure_3psidcc",
    "__Secure-3PSIDTS": "secure_3psidts",
    "APISID": "apisid",
    "SAPISID": "sapisid",
    "__Secure-1PSID": "secure_1psid",
    "__Secure-3PSID": "secure_3psid",
    "__Secure-1PAPISID": "secure_1papisid",
    "__Secure-3PAPISID": "secure_3papisid",
}
REQUIRED = frozenset(list(COOKIE_FIELDS)[:6])
VALUE_OPTIONS = {
    "-H", "--header", "-b", "--cookie", "-X", "--request", "--url",
    "--data", "--data-raw", "--data-binary", "--data-urlencode",
    "-A", "--user-agent", "-e", "--referer",
}
FLAGS = {"--compressed", "--globoff", "--http2", "--http1.1", "--path-as-is"}


class CaptureError(ValueError):
    pass


@dataclass(frozen=True)
class ImportedCookies:
    _fields: dict[str, str] = field(repr=False)

    def bridge_fields(self) -> dict[str, str]:
        """Return fields for the staged patch, for a future in-memory login adapter."""
        return dict(self._fields)

    def summary(self) -> dict:
        return {"valid_capture": True, "cookie_count": len(self._fields),
                "has_rotating_cookie": True, "network_attempted": False,
                "account_verified": False, "session_validity": "not_checked"}


def parse_capture(capture: str) -> ImportedCookies:
    if not capture or len(capture.encode("utf-8")) > MAX_CAPTURE:
        raise CaptureError("Capture is empty or exceeds the vault-drop limit.")
    if any(ord(c) < 32 and c not in "\t\r\n" for c in capture):
        raise CaptureError("Control characters are not accepted.")
    if "$" in capture or "`" in capture:
        raise CaptureError("Shell expansions and ANSI-C quoting are not accepted.")
    capture = capture.replace("\\\r\n", "").replace("\\\n", "")
    try:
        lexer = shlex.shlex(capture, posix=True, punctuation_chars=";&|<>()")
        lexer.whitespace_split = True
        lexer.commenters = ""
        tokens = list(lexer)
    except ValueError:
        raise CaptureError("Capture has incomplete quoting.") from None
    if not tokens or tokens.pop(0) != "curl":
        raise CaptureError("Expected one Firefox cURL command.")
    urls, cookie_headers = [], []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token in FLAGS:
            index += 1
            continue
        if token in VALUE_OPTIONS:
            if index + 1 >= len(tokens):
                raise CaptureError("A cURL option is missing its value.")
            value = tokens[index + 1]
            if value.startswith("@"):
                raise CaptureError("File-based cURL arguments are not accepted.")
            if token in {"-H", "--header"}:
                name, sep, content = value.partition(":")
                if not sep or "\n" in value or "\r" in value:
                    raise CaptureError("Malformed HTTP header.")
                if name.lower() == "cookie":
                    cookie_headers.append(content.strip())
            elif token in {"-b", "--cookie"}:
                cookie_headers.append(value)
            elif token == "--url":
                urls.append(value)
            elif token in {"-X", "--request"} and value not in {"GET", "POST"}:
                raise CaptureError("Expected a GET or POST capture.")
            index += 2
        elif token.startswith("https://"):
            urls.append(token)
            index += 1
        else:
            raise CaptureError("Unsupported option or shell syntax in capture.")
    if len(urls) != 1:
        raise CaptureError("Expected exactly one Google Chat URL.")
    try:
        url = urlsplit(urls[0])
        valid_url = (url.scheme == "https" and url.hostname == "chat.google.com"
                     and url.port in {None, 443} and not url.username
                     and not url.password and not url.fragment)
    except ValueError:
        valid_url = False
    if not valid_url:
        raise CaptureError("Expected an HTTPS request to chat.google.com.")
    if len(cookie_headers) != 1:
        raise CaptureError("Expected exactly one Cookie header or --cookie value.")
    cookies = {}
    for pair in cookie_headers[0].split(";"):
        name, sep, value = pair.strip().partition("=")
        if not sep or not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", name):
            raise CaptureError("Malformed cookie pair.")
        if name in cookies:
            raise CaptureError("Duplicate cookie name. Capture the root Chat document.")
        if not value or any(ord(c) < 33 or ord(c) > 126 or c in ',;"\\' for c in value):
            raise CaptureError("Empty or malformed cookie value.")
        cookies[name] = value
    if not REQUIRED.issubset(cookies):
        raise CaptureError("Missing required cookies. Need the five legacy cookies and __Secure-1PSIDTS.")
    return ImportedCookies({field_name: cookies[name] for name, field_name in COOKIE_FIELDS.items()
                            if name in cookies})


def main() -> int:
    if len(sys.argv) != 1 or sys.stdin.isatty():
        print("Usage: pipe capture bytes to import_curl.py; arguments and terminal input are disabled.", file=sys.stderr)
        return 2
    try:
        raw = sys.stdin.buffer.read(MAX_CAPTURE + 1)
        if len(raw) > MAX_CAPTURE:
            raise CaptureError("Capture exceeds the vault-drop limit.")
        result = parse_capture(raw.decode("utf-8"))
    except (CaptureError, UnicodeDecodeError) as error:
        message = str(error) if isinstance(error, CaptureError) else "Capture must be UTF-8."
        print("Rejected: " + message, file=sys.stderr)
        return 2
    print(json.dumps(result.summary(), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
