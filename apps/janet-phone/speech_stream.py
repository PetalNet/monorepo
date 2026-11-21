"""A bounded handoff from blocking HTTP synthesis to the call's audio loop."""

import asyncio
import concurrent.futures
import http.client
import io
import json
import socket
import struct
import threading
import wave
from contextlib import closing
from urllib.parse import urlsplit


class PcmSource:
    """An HTTP speech request whose socket can be shut down during a blocked read."""

    def __init__(self, url, headers, body):
        self.url, self.headers, self.body = urlsplit(url), headers, json.dumps(body).encode()
        self.stopped = threading.Event()
        self.socket = None

    def cancel(self):
        self.stopped.set()
        sock = self.socket
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    close = cancel

    def __iter__(self):
        for _ in range(24):
            if self.stopped.is_set():
                return
            connection_type = http.client.HTTPSConnection if self.url.scheme == "https" else http.client.HTTPConnection
            with closing(connection_type(self.url.hostname, self.url.port, timeout=10)) as connection:
                connection.connect()
                self.socket = connection.sock
                self.socket.settimeout(300)
                if self.stopped.is_set():
                    return
                path = self.url.path or "/"
                if self.url.query:
                    path += "?" + self.url.query
                connection.request("POST", path, self.body, {**self.headers, "content-type": "application/json"})
                with connection.getresponse() as response:
                    if response.status == 503:
                        if self.stopped.wait(5):
                            return
                        continue
                    if response.status != 200:
                        raise OSError(f"speech gateway returned HTTP {response.status}")
                    if response.getheader("content-type", "").split(";")[0] == "audio/wav":
                        with wave.open(io.BytesIO(response.read())) as wav:
                            yield wav.getframerate(), wav.readframes(wav.getnframes())
                        return
                    while header := response.read(8):
                        if len(header) != 8:
                            raise OSError("truncated speech record")
                        rate, length = struct.unpack(">II", header)
                        if not 8000 <= rate <= 48000 or not 0 < length <= 16384 or length % 2:
                            raise ValueError("invalid speech record")
                        pcm = response.read(length)
                        if len(pcm) != length:
                            raise OSError("truncated speech audio")
                        yield rate, pcm
                    return
        raise OSError("the voice host did not wake")


class SpeechStream:
    def __init__(self, source):
        self.queue = asyncio.Queue(maxsize=4)
        self.stopped = threading.Event()
        self.loop = asyncio.get_running_loop()
        self.source = source
        self.task = asyncio.create_task(asyncio.to_thread(self._pump))

    def _put(self, item):
        if self.stopped.is_set():
            return False
        delivery = asyncio.run_coroutine_threadsafe(self.queue.put(item), self.loop)
        while not self.stopped.is_set():
            try:
                delivery.result(timeout=0.1)
                return True
            except concurrent.futures.TimeoutError:
                continue
        delivery.cancel()
        return False

    def _pump(self):
        try:
            for chunk in self.source:
                if not self._put(chunk):
                    return
        except Exception as error:
            self._put(error)
        finally:
            self.source.close()
            self._put(None)

    def __aiter__(self):
        return self

    async def __anext__(self):
        item = await self.queue.get()
        if item is None:
            raise StopAsyncIteration
        if isinstance(item, Exception):
            raise item
        return item

    def close(self):
        self.stopped.set()
        if cancel := getattr(self.source, "cancel", None):
            cancel()
