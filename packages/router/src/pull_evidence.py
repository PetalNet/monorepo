"""Official evidence downloads; Python's stdlib supplies CSV and ZIP readers.

No website scraping, fuzzy model matching, remote code execution or data publication.
"""
import csv
import fcntl
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone

STATE = Path.home() / ".local/state/router"
EQ_ROOT = "https://raw.githubusercontent.com/EQ-bench/EQ-bench-site/main/"
ARENA = "https://datasets-server.huggingface.co/filter"
SHORT = {"opus": "claude-opus-5-5", "sonnet": "claude-sonnet-5-5",
         "haiku": "claude-haiku-5-5", "fable": "claude-fable-5-2"}
# Only spelling aliases, never a different generation, preview or harness.
SPELLINGS = {"claude-opus-5.5": "claude-opus-5-5", "claude-sonnet-5.5": "claude-sonnet-5-5",
             "claude-haiku-5.5": "claude-haiku-5-5", "claude-fable-5.2": "claude-fable-5-2"}
EFFORT = r"low|medium|high|xhigh|max"


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Cache:
    def __init__(self, directory):
        self.directory = directory
        self.last_request = 0.0

    def get(self, url, token=None):
        key = hashlib.sha256(url.encode()).hexdigest()
        body = self.directory / (key + ".raw")
        meta = self.directory / (key + ".json")
        if body.exists() and meta.exists():
            info = json.loads(meta.read_text())
            if 0 <= time.time() - info["fetchedEpoch"] < 86400:
                return body.read_bytes(), info["fetchedAt"]
        time.sleep(max(0, 1 - (time.monotonic() - self.last_request)))
        headers = {"User-Agent": "JanetRouter/0.1 (internal benchmark research)", "Accept": "*/*"}
        request = urllib.request.Request(url, headers=headers)
        if token:
            request.add_unredirected_header("Authorization", "Bearer " + token)
        self.last_request = time.monotonic()
        # One request, no retries on 403/429 and no response/error body in diagnostics.
        with urllib.request.urlopen(request, timeout=30) as response:
            data = response.read(32 * 1024 * 1024 + 1)
            if len(data) > 32 * 1024 * 1024:
                raise ValueError("source exceeds 32 MiB")
        asof = timestamp()
        atomic(body, data)
        atomic(meta, json.dumps({"url": url, "fetchedAt": asof, "fetchedEpoch": time.time()}).encode())
        return data, asof


def model_key(name, catalog):
    """Whitespace/case punctuation are spelling, suffixes are not release aliases."""
    if not isinstance(name, str):
        raise ValueError("model name must be a string")
    name = name.strip().lower()
    effort = "unspecified"
    match = re.search(r"(?:\s*\((" + EFFORT + r")\)|[_-](" + EFFORT + r"))$", name)
    if match:
        effort = match[1] or match[2]
        name = name[:match.start()].strip()
    for prefix in ("openai/", "anthropic/", "google/"):
        if name.startswith(prefix):
            name = name[len(prefix):]
            break
    name = SPELLINGS.get(name.replace(" ", "-"), name.replace(" ", "-"))
    return (name, effort) if name in catalog else None


def catalog_ids(raw):
    return {SHORT.get(re.sub(r"-(?:" + EFFORT + r")$", "", row["id"]),
                      re.sub(r"-(?:" + EFFORT + r")$", "", row["id"])) for row in raw["models"]}


class Rows:
    def __init__(self, catalog):
        self.catalog = catalog
        self.rows = []
        self.unmapped = set()
        self.notes = []

    def add(self, name, value, signal, src, asof, url, kind="measured", reporter=None):
        key = model_key(name, self.catalog)
        if key is None:
            self.unmapped.add(src + ": " + name)
            return
        if value is None or value == "":
            return
        if isinstance(value, bool) or not math.isfinite(float(value)):
            raise ValueError("non-finite score")
        datetime.fromisoformat(asof.replace("Z", "+00:00"))
        self.rows.append(dict(model=key[0], effort=key[1], signal=signal, value=float(value),
                              src=src, kind=kind, asof=asof, url=url, reporter=reporter or src,
                              halfLifeDays=365 if kind == "vendor" else 90 if src in ("Arena", "DesignArena", "EQ-Bench") else 180))


