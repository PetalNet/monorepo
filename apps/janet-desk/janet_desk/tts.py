import asyncio

from wyoming.audio import AudioChunk, AudioStop
from wyoming.client import AsyncTcpClient
from wyoming.error import Error
from wyoming.tts import Synthesize, SynthesizeVoice

from .audio import Clip


class SynthesisError(Exception):
    pass


class WyomingSynthesizer:
    def __init__(self, host: str, port: int, voice: str, timeout: float = 150.0):
        self._timeout = timeout
        self._host = host
        self._port = port
        self._voice = voice

    async def synthesize(self, text: str) -> Clip:
        async with asyncio.timeout(self._timeout):
            return await self._synthesize(text)

    async def _synthesize(self, text: str) -> Clip:
        pcm = bytearray()
        rate = 0
        async with AsyncTcpClient(self._host, self._port) as server:
            await server.write_event(Synthesize(text=text, voice=SynthesizeVoice(name=self._voice)).event())
            while True:
                event = await server.read_event()
                if event is None:
                    raise SynthesisError("the voice server closed the connection")
                if Error.is_type(event.type):
                    raise SynthesisError(Error.from_event(event).text)
                if AudioChunk.is_type(event.type):
                    chunk = AudioChunk.from_event(event)
                    if (chunk.width, chunk.channels) != (2, 1):
                        raise SynthesisError("the voice server must send mono 16-bit audio")
                    rate = chunk.rate
                    pcm += chunk.audio
                elif AudioStop.is_type(event.type):
                    return Clip(bytes(pcm), rate)
