"""Opt-in proof: real Claude, MCP, HTTP gateway, phone admission and phone speech playback.

The caller supplies an STT transcript over the test socket. No production conversation,
notification or main Janet session is used. Pass an output directory and a Wyoming TTS host:port.
"""

import argparse
import asyncio
import json
import sys
import tempfile
import threading
import time
import wave
from http.server import ThreadingHTTPServer
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(APP), str(APP.parent / "janet-phone"), str(APP.parent / "janet-voice-gateway")]
import janet_phone
import pairing
import janet_voice_gateway as gateway
from janet_voice_head.head import Config, Head
from janet_voice_head.merge import Hub
from janet_voice_head.server import Handler
from janet_voice_head.session import ClaudeSession, locked_flags, transcript_path
from tests.harness import FakeHub
from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus


def serve(handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


async def prove(output: Path, tts: str, claude: str):
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="voice-lab-proof-") as tmp:
        root = Path(tmp)
        seed = ClaudeSession([claude, *locked_flags(lab=True), "--model", "sonnet", "--effort", "low"], str(root), lab=True)
        try:
            seed.wait_ready(30)
            list(seed.turn("This is an isolated voice test. Reply ready.", 60))
            parent = seed.session_id
        finally:
            seed.close()
        fake_hub = FakeHub(root)
        fake_hub.state_file.write_text(json.dumps({"sid": parent, "inbox": [], "inflight": {}}))
        token = root / "head-token"
        token.write_text("isolated-head-test")
        lab = root / "lab-token"
        lab.write_text("isolated-lab-test")
        hub_token = root / "hub-token"
        hub_token.write_text("isolated-hub-test")
        head = Head(Config(state_dir=root / "state", main_cwd=str(root), hub=Hub(fake_hub.url, hub_token, fake_hub.state_file, str(root)),
            claude=[claude], model="sonnet", cold_model="haiku", lab_token_file=str(lab), warm_up=False,
            bridge_after_s=0, idle_timeout_s=300, unmerged_channels=["readonly-proof"]))
        head_server = serve(type("ProofHead", (Handler,), {"head": head, "token": token.read_text()}))
        host, _, port = tts.rpartition(":")
        voice = gateway.Voice(host, int(port), "janet", bytes(6), ("127.0.0.1", 9), read_timeout=90)
        if not voice.awake():
            raise RuntimeError("TTS is asleep; this proof never sends wake packets")
        gate = serve(type("ProofGateway", (gateway.Handler,), {"head": f"http://127.0.0.1:{head_server.server_port}", "token": token.read_text(), "access": None, "voice": voice}))
        config = janet_phone.Config(listen="127.0.0.1:0", gateway=f"http://127.0.0.1:{gate.server_port}", stt="unused:0", tier="personal", channel="readonly-proof", disclosure="", head_token_file=str(token), lab_token_file=str(lab))
        devices = pairing.Devices(root / "devices.json")
        owner = devices.add("Scripted Parker", "parker", identity_verified=True)
        guest = devices.add("Scripted guest", "guest", identity_verified=True)
        ids = []

        async def spoken(ws):
            ids.append(ws.conversation)
            call = janet_phone.Call(ws, ws.call_config, ws.gateway, ws.conversation, ws.device)
            await call.reply(await ws.recv(), time.monotonic(), {"endpoint_ms": 0})
            await ws.send(json.dumps({"type": "proof-done"}))

        ws_server = await janet_phone.serve(spoken, "127.0.0.1", 0,
            process_request=lambda ws, request: janet_phone.admit(ws, request, config, devices))
        transcript = {"scope": "Real Claude and live systemctl/TTS. Scripted STT text; isolated session, registry and hub. No main Janet data or notifications.", "calls": []}
        try:
            url = f"ws://127.0.0.1:{ws_server.sockets[0].getsockname()[1]}/v1/call"
            for label, credential in (("parker", owner), ("guest", guest)):
                pcm, sentences, rate = bytearray(), [], 24000
                async with connect(url, additional_headers={"Authorization": "Bearer " + credential}) as ws:
                    await ws.send("what builders are running?")
                    while True:
                        item = await asyncio.wait_for(ws.recv(), 180)
                        if isinstance(item, bytes):
                            pcm.extend(item)
                            continue
                        event = json.loads(item)
                        if event["type"] == "proof-done":
                            break
                        if event["type"] == "audio":
                            rate = event["rate"]
                        if event["type"] == "words" and event["side"] == "her":
                            sentences.append(event["text"])
                assert pcm and sentences, "No spoken answer reached the phone socket"
                with wave.open(str(output / f"{label}.wav"), "wb") as wav:
                    wav.setnchannels(1)
                    wav.setsampwidth(2)
                    wav.setframerate(rate)
                    wav.writeframes(pcm)
                live = head._lives[ids[-1]]
                source = transcript_path(head._cwd(live.conv), live.session.session_id)
                tool_results = []
                if source.exists():
                    for line in source.read_text().splitlines():
                        content = json.loads(line).get("message", {}).get("content", [])
                        if isinstance(content, list):
                            tool_results.extend(block.get("content") for block in content if block.get("type") == "tool_result")
                if label == "guest":
                    assert not tool_results and not live.conv.parent_session and not live.conv.lab_access
                    assert "route-" not in " ".join(sentences)
                else:
                    assert tool_results and live.conv.lab_access, "The owner did not actually use a tool"
                transcript["calls"].append({"caller": label, "question": "what builders are running?", "spoken": sentences, "tool_results": tool_results, "audio_bytes": len(pcm), "lab_access": live.conv.lab_access})
                await asyncio.to_thread(head.end, live.conv.id, "proof")
            try:
                async with connect(url, additional_headers={"Authorization": "Bearer unpaired"}):
                    raise AssertionError("An unpaired caller was admitted")
            except InvalidStatus as error:
                assert error.response.status_code == 403
                transcript["unpaired"] = {"status": 403, "head_opened": False, "lab_data": False}
            assert not fake_hub.accepted, "Proof must not deliver to main"
            (output / "transcript.json").write_text(json.dumps(transcript, indent=2) + "\n")
            print(json.dumps(transcript, indent=2))
        finally:
            ws_server.close()
            await ws_server.wait_closed()
            head.close()
            for server in (head_server, gate, fake_hub.server):
                server.shutdown()
                server.server_close()
            # Delete only these isolated sessions, never any production transcript.
            for cwd in (str(root), str(root / "state/fork"), str(root / "state/cold")):
                folder = transcript_path(cwd, "unused").parent
                if folder.exists():
                    import shutil
                    shutil.rmtree(folder)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--tts", required=True)
    parser.add_argument("--claude", default="/home/agent/.local/bin/claude")
    args = parser.parse_args()
    asyncio.run(prove(args.output, args.tts, args.claude))
