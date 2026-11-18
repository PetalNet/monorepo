import socket
import threading
import time
import unittest
from http.server import ThreadingHTTPServer

from janet_voice_head.server import HANDLER_TIMEOUT_S, Handler
from tests.harness import HeadCase


class RawRequestTest(HeadCase):
    def raw(self, request: bytes, wait: float = 5) -> bytes:
        with socket.create_connection(("127.0.0.1", self.port), timeout=wait) as sock:
            sock.sendall(request)
            data = b""
            try:
                while chunk := sock.recv(4096):
                    data += chunk
            except TimeoutError:
                self.fail("the server held the connection open")
            return data

    def post(self, headers: bytes, body: bytes = b"") -> bytes:
        return self.raw(b"POST /v1/conversations HTTP/1.1\r\nHost: x\r\n" + headers + b"\r\n" + body)

    def test_a_non_ascii_authorization_header_is_refused_not_a_dropped_connection(self):
        reply = self.post("Authorization: Bearer é☃\r\n".encode("utf-8"))
        self.assertIn(b" 401 ", reply.split(b"\r\n", 1)[0])
        self.assertEqual(self.request("GET", "/health")[0], 200)

    def test_a_negative_content_length_is_a_400(self):
        reply = self.post(f"Authorization: Bearer {self.token}\r\nContent-Length: -1\r\n".encode())
        self.assertIn(b" 400 ", reply.split(b"\r\n", 1)[0])

    def test_a_content_length_that_is_not_a_number_is_a_400(self):
        for value in (b"abc", b"1e3", b"\xd9\xa3"):
            reply = self.post(b"Authorization: Bearer " + self.token.encode() + b"\r\nContent-Length: " + value + b"\r\n")
            self.assertIn(b" 400 ", reply.split(b"\r\n", 1)[0], value)

    def test_a_body_larger_than_the_limit_is_a_413(self):
        reply = self.post(f"Authorization: Bearer {self.token}\r\nContent-Length: 99999999\r\n".encode())
        self.assertIn(b" 413 ", reply.split(b"\r\n", 1)[0])


class HandlerTimeoutTest(unittest.TestCase):
    def test_a_client_that_stops_sending_is_dropped(self):
        handler = type("Quick", (Handler,), {"head": None, "token": "t", "timeout": 0.5})
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        with socket.create_connection(("127.0.0.1", server.server_port), timeout=5) as sock:
            sock.sendall(b"POST /v1/conversations HTTP/1.1\r\nAuthorization: Bearer t\r\nContent-Length: 50\r\n\r\nabc")
            started = time.monotonic()
            self.assertEqual(sock.recv(4096), b"")
            self.assertLess(time.monotonic() - started, 4)

    def test_the_shipped_handler_has_a_timeout(self):
        self.assertTrue(0 < HANDLER_TIMEOUT_S <= 60)
        self.assertEqual(Handler.timeout, HANDLER_TIMEOUT_S)


if __name__ == "__main__":
    unittest.main()
