"""Posts standard input to one Matrix room as a plain-text notice, encrypted when the room is."""

import argparse
import asyncio
import fcntl
import json
import sys
import time
from pathlib import Path



def rooms_of(arguments: list[str]) -> dict[str, str]:
    """DESTINATION=ROOM_ID arguments as a mapping. Two destinations may not share a room: that is how
    a test record would end up in the room kept for real calls."""
    rooms = dict(argument.split("=", 1) for argument in arguments)
    if len(set(rooms.values())) != len(rooms):
        raise ValueError("two destinations name the same room")
    return rooms


def destination_of(name: str) -> str:
    """The destination in an outbox file name, <stamp>.<destination>.txt; empty when it has none."""
    parts = name.split(".")
    return parts[1] if len(parts) == 3 and parts[2] == "txt" else ""


async def post(homeserver: str, creds: dict, store: Path, room_id: str, text: str) -> str:
    from nio import AsyncClient, AsyncClientConfig, RoomSendResponse

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


def watch(outbox: Path, rooms: dict[str, str], send) -> None:
    """Posts every <stamp>.<destination>.txt file that appears, oldest first, and deletes it once sent.

    A file whose destination has no room is set aside as .unrouted and never sent: a record must not
    reach a room it was not meant for, and must not hold up the records behind it.
    """
    while True:
        try:
            for path in sorted(outbox.glob("*.txt")):
                to = destination_of(path.name)
                if to not in rooms:
                    print(f"{path.name}: no room for destination {to!r}, set aside", file=sys.stderr, flush=True)
                    path.rename(path.with_suffix(".unrouted"))
                    continue
                print(path.name, send(to, path.read_text()), flush=True)
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
    parser.add_argument("--room", required=True, action="append", metavar="DESTINATION=ROOM_ID",
                        help="the room for one destination name; repeat for each destination")
    parser.add_argument("--to", help="the destination of standard input")
    parser.add_argument("--outbox", type=Path, help="post each <stamp>.<destination>.txt file that appears here")
    args = parser.parse_args()
    creds = json.loads(args.creds.read_text())
    rooms = rooms_of(args.room)

    def send(to: str, text: str) -> str:
        if to not in rooms:
            raise SystemExit(f"no room for destination {to!r}")
        # One sender at a time: two processes on one device corrupt its encryption sessions.
        args.store.mkdir(parents=True, exist_ok=True)
        with open(args.store / "sender.lock", "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            return asyncio.run(post(args.homeserver, creds, args.store, rooms[to], text))

    if args.outbox is not None:
        watch(args.outbox, rooms, send)
    else:
        print(send(args.to or "", sys.stdin.read()))


if __name__ == "__main__":
    main()
