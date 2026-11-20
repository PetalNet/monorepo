#!/usr/bin/env python3
"""Collect lab inventory, match advisories, and retain coverage evidence."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def fresh(inventory: dict, at: str) -> bool:
    age = datetime.fromisoformat(at) - datetime.fromisoformat(inventory["collected_at"])
    return timedelta(0) <= age <= timedelta(hours=26)


def validate_inventory(value: dict) -> dict:
    datetime.fromisoformat(value["collected_at"])
    ids = set()
    for asset in value["assets"]:
        for key in ("id", "host", "service", "product"):
            if not isinstance(asset[key], str) or not asset[key]:
                raise ValueError(f"inventory requires nonempty {key}")
        if asset["id"] in ids:
            raise ValueError("duplicate asset id")
        ids.add(asset["id"])
        if asset["exposure"] not in ("internet", "internal", "unknown"):
            raise ValueError("invalid exposure")
        if asset.get("version") is not None and not isinstance(asset["version"], str):
            raise ValueError("version must be a string or null")
    return value


def release(version: str | None) -> tuple | None:
    if version and re.fullmatch(r"\d+(?:\.\d+)*", version):
        return tuple(int(x) for x in version.split("."))
    return None


def compare(left: tuple, right: tuple) -> int:
    length = max(len(left), len(right))
    a = left + (0,) * (length - len(left))
    b = right + (0,) * (length - len(right))
    return (a > b) - (a < b)


def rule_check(asset: dict, rule: dict) -> tuple[str, str]:
    """Evaluate reviewed vendor rules against observed runtime facts."""
    required_flags = set(rule.get("cpu_flags", []))
    flags = asset.get("cpu_flags")
    if required_flags and flags is not None and not required_flags.issubset(flags):
        return "unaffected", "observed CPU lacks a required instruction set"
    mitigations = set(rule.get("mitigations", []))
    verified_flags = not rule.get("require_runtime_flags") or asset.get("runtime_flags_verified") is True
    if verified_flags and mitigations.intersection(asset.get("mitigations", [])):
        return "unaffected", "observed running process mitigation flag"
    version = release(asset.get("version"))
    if version is None:
        return "unknown", "runtime version is missing or needs ecosystem-specific comparison"
    introduced = release(rule.get("introduced"))
    if introduced and compare(version, introduced) < 0:
        return "unaffected", "runtime predates the affected range"
    fixed = rule.get("fixed_by_major", {}).get(str(version[0]))
    if fixed and compare(version, release(fixed)) >= 0:
        return "unaffected", f"observed runtime {asset['version']} is at least fixed release {fixed}"
    if required_flags and flags is None:
        return "unknown", "CPU flags were not observed"
    if not verified_flags:
        return "unknown", "effective JVM flags were not observed"
    if not introduced:
        return "unknown", "vendor rule has no supported version range"
    return "affected", f"observed runtime {asset['version']} matches the reviewed vendor range and conditions"


def vendor_advisories(inventory: dict, rules: list[dict]) -> list[dict]:
    result = []
    for rule in rules:
        affected = []
        for asset in inventory["assets"]:
            if asset["product"].casefold() in [x.casefold() for x in rule["products"]]:
                verdict, evidence = rule_check(asset, rule)
                affected.append({"asset_id": asset["id"], "verdict": verdict, "evidence": evidence})
        result.append({**rule, "affected": affected})
    return result


def overlay_vendor_rules(ingestion: dict, inventory: dict, rules: list[dict]) -> None:
    """Reviewed vendor conditions refine feed matches, including CPU requirements."""
    for vendor in vendor_advisories(inventory, rules):
        names = {vendor["id"], *vendor.get("aliases", [])}
        covered = {a["asset_id"] for a in vendor["affected"]}
        for advisory in ingestion["advisories"][:]:
            if names.intersection({advisory["id"], *advisory.get("aliases", [])}):
                vendor["kev"] = vendor.get("kev", False) or advisory.get("kev", False)
                vendor["affected"].extend(c for c in advisory["affected"] if c["asset_id"] not in covered)
                names.update([advisory["id"], *advisory.get("aliases", [])])
                ingestion["advisories"].remove(advisory)
        vendor["aliases"] = sorted(names - {vendor["id"]})
        ingestion["advisories"].append(vendor)
        resolved = {c["asset_id"] for c in vendor["affected"] if c["verdict"] != "unknown"}
        ingestion["gaps"] = [g for g in ingestion.get("gaps", []) if not any(
            str(g).startswith(f"{vendor['id']} on {asset_id}: unverified applicability;") for asset_id in resolved)]


def database(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.executescript("""
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS advisories (
            id TEXT PRIMARY KEY, payload TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS aliases (alias TEXT PRIMARY KEY, advisory TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS osv_tracking (
            advisory TEXT NOT NULL, asset TEXT NOT NULL, ecosystem TEXT NOT NULL, name TEXT NOT NULL,
            PRIMARY KEY(advisory, asset, ecosystem, name)
        );
        CREATE TABLE IF NOT EXISTS items (
            advisory TEXT NOT NULL, asset TEXT NOT NULL, status TEXT NOT NULL,
            opened TEXT NOT NULL, checked TEXT NOT NULL, evidence TEXT NOT NULL,
            snapshot TEXT NOT NULL, generation INTEGER NOT NULL,
            PRIMARY KEY(advisory, asset)
        );
        CREATE TABLE IF NOT EXISTS outbox (
            id TEXT PRIMARY KEY, body TEXT NOT NULL, event_id TEXT,
            created TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS runs (
            at TEXT PRIMARY KEY, summary TEXT NOT NULL
        );
    """)
    return db


def enqueue(db: sqlite3.Connection, key: str, body: str, at: str) -> None:
    txn = hashlib.sha256(key.encode()).hexdigest()
    db.execute("INSERT OR IGNORE INTO outbox VALUES (?, ?, NULL, ?)", (txn, body, at))


def alert(advisory: dict, asset: dict, status: str, evidence: str, replay: bool) -> str:
    prefix = "[REPLAY: test inventory, not a live lab finding]\n" if replay else ""
    policy = "Patch promptly through Derek/compose with health check and rollback; major upgrades require owner action."
    if "eli" in asset.get("owner", "").lower() or asset["host"] == "proxmox" or re.search(
        r"postgres|mariadb|mysql|mongodb|proxmox|truenas", asset["product"], re.I
    ):
        policy = "Owner action required; watcher does not apply upgrades."
    return (
        f"{prefix}{advisory['id']} | {advisory.get('severity', 'unknown')} | "
        f"CISA KEV: {'yes' if advisory.get('kev') else 'not confirmed'} | {status}\n"
        f"Host: {asset['host']}; service: {asset['service']}; version: {asset.get('version') or 'unknown'}; "
        f"internet-facing: {asset['exposure']}\n"
        f"Evidence: {evidence}\nFix/mitigation: {advisory.get('fix') or 'Review vendor advisory.'}\n"
        f"{policy}\n{advisory.get('url', '')}"
    )


def reconcile(db: sqlite3.Connection, inventory: dict, ingestion: dict,
              at: str | None = None, replay: bool = False, emit_digest: bool = True) -> dict:
    at = at or now()
    validate_inventory(inventory)
    assets = {a["id"]: a for a in inventory["assets"]}
    gaps = list(inventory.get("gaps", [])) + list(ingestion.get("gaps", []))
    is_fresh = fresh(inventory, at)
    namespace = "replay/" if replay else "live/"
    if not is_fresh:
        gaps.append("inventory is stale or has a future timestamp; no coverage transitions allowed")
    merged: dict[str, dict] = {}
    for incoming in ingestion["advisories"]:
        aliases = sorted(set([incoming["id"], *incoming.get("aliases", [])]))
        known = {row[0] for alias in aliases for row in db.execute(
            "SELECT advisory FROM aliases WHERE alias = ?", (alias,)
        )}
        if len(known) > 1:
            gaps.append(f"alias conflict for {incoming['id']}; manual deduplication needed")
            continue
        identifier = next(iter(known), next((a for a in aliases if a.startswith("CVE-")), incoming["id"]))
        prior = merged.get(identifier)
        if prior:
            prior["affected"].extend(incoming.get("affected", []))
            prior["kev"] = prior.get("kev", False) or incoming.get("kev", False)
            prior["aliases"] = sorted(set(prior["aliases"] + aliases))
            prior.setdefault("osv_bindings", []).extend(incoming.get("osv_bindings", []))
        else:
            merged[identifier] = {**incoming, "id": identifier, "aliases": aliases,
                                  "affected": list(incoming.get("affected", []))}
    opened = closed = filtered = unknown = 0
    with db:
        for identifier, advisory in merged.items():
            db.execute("INSERT OR REPLACE INTO advisories VALUES (?, ?)", (identifier, json.dumps(advisory)))
            for alias in advisory["aliases"]:
                db.execute("INSERT OR IGNORE INTO aliases VALUES (?, ?)", (alias, identifier))
            for binding in advisory.get("osv_bindings", []):
                db.execute("INSERT OR IGNORE INTO osv_tracking VALUES (?, ?, ?, ?)",
                           (identifier, binding["asset_id"], binding["ecosystem"], binding["name"]))
            checks: dict[str, list[dict]] = {}
            for check in advisory.get("affected", []):
                if check["asset_id"] not in assets:
                    gaps.append(f"{identifier}: advisory references an absent asset")
                    continue
                if check["verdict"] not in ("affected", "unaffected", "unknown") or not check.get("evidence"):
                    raise ValueError("advisory check requires a verdict and evidence")
                checks.setdefault(check["asset_id"], []).append(check)
                if check["verdict"] == "affected" and check.get("source") == "osv":
                    package = check["package"]
                    db.execute("INSERT OR IGNORE INTO osv_tracking VALUES (?, ?, ?, ?)",
                               (identifier, check["asset_id"], package["ecosystem"], package["name"]))
            for asset_id, candidates in checks.items():
                asset = assets[asset_id]
                # Conflicting evidence cannot close an item or assert a real match.
                verdicts = {c["verdict"] for c in candidates}
                verdict = next(iter(verdicts)) if len(verdicts) == 1 else "unknown"
                evidence = "; ".join(sorted(set(c["evidence"] for c in candidates)))
                row = db.execute("SELECT * FROM items WHERE advisory = ? AND asset = ?",
                                 (identifier, asset_id)).fetchone()
                if verdict == "unknown":
                    unknown += 1
                    gaps.append(f"{identifier} {asset_id}: {evidence}")
                    continue
                if not is_fresh:
                    continue
                observed = asset.get("observed_at", inventory["collected_at"])
                if not fresh({"collected_at": observed}, at) or any(
                    str(e).startswith("stale:") for e in asset.get("evidence", [])
                ):
                    gaps.append(f"{identifier} {asset_id}: stale asset observation; item retained")
                    continue
                if verdict == "unaffected":
                    filtered += 1
                    if row and row["status"] == "open":
                        db.execute("UPDATE items SET status='closed', checked=?, evidence=?, snapshot=? "
                                   "WHERE advisory=? AND asset=?",
                                   (at, evidence, json.dumps(asset), identifier, asset_id))
                        closed += 1
                        enqueue(db, namespace + f"{identifier}/{asset_id}/{row['generation']}/closed",
                                alert(advisory, asset, "closed (verified)", evidence, replay), at)
                    continue
                generation = (row["generation"] + 1) if row and row["status"] == "closed" else (row["generation"] if row else 1)
                db.execute("INSERT INTO items VALUES (?, ?, 'open', ?, ?, ?, ?, ?) "
                           "ON CONFLICT(advisory, asset) DO UPDATE SET status='open', checked=excluded.checked, "
                           "evidence=excluded.evidence, snapshot=excluded.snapshot, generation=excluded.generation",
                           (identifier, asset_id, at, at, evidence, json.dumps(asset), generation))
                if not row or row["status"] == "closed":
                    opened += 1
                    enqueue(db, namespace + f"{identifier}/{asset_id}/{generation}/open",
                            alert(advisory, asset, "open", evidence, replay), at)
        for row in db.execute("SELECT advisory, asset FROM items WHERE status='open'"):
            if row["asset"] not in assets:
                gaps.append(f"{row['advisory']} {row['asset']}: asset absent; item remains open")
        total = db.execute("SELECT count(*) FROM items WHERE status='open'").fetchone()[0]
        summary = {"at": at, "assets": len(assets), "ingested": ingestion.get("stats", {}),
                   "advisories": len(merged), "filtered": filtered, "unknown": unknown,
                   "opened": opened, "closed": closed, "open": total, "gaps": gaps}
        db.execute("INSERT OR REPLACE INTO runs VALUES (?, ?)", (at, json.dumps(summary)))
        prefix = "[REPLAY: test inventory] " if replay else ""
        digest = (f"{prefix}vuln-watch daily {at[:10]}: {len(assets)} assets; "
                  f"ingested {json.dumps(summary['ingested'], sort_keys=True)}; "
                  f"{len(merged)} advisories; {filtered} checks filtered; {unknown} unresolved checks; "
                  f"{opened} opened, {closed} verified closed, {total} still open; {len(gaps)} coverage gaps.")
        if gaps:
            digest += "\nCoverage gaps (first 8): " + "; ".join(str(g) for g in gaps[:8])
        if emit_digest:
            enqueue(db, namespace + "digest/" + at[:10], digest, at)
    return summary


def deliver(db: sqlite3.Connection, poster: dict) -> list[dict]:
    """The existing poster adapter accepts JSON stdin and returns {event_id}."""
    receipts = []
    for row in db.execute("SELECT * FROM outbox WHERE event_id IS NULL ORDER BY created, rowid").fetchall():
        payload = {"room_id": poster["room_id"], "body": row["body"], "transaction_id": row["id"]}
        result = subprocess.run(poster["command"], input=json.dumps(payload), text=True,
                                capture_output=True, timeout=60, check=True)
        receipt = json.loads(result.stdout)
        event_id = receipt.get("event_id")
        if not isinstance(event_id, str) or not event_id.startswith("$"):
            raise ValueError("poster returned no Matrix event id; item stays pending")
        with db:
            db.execute("UPDATE outbox SET event_id=? WHERE id=?", (event_id, row["id"]))
        receipts.append({"transaction_id": row["id"], "event_id": event_id})
    return receipts


def report(db: sqlite3.Connection) -> dict:
    return {"items": [dict(row) for row in db.execute("SELECT * FROM items ORDER BY status, advisory, asset")],
            "receipts": [dict(row) for row in db.execute("SELECT id, event_id, created FROM outbox")],
            "last_run": (lambda row: json.loads(row[0]) if row else None)(
                db.execute("SELECT summary FROM runs ORDER BY at DESC LIMIT 1").fetchone())}


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


def apply_mappings(inventory: dict, config: dict) -> None:
    for asset in inventory["assets"]:
        mappings = [m for m in config.get("product_mappings", []) if m.get("match") and
                    all(asset.get(key) == value for key, value in m["match"].items())]
        specific = config.get("asset_mappings", {}).get(asset["id"])
        if specific:
            mappings.append(specific)
        for mapping in mappings:
            for key in ("product", "cpes", "repositories"):
                if key in mapping:
                    asset[key] = mapping[key]
            version = asset.get("version")
            prefix = mapping.get("version_prefix")
            if version and prefix and version.startswith(prefix):
                version = version[len(prefix):]
                asset["version"] = version
            if version:
                for key, target in (("package_identities", "packages"),
                                    ("vendor_package_identities", "vendor_packages")):
                    if mapping.get(key):
                        asset[target] = [{**identity, "version": version} for identity in mapping[key]]
            if mapping.get("cpe_identity"):
                identity = mapping["cpe_identity"]
                if not re.fullmatch(r"[aoh]:[a-z0-9_.-]+:[a-z0-9_.-]+", identity):
                    raise ValueError("cpe_identity requires part:vendor:product")
                asset["cpes"] = [f"cpe:2.3:{identity}:*:*:*:*:*:*:*:*"]
    mapped = {a["id"] for a in inventory["assets"] if a.get("packages") or a.get("cpes")}
    inventory["gaps"] = [g for g in inventory.get("gaps", []) if not (
        isinstance(g, dict) and any(g.get("reason") == identifier + ": product unmapped to package or CPE"
                                   for identifier in mapped))]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("run", "report", "replay", "deliver"))
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--inventory", type=Path)
    parser.add_argument("--advisories", type=Path)
    parser.add_argument("--post", action="store_true", help="deliver pending alerts using the configured poster")
    parser.add_argument("--replay-state", action="store_true", help="report or retry delivery from isolated replay state")
    parser.add_argument("--no-digest", action="store_true", help="hourly feed scans leave the daily digest to the inventory job")
    options = parser.parse_args()
    if options.replay_state and options.action not in ("report", "deliver"):
        parser.error("--replay-state is available only for report and deliver")
    config = json.loads(options.config.read_text())
    state = Path(config["state_dir"]).expanduser().resolve()
    if str(state).startswith("/mnt/nas/"):
        raise ValueError("runtime state must be on local storage")
    if options.action == "replay" or options.replay_state:
        state = state / "replay"
    state.mkdir(parents=True, exist_ok=True)
    os.chmod(state, 0o700)
    with (state / "run.lock").open("w") as lock:
        try:
            flags = fcntl.LOCK_EX | (fcntl.LOCK_NB if options.action == "deliver" or options.inventory else 0)
            fcntl.flock(lock, flags)
        except BlockingIOError:
            sys.exit(75)
        db = database(state / "coverage.sqlite")
        if options.action == "report":
            print(json.dumps(report(db), indent=2))
            return
        if options.action == "deliver":
            print(json.dumps({"receipts": deliver(db, config["poster"])}, indent=2))
            return
        if options.action == "replay" and (not options.inventory or not options.advisories):
            parser.error("replay requires explicit inventory and advisory fixtures")
        if options.inventory:
            inventory = json.loads(options.inventory.read_text())
        else:
            from inventory import collect
            if (state / "inventory.json").exists():
                config["_previous_inventory"] = json.loads((state / "inventory.json").read_text())
            inventory = collect(config)
        validate_inventory(inventory)
        apply_mappings(inventory, config)
        write_json(state / "inventory.json", inventory)
        if options.advisories:
            ingestion = json.loads(options.advisories.read_text())
        else:
            from feeds import ingest
            config["_tracked_advisories"] = [json.loads(r[0]) for r in db.execute("SELECT payload FROM advisories")]
            config["_tracked_osv"] = [dict(r) for r in db.execute("SELECT * FROM osv_tracking")]
            ingestion = ingest(inventory, config, state / "cache")
        overlay_vendor_rules(ingestion, inventory, config.get("vendor_rules", []))
        write_json(state / "ingestion.json", ingestion)
        summary = reconcile(db, inventory, ingestion, replay=options.action == "replay", emit_digest=not options.no_digest)
        receipts = deliver(db, config["poster"]) if options.post else []
        write_json(state / "report.json", report(db))
        print(json.dumps({"summary": summary, "receipts": receipts}, indent=2))


if __name__ == "__main__":
    main()
