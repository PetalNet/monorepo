"""Keep one call alive while its authenticated phone replaces a failed socket."""

import asyncio
import time

from websockets.exceptions import ConnectionClosed


class ResumableSocket:
    def __init__(self, socket, grace_s=25.0):
        self.socket = socket
        self.grace_s = grace_s
        self.ready = asyncio.Event()
        self.ready.set()
        self.closed = False
        self.generation = 0
        self.deadline = None
        self.error = None
        self.send_lock = asyncio.Lock()
        self.call = None
        self.ring = getattr(socket, "ring", None)

    @property
    def close_code(self):
        return self.socket.close_code

    @property
    def close_reason(self):
        return self.socket.close_reason

    def _lost(self, socket, error):
        if socket is not self.socket:
            return
        if socket.close_code == 1000 or self.closed:
            raise error
        if self.ready.is_set():
            self.deadline = time.monotonic() + self.grace_s
            self.error = error
            self.ready.clear()

    async def _wait(self):
        if not self.ready.is_set():
            try:
                await asyncio.wait_for(self.ready.wait(), max(0, self.deadline - time.monotonic()))
            except TimeoutError:
                raise self.error from None
        if self.closed:
            raise self.error or OSError("call ended")

    async def recv(self):
        while True:
            await self._wait()
            socket = self.socket
            try:
                message = await socket.recv()
                if socket is self.socket:
                    return message
            except ConnectionClosed as error:
                self._lost(socket, error)

    async def send(self, message):
        async with self.send_lock:
            while True:
                await self._wait()
                socket = self.socket
                try:
                    return await socket.send(message)
                except ConnectionClosed as error:
                    self._lost(socket, error)

    async def attach(self, socket, snapshot):
        if self.closed:
            await socket.close(1000, "call ended")
            return
        old = self.socket
        self.ready.clear()
        self.deadline = time.monotonic() + self.grace_s
        # Wake a sender waiting for recovery before acquiring its serialization lock.
        self.socket = socket
        self.generation += 1
        for message in snapshot:
            await socket.send(message)
        self.ready.set()
        await old.close(1012, "call resumed on another connection")

    async def close(self):
        self.closed = True
        self.ready.set()
        await self.socket.close()
