"""Posts standard input to one Matrix room as a plain-text notice, encrypted when the room is."""

import argparse
import asyncio
import json
import sys
from pathlib import Path

from nio import AsyncClient, AsyncClientConfig, RoomSendResponse


async def post(homeserver: str, creds: dict, store: Path, room_id: str, text: str) -> str:
    store.mkdir(parents=True, exist_ok=True)
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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--homeserver", required=True)
    parser.add_argument("--creds", required=True, type=Path, help="JSON with user_id, device_id and access_token")
    parser.add_argument("--store", required=True, type=Path, help="this device's own key store")
    parser.add_argument("--room", required=True)
    args = parser.parse_args()
    creds = json.loads(args.creds.read_text())
    print(asyncio.run(post(args.homeserver, creds, args.store, args.room, sys.stdin.read())))


if __name__ == "__main__":
    main()
