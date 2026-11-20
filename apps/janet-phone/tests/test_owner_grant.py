"""Local owner grants preserve the existing token and leave other pairings alone."""

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
import pairing


class OwnerGrantTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "devices.json"
        self.devices = pairing.Devices(self.path)
        self.owner = self.devices.add("Owner phone", "parker")
        self.shared = self.devices.add("Shared link", "parker")
        self.guest = self.devices.add("Guest phone", "guest")
        self.ident = hashlib.sha256(self.owner.encode()).hexdigest()[:12]

    def test_grant_survives_reload_without_changing_other_devices_or_pairing_history(self):
        before = json.loads(self.path.read_text())
        self.assertIsNone(self.devices.owner_of(self.owner))
        self.assertEqual(self.devices.verify_owner(self.ident, "parker", "Owner confirmed this phone"), "Owner phone")
        fresh = pairing.Devices(self.path)
        self.assertEqual(fresh.owner_of(self.owner), "parker")
        self.assertEqual(fresh.name_of(self.owner), "Owner phone")
        self.assertIsNone(fresh.owner_of(self.shared))
        self.assertIsNone(fresh.owner_of(self.guest))
        after = json.loads(self.path.read_text())
        key = hashlib.sha256(self.owner.encode()).hexdigest()
        grant = after[key].pop("owner_grants")
        self.assertEqual(len(grant), 1)
        self.assertEqual(grant[0]["authority"], "local-admin")
        self.assertEqual(grant[0]["owner"], "parker")
        self.assertEqual(grant[0]["reason"], "Owner confirmed this phone")
        self.assertRegex(grant[0]["at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        before[key]["identity_verified"] = True
        self.assertEqual(after, before)
        saved = self.path.read_bytes()
        fresh.verify_owner(self.ident, "parker", "Retry")
        self.assertEqual(self.path.read_bytes(), saved)

    def test_invalid_or_ambiguous_grants_leave_store_unchanged(self):
        guest_id = hashlib.sha256(self.guest.encode()).hexdigest()[:12]
        for ident, owner, reason in [("", "parker", "why"), (self.ident[:8], "parker", "why"),
                                     ("f" * 64, "parker", "why"), (self.ident, "", "why"),
                                     (self.ident, "parker", "  "), (guest_id, "parker", "why")]:
            before = self.path.read_bytes()
            with self.assertRaises(ValueError):
                self.devices.verify_owner(ident, owner, reason)
            self.assertEqual(self.path.read_bytes(), before)
        data = json.loads(self.path.read_text())
        data[self.ident + "0" * 52] = {"name": "Collision", "paired_by": "parker"}
        self.path.write_text(json.dumps(data))
        before = self.path.read_bytes()
        with self.assertRaises(ValueError):
            self.devices.verify_owner(self.ident, "parker", "why")
        self.assertEqual(self.path.read_bytes(), before)

    def test_cli_grant_and_refusals(self):
        config = Path(self.tmp.name) / "phone.toml"
        config.write_text(f'devices_file = "{self.path}"\nlab_owner = "parker"\n'
                          'listen = "127.0.0.1:0"\ngateway = "http://unused"\nstt = "unused:0"\n'
                          'tier = "personal"\nchannel = "desk-test"\ndisclosure = ""\n')
        cli = [sys.executable, str(Path(pairing.__file__).with_name("janet_phone.py")), "--config", str(config)]
        before = self.path.read_bytes()
        for args in [("--verify-owner", self.ident), ("--reason", "why"),
                     ("--verify-owner", "", "--reason", ""),
                     ("--verify-owner", self.ident, "--reason", "  "),
                     ("--verify-owner", self.ident, "--reason", "why", "--devices"),
                     ("--verify-owner", "f" * 64, "--reason", "why")]:
            result = subprocess.run(cli + list(args), capture_output=True, text=True)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertEqual(self.path.read_bytes(), before)
        result = subprocess.run(cli + ["--verify-owner", self.ident, "--reason", "Known phone"],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.devices.owner_of(self.owner), "parker")
        self.assertIn(self.ident, result.stdout)
        self.assertNotIn(self.owner, result.stdout)

    def test_revocation_keeps_audit_and_refuses_access_and_regrant(self):
        self.devices.verify_owner(self.ident, "parker", "Known phone")
        key = hashlib.sha256(self.owner.encode()).hexdigest()
        audit = json.loads(self.path.read_text())[key]["owner_grants"]
        self.assertEqual(self.devices.revoke(self.ident), "Owner phone")
        fresh = pairing.Devices(self.path)
        self.assertIsNone(fresh.name_of(self.owner))
        self.assertIsNone(fresh.owner_of(self.owner))
        self.assertNotIn(self.ident, [ident for ident, _ in fresh.listing()])
        self.assertEqual(json.loads(self.path.read_text())[key]["owner_grants"], audit)
        before = self.path.read_bytes()
        self.assertIsNone(fresh.revoke(self.ident))
        with self.assertRaises(ValueError):
            fresh.verify_owner(self.ident, "parker", "Retry")
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(fresh.name_of(self.shared), "Shared link")


if __name__ == "__main__":
    unittest.main()
