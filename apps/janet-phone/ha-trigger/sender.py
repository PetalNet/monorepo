"""Durable HA call requests, delivered only to Janet's encrypted DM."""

import asyncio
import hashlib
import json
import os
import re
import sqlite3
import sys
from pathlib import Path

ROOT = Path.home() / ".local/state/janet-call-trigger"
ROOM = "!FccCIgRbxzylIkvkNk:mx.petalcat.dev"
HOMESERVER = "http://10.10.10.14:8008"


def database():
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    db = sqlite3.connect(ROOT / "queue.sqlite3", timeout=10)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA secure_delete=ON")
    db.execute("CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, body TEXT NOT NULL, event_id TEXT, body_hash TEXT)")
    if 'body_hash' not in {row[1] for row in db.execute('PRAGMA table_info(requests)')}:
        db.execute('ALTER TABLE requests ADD COLUMN body_hash TEXT')
    for request_id, body in db.execute('SELECT id,body FROM requests WHERE body_hash IS NULL').fetchall():
        db.execute('UPDATE requests SET body_hash=? WHERE id=?', (hashlib.sha256(body.encode()).hexdigest(), request_id))
    db.execute("UPDATE requests SET body='' WHERE event_id IS NOT NULL AND body<>''")
    return db


def enqueue(payload):
    if not isinstance(payload, dict):
        raise ValueError("object required")
    request_id, body = payload.get("request_id"), payload.get("message")
    if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", request_id):
        raise ValueError("invalid request_id")
    if not isinstance(body, str) or not body or len(json.dumps(body).encode()) > 8000:
        raise ValueError("invalid message")
    digest = hashlib.sha256(body.encode()).hexdigest()
    with database() as db:
        existing = db.execute('SELECT body_hash FROM requests WHERE id=?', (request_id,)).fetchone()
        if existing is not None and existing[0] != digest:
            raise ValueError('conflicting request_id')
        db.execute("INSERT OR IGNORE INTO requests(id,body,body_hash) VALUES (?,?,?)", (request_id, body, digest))


async def serve():
    from nio import AsyncClient, AsyncClientConfig, RoomSendResponse

    creds = json.loads((ROOT / "account.json").read_text())
    store = ROOT / "store"
    store.mkdir(mode=0o700, exist_ok=True)
    client = AsyncClient(HOMESERVER, creds["user_id"], device_id=creds["device_id"],
                         store_path=str(store),
                         config=AsyncClientConfig(store_sync_tokens=True, encryption_enabled=True))
    client.restore_login(creds["user_id"], creds["device_id"], creds["access_token"])
    client.load_store()
    sync = None
    try:
        if client.should_upload_keys:
            await client.keys_upload()
        await asyncio.wait_for(client.sync(timeout=0, full_state=True), timeout=30)
        if ROOM not in client.rooms:
            raise RuntimeError("sender has not joined janet-dm")
        if not client.rooms[ROOM].encrypted:
            raise RuntimeError("janet-dm must be encrypted")
        sync = asyncio.create_task(client.sync_forever(timeout=15000))
        print("ready: janet-dm encrypted sender", flush=True)
        while not sync.done():
            with database() as db:
                pending = db.execute("SELECT id,body FROM requests WHERE event_id IS NULL ORDER BY rowid").fetchall()
            for request_id, body in pending:
                try:
                    response = await asyncio.wait_for(client.room_send(
                        ROOM, "m.room.message",
                        {"msgtype": "m.text", "body": body,
                         "m.mentions": {"user_ids": ["@janet:mx.petalcat.dev"]}},
                        tx_id=request_id, ignore_unverified_devices=True), timeout=20)
                    if not isinstance(response, RoomSendResponse):
                        print(f"retry {request_id}: Matrix rejected send", flush=True)
                        await asyncio.sleep(5)
                        break
                    with database() as db:
                        db.execute("UPDATE requests SET event_id=?,body='' WHERE id=?", (response.event_id, request_id))
                    with sqlite3.connect(ROOT / 'queue.sqlite3') as db:
                        db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
                    print(f"sent {request_id} {response.event_id}", flush=True)
                except Exception as error:
                    print(f"retry {request_id}: {type(error).__name__}", flush=True)
                    await asyncio.sleep(5)
                    break
            await asyncio.sleep(0.5)
        await sync
    finally:
        if sync is not None:
            sync.cancel()
            await asyncio.gather(sync, return_exceptions=True)
        await client.close()


if __name__ == "__main__":
    os.umask(0o077)
    if sys.argv[1:] == ["enqueue"]:
        try:
            enqueue(json.load(sys.stdin))
        except (ValueError, sqlite3.Error) as error:
            sys.exit(f"request rejected: {type(error).__name__}")
    elif sys.argv[1:]:
        sys.exit("usage: sender.py [enqueue]")
    else:
        asyncio.run(serve())
