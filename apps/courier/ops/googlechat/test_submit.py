import io
import json
from pathlib import Path
import unittest

from import_curl import CaptureError
from submit_capture import ACCOUNT, submit


CAPTURE = (Path(__file__).parent / "fixtures/firefox-fake.curl").read_text()
CONFIG = {"appservice": {"address": "http://127.29.3.20:41355"},
          "bridge": {"provisioning": {"prefix": "/_matrix/provision", "shared_secret": "FAKE"}}}


class SubmitTests(unittest.TestCase):
    def responses(self, values):
        calls = []

        def opener(req, timeout):
            calls.append(req)
            return io.BytesIO(json.dumps(values.pop(0)).encode())

        return calls, opener

    def test_expired_capture_stops_after_one_attempt(self):
        calls, opener = self.responses([{"googlechat": None}, {"status": "fail", "error": "FAKE-SECRET"}])
        with self.assertRaises(CaptureError) as caught:
            submit(CAPTURE, CONFIG, opener)
        self.assertEqual(len(calls), 2)
        self.assertNotIn("FAKE", str(caught.exception))

    def test_success_verifies_account_and_passes_rotation_cookie(self):
        calls, opener = self.responses([{"googlechat": None}, {"status": "success", "email": ACCOUNT},
                                        {"googlechat": {"connected": True, "email": ACCOUNT}}])
        result = submit(CAPTURE, CONFIG, opener)
        self.assertEqual(result, {"account_verified": True, "login_attempted": True, "connected": True})
        self.assertEqual(json.loads(calls[1].data)["cookies"]["secure_1psidts"], "FAKE-OLD")

    def test_wrong_account_is_removed(self):
        calls, opener = self.responses([{"googlechat": None}, {"status": "success", "email": "other@example.invalid"}, {}])
        with self.assertRaises(CaptureError):
            submit(CAPTURE, CONFIG, opener)
        self.assertIn("/v1/logout?", calls[-1].full_url)

    def test_existing_login_is_not_replaced(self):
        calls, opener = self.responses([{"googlechat": {"email": ACCOUNT, "connected": True}}])
        self.assertFalse(submit(CAPTURE, CONFIG, opener)["login_attempted"])
        self.assertEqual(len(calls), 1)

    def test_nonlocal_endpoint_is_rejected_before_request(self):
        with self.assertRaises(CaptureError):
            submit(CAPTURE, {**CONFIG, "appservice": {"address": "http://evil.invalid"}},
                   lambda *args, **kwargs: self.fail("network called"))


if __name__ == "__main__":
    unittest.main()
