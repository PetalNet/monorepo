"""A trimmed copy of main's transcript for a fork to resume.

Main's transcript file is gigabytes, but the model only ever sees what follows its last
compaction. Resuming the whole file spent about 3 s parsing history that is never sent.
The copy keeps every record from the last compact boundary on, with its uuid chain intact,
so the fork resumes into the same conversation in under a second.
"""

import json
import os
import time
import uuid
from pathlib import Path

BOUNDARY = b'"subtype":"compact_boundary"'
WINDOW = 8 * 1024 * 1024
OVERLAP = 1024 * 1024  # longer than any boundary record


def _is_boundary(line: bytes) -> bool:
    try:
        record = json.loads(line)
    except ValueError:
        return False
    return record.get("type") == "system" and record.get("subtype") == "compact_boundary" and record.get("parentUuid") is None


def last_boundary_offset(source: Path, max_bytes: int) -> int | None:
    """Byte offset of the start of the last compact boundary record within the last max_bytes, or None."""
    size = source.stat().st_size
    floor = max(0, size - max_bytes)
    end = size
    with source.open("rb") as file:
        while True:
            start = max(floor, end - WINDOW)
            file.seek(start)
            data = file.read(end - start)
            at = len(data)
            while (at := data.rfind(BOUNDARY, 0, at)) != -1:
                newline = data.rfind(b"\n", 0, at)
                if newline == -1 and start > floor:
                    continue  # the record began before this window; the next one sees it whole
                line_end = data.find(b"\n", at)
                if _is_boundary(data[newline + 1:line_end if line_end != -1 else len(data)]):
                    return start + newline + 1
            if start == floor:
                return None
            end = start + OVERLAP


def preserved_lines(source: Path, boundary_offset: int, max_bytes: int) -> list[bytes] | None:
    """The records a compaction kept from before it, oldest first. A compaction can keep its last messages
    (compactMetadata.preservedSegment: head, anchor, tail uuids); they sit before the boundary in the file and
    are relinked after the summary when the session loads, so a copy that starts at the boundary must carry them.
    Returns [] when nothing was kept, and None when the kept records cannot be found within max_bytes."""
    with source.open("rb") as file:
        file.seek(boundary_offset)
        boundary = json.loads(file.readline())
    segment = (boundary.get("compactMetadata") or {}).get("preservedSegment")
    if not segment:
        return []
    head, want = segment["headUuid"], segment["tailUuid"]
    found: list[bytes] = []
    end, floor = boundary_offset, max(0, boundary_offset - max_bytes)
    carry = b""
    with source.open("rb") as file:
        while end > floor:
            start = max(floor, end - WINDOW)
            file.seek(start)
            lines = (file.read(end - start) + carry).split(b"\n")
            # The first piece may be a record cut by the window edge: keep it for the next, earlier window.
            carry = lines[0] if start > floor else b""
            for line in reversed(lines[1:] if start > floor else lines):
                if want is None or f'"uuid":"{want}"'.encode() not in line:
                    continue
                record = json.loads(line)
                if record.get("uuid") != want:
                    continue
                found.append(line)
                if want == head:
                    return found[::-1]
                want = record.get("parentUuid")
            end = start
    return None


def write_trimmed(source: Path, dest_dir: Path, max_bytes: int) -> str | None:
    """Writes the part of source that main still sends to the model as a new session file in dest_dir.
    Returns the new session id, or None when the source has no compact boundary within max_bytes."""
    offset = last_boundary_offset(source, max_bytes)
    if offset is None:
        return None
    kept = preserved_lines(source, offset, max_bytes)
    if kept is None:
        return None
    session_id = str(uuid.uuid4())
    dest_dir.mkdir(parents=True, exist_ok=True)
    partial = dest_dir / f".{session_id}.part"
    with source.open("rb") as src, partial.open("wb") as out:
        for line in kept:
            out.write(line + b"\n")
        src.seek(offset)
        while chunk := src.read(1 << 20):
            out.write(chunk)
    os.replace(partial, dest_dir / f"{session_id}.jsonl")
    return session_id


def prune(dest_dir: Path, manifest: Path, older_than_s: float, keep: str | None = None) -> None:
    """Deletes the copies this module made that are older than older_than_s. The manifest names them,
    so a fork's own transcript, which lives in the same directory, is never touched."""
    kept, now = [], time.time()
    for line in manifest.read_text().splitlines() if manifest.exists() else []:
        made, _, session_id = line.partition(" ")
        try:
            old = now - float(made) > older_than_s
        except ValueError:
            continue  # a line torn by a crash
        if old and session_id != keep:
            (dest_dir / f"{session_id}.jsonl").unlink(missing_ok=True)
        else:
            kept.append(line)
    manifest.write_text("".join(line + "\n" for line in kept))


def remember(manifest: Path, session_id: str) -> None:
    with manifest.open("a") as file:
        file.write(f"{time.time()} {session_id}\n")