def arena(cache, result, config, category, signal):
    offset = 0
    while True:
        query = urllib.parse.urlencode(dict(dataset="lmarena-ai/leaderboard-dataset", config=config,
                    split="latest", where=f'"category"=\'{category}\'', offset=offset, length=100))
        url = ARENA + "?" + query
        data, _ = cache.get(url)
        page = json.loads(data)
        records = page["rows"]
        if not records and offset < page["num_rows_total"]:
            raise ValueError("Arena pagination ended early")
        for item in records:
            row = item["row"]
            if row["category"] != category or item.get("truncated_cells"):
                raise ValueError("Arena returned wrong category or truncated cells")
            result.add(row["model_name"], row["rating"], signal, "Arena",
                       row["leaderboard_publish_date"], url)
        offset += len(records)
        if offset >= page["num_rows_total"]:
            break
        if offset > 20000:
            raise ValueError("Arena pagination exceeds expected size")
    result.notes.append(f"Arena {config}/{category}: CC BY 4.0; publication date; https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset")


def eq_creative(cache, result):
    url = EQ_ROOT + "creative_writing.js"
    data, asof = cache.get(url)
    match = re.search(r"let leaderboardDataCreativeWritingV3\s*=\s*`([^`]+)`", data.decode())
    if not match or "${" in match[1]:
        raise ValueError("EQ creative CSV literal missing")
    for row in csv.DictReader(io.StringIO(match[1].strip())):
        result.add(row["model_name"], row["elo_score"], "eqbench_creative_v3", "EQ-Bench", asof, url)
    result.notes.append("EQ-Bench Creative Writing v3: internal use; asof=fetch time, not eval date; unspecified effort is model-level evidence")


def eq_four(cache, result):
    url = EQ_ROOT + "eqbench4/eqbench4_data.js"
    data, _ = cache.get(url)
    match = re.search(r"const EQBENCH4_DATA\s*=\s*", data.decode())
    if not match:
        raise ValueError("EQ4 data literal missing")
    # Decode the JSON object without executing any JavaScript.
    data, _ = json.JSONDecoder().raw_decode(data.decode()[match.end():])
    for row in data["models"]:
        result.add(row["model"], row["elo"], "eqbench4", "EQ-Bench", data["generated_at"], url)
    result.notes.append("EQ-Bench 4: internal use; export date; emotional/social intelligence, distinct from creative writing; unspecified effort")


def design(cache, result):
    token = os.environ.get("DESIGNARENA_API_KEY")
    if not token:
        raise PermissionError("DESIGNARENA_API_KEY absent; official API requires approval")
    url = "https://www.designarena.ai/api/v1/leaderboard/models/website"
    data, _ = cache.get(url, token)
    data = json.loads(data)
    if (data["success"] is not True or data["meta"]["category"] != "website"
            or data["meta"]["arena"] != "models"):
        raise ValueError("DesignArena response not website leaderboard")
    for row in data["data"]:
        result.add(row["displayName"], row["elo"], "design_arena", "DesignArena",
                   data["meta"]["lastUpdated"], url)
    result.notes.append("DesignArena website: official authenticated API; internal use; leaderboard update date; https://www.designarena.ai")


def epoch(cache, result):
    url = "https://epoch.ai/data/benchmark_data.zip"
    data, asof = cache.get(url)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for filename, signal in [("gpqa_diamond.csv", "epoch_gpqa"),
                                 ("mirrorcode.csv", "epoch_mirrorcode"),
                                 ("swe_bench_verified.csv", "epoch_swe_verified")]:
            if archive.getinfo(filename).file_size > 16 * 1024 * 1024:
                raise ValueError("Epoch CSV exceeds size limit")
            for row in csv.DictReader(io.StringIO(archive.read(filename).decode("utf-8-sig"))):
                result.add(row["Model version"], row["mean_score"], signal, "Epoch",
                           row.get("Started at") or asof, url + "#" + filename)
    result.notes.append("Epoch AI, Capabilities & benchmarking: CC BY 4.0; https://epoch.ai/benchmarks/use-this-data; GPQA, MirrorCode and SWE Verified are cross-checks, not duplicate votes for AA benchmarks")


