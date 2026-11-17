"""Janet's desk voice client: microphone to Home Assistant, the voice head, the voice server and the headphones."""

import argparse
import asyncio
import json
import logging
import tomllib
from pathlib import Path
from urllib.parse import urlsplit

import aiohttp

from .audio import MicHub, RecordingSpeaker, ScriptedMic, SileroVoice, parse_mic_script, write_wav
from .client import DeskClient, Settings, Trace
from .ha import AssistListener
from .head import HeadClient
from .tts import WyomingSynthesizer


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="janet-desk", description=__doc__)
    parser.add_argument("--config", type=Path, help="TOML configuration file (see the README)")
    parser.add_argument("--list-devices", action="store_true", help="print the audio device names and exit")
    parser.add_argument(
        "--mic-script",
        help="replace the microphone with a script: wav:<path>, silence:<seconds> and wait:<trace event> steps",
    )
    parser.add_argument(
        "--record-output",
        type=Path,
        help="write what would have been played to this WAV instead of playing it on the output device",
    )
    parser.add_argument("--trace", type=Path, help="append every timestamped client event to this JSON lines file")
    return parser.parse_args()


async def run(options: argparse.Namespace) -> None:
    config = tomllib.loads(options.config.read_text(encoding="utf-8"))
    assist, head, voice, audio = config["home_assistant"], config["head"], config["voice"], config["audio"]
    conversation = config.get("conversation", {})
    trace = Trace()
    if options.trace:
        trace_file = options.trace.open("a", buffering=1, encoding="utf-8")
        trace.observers.append(lambda record: trace_file.write(json.dumps(record) + "\n"))

    if options.mic_script:
        frames = ScriptedMic(parse_mic_script(options.mic_script))
        trace.observers.append(lambda record: frames.notice(record["event"]))
    else:
        from .devices import Microphone

        frames = Microphone(audio.get("microphone", ""))
    if options.record_output:
        speaker = RecordingSpeaker(audio["output"])
    else:
        from .devices import DeviceSpeaker

        speaker = DeviceSpeaker(audio.get("output", ""), audio.get("volume", 1.0))

    server = urlsplit(voice["wyoming"])
    async with aiohttp.ClientSession() as session:
        client = DeskClient(
            mic=MicHub(frames),
            listener=AssistListener(
                session, assist["url"], Path(assist["token_file"]).read_text().strip(), assist["pipeline"]
            ),
            head=HeadClient(
                session, head["url"], Path(head["token_file"]).read_text().strip(), head.get("channel", "desk")
            ),
            synthesizer=WyomingSynthesizer(server.hostname, server.port, voice["name"]),
            speaker=speaker,
            voice=SileroVoice(),
            settings=Settings(headphones=frozenset(audio["headphones"]), **conversation),
            trace=trace,
        )
        try:
            await client.run()
        finally:
            if options.record_output and (recording := speaker.recording()):
                write_wav(str(options.record_output), recording)


def main() -> None:
    options = arguments()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    if options.list_devices:
        from .devices import device_names

        print(json.dumps({kind: device_names(kind) for kind in ("input", "output")}, indent=2))
        return
    if not options.config:
        raise SystemExit("--config is required")
    asyncio.run(run(options))


if __name__ == "__main__":
    main()
