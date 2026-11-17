"""Client and session tests against a fake head that replays a stream recorded from the real head (fixtures/turn.sse)."""

import importlib.util
import sys
import types
import unittest
from pathlib import Path

from aiohttp import ClientSession, web
from aiohttp.test_utils import TestServer

PKG = Path(__file__).resolve().parent.parent / "custom_components" / "janet_conversation"
# Load head and session without importing the package __init__, which needs Home Assistant.
sys.modules["jc"] = types.ModuleType("jc")
sys.modules["jc"].__path__ = [str(PKG)]
for name in ("head", "session"):
    spec = importlib.util.spec_from_file_location(f"jc.{name}", PKG / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[f"jc.{name}"] = module
    spec.loader.exec_module(module)
from jc.head import Done, HeadClient, HeadError, Sentence  # noqa: E402
from jc.session import GUEST, PERSONAL, Sessions, surface_for, tier_for  # noqa: E402

FIXTURE = (Path(__file__).parent / "fixtures" / "turn.sse").read_bytes()
TOKEN = "t0ken"
OWNER = "owner-id"


class FakeHead:
    def __init__(self, end_phrase=False):
        self.opened, self.ended, self.turns = [], [], []
        self.turn_failures = []  # statuses to answer before the stream works
        self.end_phrase = end_phrase

    def app(self) -> web.Application:
        app = web.Application()
        app.router.add_post("/v1/conversations", self.open)
        app.router.add_post("/v1/conversations/{id}/turns", self.turn)
        app.router.add_post("/v1/conversations/{id}/end", self.end)
        return app

    def _auth(self, request):
        if request.headers.get("Authorization") != f"Bearer {TOKEN}":
            raise web.HTTPUnauthorized(text='{"error": "bearer token required"}', content_type="application/json")

    async def open(self, request):
        self._auth(request)
        body = await request.json()
        if not body.get("channel"):
            return web.json_response({"error": "channel is required"}, status=400)
        self.opened.append(body)
        return web.json_response({"id": f"c{len(self.opened)}"})

    async def turn(self, request):
        self._auth(request)
        self.turns.append((request.match_info["id"], (await request.json())["text"]))
        if self.turn_failures:
            return web.json_response({"error": "the conversation has ended"}, status=self.turn_failures.pop(0))
        body = FIXTURE.replace(b'"end_conversation": false', b'"end_conversation": true') if self.end_phrase else FIXTURE
        response = web.StreamResponse(headers={"content-type": "text/event-stream"})
        await response.prepare(request)
        for chunk in body.split(b"\n\n"):  # the head flushes event by event
            if chunk:
                await response.write(chunk + b"\n\n")
        return response

    async def end(self, request):
        self._auth(request)
        self.ended.append(request.match_info["id"])
        return web.json_response({"merged": True})


class Base(unittest.IsolatedAsyncioTestCase):
    end_phrase = False

    async def asyncSetUp(self):
        self.fake = FakeHead(self.end_phrase)
        self.server = TestServer(self.fake.app())
        await self.server.start_server()
        self.http = ClientSession()
        self.head = HeadClient(self.http, str(self.server.make_url("")), TOKEN)

    async def asyncTearDown(self):
        await self.http.close()
        await self.server.close()


class HeadClientTests(Base):
    async def test_recorded_stream_yields_sentences_then_done(self):
        items = [i async for i in self.head.turn("c1", "hi")]
        self.assertEqual([type(i) for i in items], [Sentence, Sentence, Done])
        self.assertTrue(items[0].text.startswith("You told me to leave them off voice"))
        self.assertEqual(items[2].latency_ms["first_sentence"], 6521)
        self.assertFalse(items[2].end_conversation)

    async def test_check_distinguishes_bad_token_from_good_without_opening_anything(self):
        await self.head.check()
        self.assertEqual(self.fake.opened, [])
        with self.assertRaises(HeadError) as caught:
            await HeadClient(self.http, str(self.server.make_url("")), "wrong").check()
        self.assertEqual(caught.exception.status, 401)

    async def test_error_before_the_stream_raises_with_status(self):
        self.fake.turn_failures = [409]
        with self.assertRaises(HeadError) as caught:
            [i async for i in self.head.turn("c1", "hi")]
        self.assertEqual(caught.exception.status, 409)


class SessionTests(Base):
    async def collect(self, sessions, ha_id="ha1", user=OWNER, device="Parker's S23", text="hi"):
        return [i async for i in sessions.turn(ha_id, user, device, text)]

    async def test_owner_gets_personal_everyone_else_guest_and_surface_is_tagged(self):
        sessions = Sessions(self.head, OWNER)
        await self.collect(sessions)
        await self.collect(sessions, ha_id="ha2", user="other-user", device=None)
        await self.collect(sessions, ha_id="ha3", user=None, device="Watch")
        self.assertEqual([(o["tier"], o["channel"]) for o in self.fake.opened], [
            (PERSONAL, "ha:parker-s-s23"), (GUEST, "ha:assist"), (GUEST, "ha:watch"),
        ])

    async def test_empty_owner_config_never_grants_personal(self):
        self.assertEqual(tier_for("", ""), GUEST)
        self.assertEqual(tier_for(None, ""), GUEST)
        self.assertEqual(surface_for("  "), "ha:assist")

    async def test_second_turn_reuses_the_head_conversation(self):
        sessions = Sessions(self.head, OWNER)
        await self.collect(sessions)
        await self.collect(sessions)
        self.assertEqual(len(self.fake.opened), 1)
        self.assertEqual([t[0] for t in self.fake.turns], ["c1", "c1"])

    async def test_a_head_conversation_that_timed_out_is_replaced_once(self):
        sessions = Sessions(self.head, OWNER)
        await self.collect(sessions)
        self.fake.turn_failures = [409]
        items = await self.collect(sessions)
        self.assertIsInstance(items[-1], Done)
        self.assertEqual([o["client_ref"] for o in self.fake.opened], ["ha1:0", "ha1:1"])

    async def test_a_second_failure_is_raised_not_looped(self):
        sessions = Sessions(self.head, OWNER)
        self.fake.turn_failures = [409, 409]
        with self.assertRaises(HeadError):
            await self.collect(sessions)

    async def test_user_change_mid_conversation_does_not_inherit_the_owner_tier(self):
        sessions = Sessions(self.head, OWNER)
        await self.collect(sessions)
        await self.collect(sessions, user="other-user")
        self.assertEqual([o["tier"] for o in self.fake.opened], [PERSONAL, GUEST])


class EndPhraseTests(Base):
    end_phrase = True

    async def test_end_phrase_ends_the_head_conversation_and_the_next_turn_starts_fresh(self):
        sessions = Sessions(self.head, OWNER)
        items = [i async for i in sessions.turn("ha1", OWNER, None, "that's all")]
        self.assertTrue(items[-1].end_conversation)
        self.assertEqual(self.fake.ended, ["c1"])
        [i async for i in sessions.turn("ha1", OWNER, None, "hello again")]
        self.assertEqual(len(self.fake.opened), 2)


if __name__ == "__main__":
    unittest.main()