def cybergym(cache, result):
    url = "https://www.cybergym.io/assets/data/cybergym.json"
    data, _ = cache.get(url)
    for row in json.loads(data)["level1"]:
        if row.get("trials") != 1 or row.get("hidden") or row.get("focus") != "model":
            continue
        # Team submissions on the official board are not independent measurements.
        result.add(row["model"], row["score_10"], "cybergym", "CyberGym", row["date"],
                   row.get("source_url") or url, "vendor", row["source"] + "; harness=" + row["agent"])
    result.notes.append("CyberGym Level 1 single-trial model entries: internal use; team-submitted/vendor provenance; exact model names only; https://www.cybergym.io/cybergym/")


def cybench(cache, result):
    url = "https://cybench.github.io/data/leaderboard.csv"
    data, asof = cache.get(url)
    for row in csv.DictReader(io.StringIO(data.decode("utf-8-sig"))):
        name = row["Model"]
        vendor = any(mark in name for mark in "²³⁴⁵⁶⁷⁸")
        # Footnote glyphs are citations, not release identifiers.
        name = re.sub(r"\s*[¹²³⁴⁵⁶⁷⁸†]+$", "", name)
        result.add(name, row["End-to-End % Solved"], "cybench", "Cybench", asof, url,
                   "vendor" if vendor else "measured")
    result.notes.append("Cybench unguided end-to-end CSV: internal use; model-card footnotes retain vendor status; asof=fetch time, not eval date; subsets/harnesses differ; https://cybench.github.io")


PULLERS = {
    "arena-webdev": lambda c, r: arena(c, r, "webdev", "overall", "arena_webdev"),
    "arena-text": lambda c, r: arena(c, r, "text", "overall", "arena_text"),
    "arena-creative": lambda c, r: arena(c, r, "text", "creative_writing", "arena_creative"),
    "eq-creative": eq_creative, "eq4": eq_four, "design": design,
    "epoch": epoch, "cybergym": cybergym, "cybench": cybench,
}


def pull(state=STATE, catalog_file=None):
    catalog_file = catalog_file or Path.home() / ".claude/shared/model-tiers.json"
    catalog = catalog_ids(json.loads(catalog_file.read_text()))
    cache = Cache(state / "evidence-raw")
    output = state / "evidence-open.json"
    previous = json.loads(output.read_text()) if output.exists() else {"sources": {}}
    sources = {}
    for name, puller in PULLERS.items():
        result = Rows(catalog)
        try:
            puller(cache, result)
            sources[name] = dict(rows=result.rows, unmapped=sorted(result.unmapped), notes=result.notes)
            print(f"{name}: {len(result.rows)} rows, {len(result.unmapped)} unmapped", flush=True)
        except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile) as error:
            # Never print URLs, response bodies, headers, or arbitrary exception messages.
            reason = ("API key absent" if isinstance(error, PermissionError) else
                      f"HTTP {error.code}" if isinstance(error, urllib.error.HTTPError) else type(error).__name__)
            if isinstance(error, urllib.error.HTTPError):
                error.close()
            old = previous.get("sources", {}).get(name, {})
            note = (f"{name}: unavailable ({reason}); retained old rows with original dates"
                    if old.get("rows") else f"{name}: unavailable ({reason}); no evidence")
            notes = [n for n in old.get("notes", []) if not n.startswith(f"{name}: unavailable")]
            sources[name] = dict(rows=old.get("rows", []), unmapped=old.get("unmapped", []),
                                 notes=[*notes, note])
            print(note, flush=True)
    evidence = dict(sources=sources, rows=[r for s in sources.values() for r in s["rows"]],
                    unmapped=sorted({r for s in sources.values() for r in s["unmapped"]}),
                    notes=[r for s in sources.values() for r in s["notes"]])
    atomic(output, json.dumps(evidence, allow_nan=False).encode())
    return 0 if evidence["rows"] else 1


if __name__ == "__main__":
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (STATE / ".evidence.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            sys.exit(pull())
        except (OSError, ValueError, KeyError, TypeError) as error:
            print("evidence pull failed: " + type(error).__name__, file=sys.stderr)
            sys.exit(1)
