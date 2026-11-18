"""Signing in from the app: the real pairing listener against a fake single-sign-on provider."""

import base64
import hashlib
import http.client
import json
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).parent.parent))
import pairing  # noqa: E402

VERIFIER = "v" * 43
CHALLENGE = base64.urlsafe_b64encode(hashlib.sha256(VERIFIER.encode()).digest()).decode().rstrip("=")
STATE = "s" * 22


class FakeSso(BaseHTTPRequestHandler):
    """Hands out an access token for a code it issued, once, when the verifier fits the challenge."""

    codes: dict[str, tuple[str, str]] = {}  # code -> (challenge, username)
    sessions: dict[str, dict] = {}  # access token -> what userinfo answers
    seen: list[dict] = []

    def log_message(self, *args):
        pass

    def _answer(self, status: int, body) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        form = {k: v[0] for k, v in parse_qs(self.rfile.read(int(self.headers["content-length"])).decode()).items()}
        FakeSso.seen.append(form)
        challenge, username = FakeSso.codes.pop(form.get("code", ""), ("", ""))
        fits = base64.urlsafe_b64encode(hashlib.sha256(form.get("code_verifier", "").encode()).digest()).decode().rstrip("=")
        if not username or fits != challenge or form.get("client_id") != "janet-call":
            return self._answer(400, {"error": "invalid_grant"})
        FakeSso.sessions.setdefault("access-" + username, {"preferred_username": username})
        self._answer(200, {"access_token": "access-" + username})

    def do_GET(self):
        who = FakeSso.sessions.get(pairing.bearer(self.headers.get("Authorization")))
        self._answer(401, {}) if who is None else self._answer(200, who)


