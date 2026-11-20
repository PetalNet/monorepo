import unittest

from shawn_poster import post


class PosterTests(unittest.TestCase):
    def setUp(self):
        self.room = "!vulns:mx.petalcat.dev"
        self.payload = {"room_id": self.room, "transaction_id": "a" * 64, "body": "CVE match"}
        self.account = {"user_id": "@shawn:mx.petalcat.dev"}

    def test_encrypted_room_is_rejected(self):
        def api(path):
            return {"user_id": self.account["user_id"]} if path == "/account/whoami" else [{"type": "m.room.encryption"}]
        with self.assertRaises(ValueError):
            post(self.payload, self.room, self.account, api)

    def test_different_room_and_identity_are_rejected(self):
        with self.assertRaises(ValueError):
            post(self.payload, "!system:mx.petalcat.dev", self.account)
        with self.assertRaises(ValueError):
            post(self.payload, self.room, {"user_id": "@janet:mx.petalcat.dev"})

    def test_retry_uses_same_matrix_put_transaction(self):
        calls = []

        def api(path, method="GET", body=None):
            if path == "/account/whoami":
                return {"user_id": self.account["user_id"]}
            if path.endswith("/state"):
                return []
            calls.append((path, method, body))
            return {"event_id": "$event"}

        for _ in range(2):
            self.assertEqual(post(self.payload, self.room, self.account, api)["event_id"], "$event")
        self.assertEqual(calls[0], calls[1])
        self.assertEqual(calls[0][1], "PUT")


if __name__ == "__main__":
    unittest.main()
