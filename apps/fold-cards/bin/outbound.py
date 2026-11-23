"""Release retrieval text only after the shared vault scanner accepts every byte."""
import json
import os
from pathlib import Path
import subprocess
import sys

MAX_BYTES = 16 * 1024 * 1024
TIMEOUT = 20


class Refused(Exception):
    """The candidate stays local; diagnostics never include candidate or scanner output."""


def check(text):
    try:
        argv = os.environ.get('FOLD_SECRET_SCANNER_ARGV')
        if argv is None:
            argv = Path(__file__).with_name('scanner-argv.json').read_text(encoding='utf-8')
        command = json.loads(argv)
        if not isinstance(command, list) or not command or not all(isinstance(v, str) and v for v in command):
            raise Refused()
        data = text.encode('utf-8')
        if len(data) > MAX_BYTES:
            raise Refused()
        # The scanner contract permits no stdout, even on success. Keep output off the
        # model channel, including diagnostics from a broken provider or executable.
        result = subprocess.run(command, input=data, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=TIMEOUT, check=False)
        if result.returncode != 0 or result.stdout or result.stderr:
            raise Refused()
    except (OSError, ValueError, subprocess.SubprocessError):
        raise Refused() from None


def emit(text, raw=()):
    # Check before truncation/escaping too: either can hide a known exact secret.
    check('\n'.join([*raw, text]))
    sys.stdout.write(text)
    if not text.endswith('\n'):
        sys.stdout.write('\n')


def strings(value):
    """Strings before JSON escaping, including object keys that may contain private data."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for key, item in value.items():
            yield key
            yield from strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)


def emit_json(value, raw=()):
    emit(json.dumps(value, ensure_ascii=False), [*raw, *strings(value)])


def refusal():
    print('retrieval refused: shared secret scanner did not approve output', file=sys.stderr)
    return 2