class SignInTest(unittest.TestCase):
    def setUp(self):
        FakeSso.codes, FakeSso.sessions, FakeSso.seen = {}, {}, []
        self.sso = ThreadingHTTPServer(("127.0.0.1", 0), FakeSso)
        threading.Thread(target=self.sso.serve_forever, daemon=True).start()
        self.addCleanup(self.sso.server_close)
        self.addCleanup(self.sso.shutdown)
        self.dir = Path(tempfile.mkdtemp())
        (self.dir / "access.json").write_text('{"client_id": "id.access", "client_secret": "s3cret"}')
        self.devices = pairing.Devices(self.dir / "devices.json")
        self.announced = []
        self.bridge = self._bridge(self._signin())

    def _signin(self, port: int | None = None) -> pairing.SignIn:
        at = f"http://127.0.0.1:{port or self.sso.server_port}"
        return pairing.SignIn(authorize_url="https://sso.example/authorize", token_url=at + "/token",
                              userinfo_url=at + "/userinfo", client_id="janet-call", redirect_uri="janetcall://signin")

    def _bridge(self, signin: pairing.SignIn | None) -> int:
        server = pairing.serve("127.0.0.1:0", self.devices, pairing.Codes(300), url="wss://bridge.example/v1/call",
                               access_file=str(self.dir / "access.json"), users=["parker"],
                               proxy_secret_file=str(self.dir / "none"), signin=signin,
                               on_paired=lambda name, by: self.announced.append((name, by)))
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server.server_port

    def _http(self, method: str, path: str, body: dict | None = None, headers: dict | None = None, port: int | None = None):
        connection = http.client.HTTPConnection("127.0.0.1", port or self.bridge, timeout=10)
        connection.request(method, path, None if body is None else json.dumps(body), headers or {})
        response = connection.getresponse()
        answer = response.status, response.read().decode(), response.getheader("location")
        connection.close()
        return answer

    def _signed_in(self, username: str, code: str = "from-sso") -> dict:
        FakeSso.codes[code] = (CHALLENGE, username)
        return {"code": code, "verifier": VERIFIER, "name": "Galaxy S23"}

    def test_the_sign_in_address_sends_the_browser_to_single_sign_on_with_the_phones_challenge(self):
        status, _, location = self._http("GET", f"/v1/call/pair/signin?challenge={CHALLENGE}&state={STATE}")
        self.assertEqual(status, 302)
        self.assertEqual(location.split("?")[0], "https://sso.example/authorize")
        self.assertEqual({k: v[0] for k, v in parse_qs(urlsplit(location).query).items()}, {
            "response_type": "code", "client_id": "janet-call", "redirect_uri": "janetcall://signin",
            "scope": "openid profile", "code_challenge": CHALLENGE, "code_challenge_method": "S256", "state": STATE})
        for query in ("", f"?challenge={CHALLENGE}", f"?challenge=short&state={STATE}", f"?challenge={CHALLENGE}&state=a%0d%0ab"):
            self.assertEqual(self._http("GET", "/v1/call/pair/signin" + query)[0], 404, query)

    def test_the_owners_sign_in_pairs_the_phone_once(self):
        signed_in = self._signed_in("parker")
        status, body, _ = self._http("POST", "/v1/call/pair/signin", signed_in)
        self.assertEqual(status, 200)
        self.assertEqual(sorted(json.loads(body)), ["cf_id", "cf_secret", "token"])
        self.assertEqual((json.loads(body)["cf_id"], json.loads(body)["cf_secret"]), ("id.access", "s3cret"))
        self.assertEqual(self.devices.name_of(json.loads(body)["token"]), "Galaxy S23")
        self.assertEqual(self.announced, [("Galaxy S23", "parker")])
        self.assertEqual(FakeSso.seen[0]["redirect_uri"], "janetcall://signin")
        status, body, _ = self._http("POST", "/v1/call/pair/signin", signed_in)
        self.assertEqual((status, sorted(json.loads(body))), (403, ["error"]))
        self.assertEqual(len(self.devices.listing()), 1)

    def test_another_accounts_sign_in_pairs_nothing(self):
        status, body, _ = self._http("POST", "/v1/call/pair/signin", self._signed_in("someone-else"))
        self.assertEqual((status, sorted(json.loads(body))), (403, ["error"]))
        self.assertEqual((self.devices.listing(), self.announced), ([], []))

    def test_a_code_without_its_verifier_pairs_nothing(self):
        refused = [
            {**self._signed_in("parker"), "verifier": "w" * 43},
            {"code": "guess", "verifier": VERIFIER},
            {"code": "", "verifier": VERIFIER},
            {"code": "from-sso"},
            {},
        ]
        for body in refused:
            self.assertEqual(self._http("POST", "/v1/call/pair/signin", body)[0], 403, body)
        self.assertEqual(self.devices.listing(), [])
        # Only the first two were worth asking single sign-on about.
        self.assertEqual(len(FakeSso.seen), 2)

    def test_a_userinfo_answer_without_a_username_pairs_nothing(self):
        FakeSso.sessions["access-parker"] = {"sub": "abc"}
        self.assertEqual(self._http("POST", "/v1/call/pair/signin", self._signed_in("parker"))[0], 403)
        self.assertEqual(self.devices.listing(), [])

    def test_single_sign_on_out_of_reach_is_not_a_refusal(self):
        self.sso.shutdown()
        self.sso.server_close()
        self.assertEqual(self._http("POST", "/v1/call/pair/signin", self._signed_in("parker"))[0], 503)
        self.assertEqual(self.devices.listing(), [])

    def test_an_unusable_access_file_refuses_before_the_code_is_spent(self):
        signed_in = self._signed_in("parker")
        (self.dir / "access.json").write_text("not json")
        self.assertEqual(self._http("POST", "/v1/call/pair/signin", signed_in)[0], 503)
        (self.dir / "access.json").write_text('{"client_id": "id.access", "client_secret": "s3cret"}')
        self.assertEqual(self._http("POST", "/v1/call/pair/signin", signed_in)[0], 200)

    def test_sign_in_attempts_count_against_the_pairing_limit(self):
        one = {"Cf-Connecting-Ip": "203.0.113.9"}
        answers = [self._http("POST", "/v1/call/pair/signin", {}, one)[0] for _ in range(6)]
        answers += [self._http("POST", "/v1/call/pair", {"code": "guess"}, one)[0] for _ in range(6)]
        self.assertEqual(answers, [403] * 10 + [429] * 2)

    def test_a_bridge_without_sign_in_has_no_sign_in_address(self):
        plain = self._bridge(None)
        self.assertEqual(self._http("GET", f"/v1/call/pair/signin?challenge={CHALLENGE}&state={STATE}", port=plain)[0], 404)
        self.assertEqual(self._http("POST", "/v1/call/pair/signin", self._signed_in("parker"), port=plain)[0], 404)
        self.assertEqual(self.devices.listing(), [])


if __name__ == "__main__":
    unittest.main()
