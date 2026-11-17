import unittest

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestServer

from janet_desk.head import Done, HeadClient, Sentence

TOKEN = "test-token"


class HeadClientTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.requests: list[tuple[str, dict]] = []

        async def record(request: web.Request) -> dict:
            if request.headers.get("Authorization") != f"Bearer {TOKEN}":
                raise web.HTTPUnauthorized
            body = await request.json()
            self.requests.append((request.path, body))
            return body

        async def open_conversation(request: web.Request) -> web.Response:
            await record(request)
            return web.json_response({"id": "c7"})

        async def turn(request: web.Request) -> web.StreamResponse:
            await record(request)
            response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
            await response.prepare(request)
            await response.write(b'event: sentence\ndata: {"text": "It is nine."}\n\n')
            await response.write(b'event: sentence\ndata: {"text": "Anything else?"}\n\n')
            await response.write(b'event: done\ndata: {"end_conversation": true, "latency_ms": {"total": 900}}\n\n')
            return response

        async def acknowledge(request: web.Request) -> web.Response:
            await record(request)
            return web.json_response({})

        app = web.Application()
        app.add_routes(
            [
                web.post("/v1/conversations", open_conversation),
                web.post("/v1/conversations/{id}/turns", turn),
                web.post("/v1/conversations/{id}/interrupt", acknowledge),
                web.post("/v1/conversations/{id}/end", acknowledge),
            ]
        )
        server = TestServer(app)
        await server.start_server()
        self.addAsyncCleanup(server.close)
        session = aiohttp.ClientSession()
        self.addAsyncCleanup(session.close)
        self.url = str(server.make_url(""))
        self.head = HeadClient(session, self.url, TOKEN, channel="desk")
        self.session = session

    async def test_a_turn_streams_sentences_then_the_end_of_conversation_flag(self):
        conversation = await self.head.open("personal")
        parts = [part async for part in self.head.turn(conversation, "what time is it")]

        self.assertEqual(conversation, "c7")
        self.assertEqual(parts, [Sentence("It is nine."), Sentence("Anything else?"), Done(end_conversation=True)])
        self.assertEqual(
            self.requests,
            [
                ("/v1/conversations", {"channel": "desk", "tier": "personal"}),
                ("/v1/conversations/c7/turns", {"text": "what time is it"}),
            ],
        )

    async def test_interrupt_reports_what_was_heard_and_end_gives_the_reason(self):
        await self.head.interrupt("c7", "It is")
        await self.head.end("c7", "silence")

        self.assertEqual(
            self.requests,
            [
                ("/v1/conversations/c7/interrupt", {"heard_text": "It is"}),
                ("/v1/conversations/c7/end", {"reason": "silence"}),
            ],
        )

    async def test_a_wrong_token_is_an_error(self):
        stranger = HeadClient(self.session, self.url, "wrong", channel="desk")

        with self.assertRaises(aiohttp.ClientResponseError):
            await stranger.open("personal")


if __name__ == "__main__":
    unittest.main()
