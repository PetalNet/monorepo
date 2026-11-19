"""Send a WAV at microphone speed and require a transcript before EOS. Use public test speech."""

import argparse
import asyncio
import json
import time
import wave
from pathlib import Path
from urllib.parse import urlencode

from websockets.asyncio.client import connect

from janet_dictate import PCM_TYPE, RATE


async def probe(url: str, token_file: Path, wav: Path) -> None:
    with wave.open(str(wav)) as audio:
        if (audio.getframerate(), audio.getnchannels(), audio.getsampwidth()) != (RATE, 1, 2):
            raise ValueError("WAV must be PCM16 mono at 16000 Hz")
        pcm = audio.readframes(audio.getnframes())
    query = urlencode({"key": token_file.read_text().strip(), "content-type": PCM_TYPE, "lang": "en-US"})
    eos_at = None
    partial_before_eos = False
    final = None
    started = time.monotonic()
    async with connect(
        url + "?" + query,
        compression=None,
        additional_headers={"Sec-WebSocket-Protocol": "", "Sec-WebSocket-Extensions": "x-webkit-deflate-frame"},
    ) as ws:

        async def send():
            nonlocal eos_at
            for offset in range(0, len(pcm), 6400):
                await ws.send(pcm[offset : offset + 6400])
                await asyncio.sleep(0.2)
            eos_at = time.monotonic() - started
            print(json.dumps({"seconds": round(eos_at, 3), "sent": "EOS"}), flush=True)
            await ws.send("EOS")

        async with asyncio.TaskGroup() as tasks:
            tasks.create_task(send())
            async with asyncio.timeout(len(pcm) / (RATE * 2) + 15):
                async for message in ws:
                    reply = json.loads(message)
                    print(json.dumps({"seconds": round(time.monotonic() - started, 3), **reply}), flush=True)
                    if reply["status"] != 0:
                        raise RuntimeError(f"dictation failed with status {reply['status']}")
                    if reply["result"]["final"]:
                        final = reply["result"]["hypotheses"][0]["transcript"]
                    elif eos_at is None:
                        partial_before_eos = True
    if not partial_before_eos or not final:
        raise RuntimeError("expected live partials before EOS and a nonempty final transcript")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True, help="WebSocket URL without query parameters")
    parser.add_argument("--token-file", required=True, type=Path)
    parser.add_argument("wav", type=Path)
    args = parser.parse_args()
    asyncio.run(probe(args.url, args.token_file, args.wav))
