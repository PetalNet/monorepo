"""Posts standard input to one Matrix room as a plain-text notice, encrypted when the room is."""

import argparse
import asyncio
import fcntl
import json
import sys
import time
from pathlib import Path

from nio import AsyncClient, AsyncClientConfig, RoomSendResponse


async def post(homeserver: str, creds: dict, store: Path, room_id: str, text: str) -> str:
    config = AsyncClientConfig(store_sync_tokens=True, encryption_enabled=True)
    client = AsyncClient(homeserver, creds["user_id"], device_id=creds["device_id"], store_path=str(store), config=config)
    client.restore_login(creds["user_id"], creds["device_id"], creds["access_token"])
    try:
        client.load_store()
        if client.should_upload_keys:
            await client.keys_upload()
        await asyncio.wait_for(client.sync(timeout=30000, full_state=True), timeout=90)
        if room_id not in client.rooms:
            raise SystemExit(f"not joined to {room_id}")
        content = {"msgtype": "m.notice", "body": text}
        sent = await client.room_send(room_id, "m.room.message", content, ignore_unverified_devices=True)
        if not isinstance(sent, RoomSendResponse):
            raise SystemExit(f"send failed: {sent}")
        return sent.event_id
    finally:
        await client.close()


def watch(outbox: Path, send) -> None:
    """Posts every *.txt file that appears in the directory, oldest first, and deletes it once sent."""
    while True:
        try:
            for path in sorted(outbox.glob("*.txt")):
                print(path.name, send(path.read_text()), flush=True)
                path.unlink()
        except (Exception, SystemExit) as error:  # noqa: BLE001 - a record that failed to send is retried
            print(f"not sent, retrying: {error}", file=sys.stderr, flush=True)
            time.sleep(60)
        time.sleep(5)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--homeserver", required=True)
    parser.add_argument("--creds", required=True, type=Path, help="JSON with user_id, device_id and access_token")
    parser.add_argument("--store", required=True, type=Path, help="this device's key store")
    parser.add_argument("--room", required=True)
    parser.add_argument("--outbox", type=Path, help="post each *.txt file that appears here, instead of standard input")
    args = parser.parse_args()
    creds = json.loads(args.creds.read_text())

    def send(text: str) -> str:
        # One sender at a time: two processes on one device corrupt its encryption sessions.
        args.store.mkdir(parents=True, exist_ok=True)
        with open(args.store / "sender.lock", "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            return asyncio.run(post(args.homeserver, creds, args.store, args.room, text))

    if args.outbox is not None:
        watch(args.outbox, send)
    else:
        print(send(sys.stdin.read()))


if __name__ == "__main__":
    main()
