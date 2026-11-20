import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from watcher import apply_mappings, database, deliver, now, reconcile, report, rule_check, vendor_advisories


AT = "2026-11-20T18:00:00+00:00"


def inventory(version="21.0.12", flags=None):
    return {"collected_at": AT, "assets": [{
        "id": "mc:java", "host": "mc", "service": "minecraft", "product": "openjdk",
        "version": version, "cpu_flags": flags, "mitigations": [], "exposure": "internet",
        "evidence": ["running JVM"], "owner": "lab",
    }], "gaps": []}


RULE = {"id": "CVE-2026-114938", "products": ["openjdk"], "introduced": "17.0.6",
        "cpu_flags": ["avx512vbmi"], "fixed_by_major": {"21": "21.0.13.1"},
        "mitigations": ["-XX:-UseBASE64Intrinsics", "-XX:UseAVX=2"],
        "severity": "critical", "fix": "Install fixed JVM or disable Base64 intrinsic"}


def ingestion(inv):
    return {"advisories": vendor_advisories(inv, [RULE]), "gaps": [], "stats": {"vendor": 1}}


class CoverageTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.db = database(Path(self.directory.name) / "coverage.sqlite")

    def tearDown(self):
        self.db.close()
        self.directory.cleanup()

    def test_lifecycle_restarts_deduplicates_closes_and_reopens(self):
        inv = inventory(flags=["avx512vbmi"])
        reconcile(self.db, inv, ingestion(inv), AT)
        self.db.close()
        self.db = database(Path(self.directory.name) / "coverage.sqlite")
        reconcile(self.db, inv, ingestion(inv), AT)
        self.assertEqual(len(report(self.db)["receipts"]), 2)  # one finding and daily digest
        fixed = inventory("21.0.13.1", ["avx512vbmi"])
        result = reconcile(self.db, fixed, ingestion(fixed), AT)
        self.assertEqual((result["closed"], result["open"]), (1, 0))
        reconcile(self.db, inv, ingestion(inv), AT)
        self.assertEqual(report(self.db)["items"][0]["generation"], 2)
        self.assertEqual(len(report(self.db)["receipts"]), 4)

    def test_missing_asset_or_feed_cannot_close(self):
        inv = inventory(flags=["avx512vbmi"])
        reconcile(self.db, inv, ingestion(inv), AT)
        result = reconcile(self.db, {"collected_at": AT, "assets": [], "gaps": ["SSH failed"]},
                           {"advisories": [], "gaps": ["feed failed"]}, AT)
        self.assertEqual(result["open"], 1)
        self.assertTrue(any("remains open" in str(g) for g in result["gaps"]))

    def test_stale_inventory_cannot_open_or_close(self):
        inv = inventory(flags=["avx512vbmi"])
        reconcile(self.db, inv, ingestion(inv), AT)
        fixed = inventory("21.0.13.1", ["avx512vbmi"])
        result = reconcile(self.db, fixed, ingestion(fixed), "2026-11-23T18:00:00+00:00")
        self.assertEqual(result["closed"], 0)
        self.assertEqual(result["open"], 1)

    def test_stale_asset_in_fresh_snapshot_cannot_close(self):
        inv = inventory(flags=["avx512vbmi"])
        reconcile(self.db, inv, ingestion(inv), AT)
        inv["assets"][0].update(version="21.0.13.1", observed_at="2020-01-01T00:00:00+00:00")
        self.assertEqual(reconcile(self.db, inv, ingestion(inv), AT)["open"], 1)

    def test_osv_tracking_survives_replacement_by_unknown_advisory(self):
        inv = inventory(flags=["avx512vbmi"])
        original = ingestion(inv)
        original["advisories"][0]["osv_bindings"] = [dict(asset_id="mc:java", ecosystem="PyPI", name="widget")]
        reconcile(self.db, inv, original, AT)
        replacement = ingestion(inv)
        replacement["advisories"][0]["affected"] = [dict(asset_id="mc:java", verdict="unknown", evidence="feed failed")]
        reconcile(self.db, inv, replacement, AT)
        self.assertEqual(1, self.db.execute("SELECT count(*) FROM osv_tracking").fetchone()[0])

    def test_mapping_uses_current_observed_version(self):
        config = {"product_mappings": [{"match": {"product": "openjdk"},
            "package_identities": [{"ecosystem": "Maven", "name": "example:runtime"}]}]}
        inv = inventory("21.0.13.1")
        apply_mappings(inv, config)
        self.assertEqual("21.0.13.1", inv["assets"][0]["packages"][0]["version"])

    def test_jvm_arguments_need_effective_runtime_verification(self):
        a = inventory(flags=["avx512vbmi"])["assets"][0]
        rule = dict(RULE, require_runtime_flags=True)
        a['mitigations'] = ['-XX:UseAVX=2']
        self.assertEqual('unknown', rule_check(a, rule)[0])
        a['runtime_flags_verified'] = True
        self.assertEqual('unaffected', rule_check(a, rule)[0])

    def test_cli_replay_files_and_delivery_are_isolated(self):
        root = Path(self.directory.name)
        config = root / 'config.json'
        config.write_text(json.dumps({'state_dir': str(root / 'state'), 'poster': {
            'room_id': '!replay:example.org', 'command': [sys.executable, '-c',
                'print(\'{"event_id":"$replay"}\')']}}))
        inv = inventory(flags=['avx512vbmi'])
        inv['collected_at'] = now()
        inventory_path = root / 'input.json'
        advisory_path = root / 'advisories.json'
        inventory_path.write_text(json.dumps(inv))
        advisory_path.write_text(json.dumps(ingestion(inv)))
        cli = [sys.executable, str(Path(__file__).with_name('watcher.py'))]
        subprocess.run([*cli, 'replay', '--config', str(config), '--inventory', str(inventory_path),
                        '--advisories', str(advisory_path)], check=True, capture_output=True)
        self.assertFalse((root / 'state/inventory.json').exists())
        self.assertTrue((root / 'state/replay/inventory.json').exists())
        result = subprocess.run([*cli, 'deliver', '--config', str(config), '--replay-state'],
                                check=True, capture_output=True, text=True)
        self.assertEqual(2, len(json.loads(result.stdout)['receipts']))
        self.assertFalse((root / 'state/coverage.sqlite').exists())
        invalid = subprocess.run([*cli, 'run', '--config', str(config), '--replay-state'], capture_output=True)
        self.assertEqual(2, invalid.returncode)

    def test_unknown_cpu_is_unresolved_and_known_absence_filters(self):
        inv = inventory()
        result = reconcile(self.db, inv, ingestion(inv), AT)
        self.assertEqual((result["opened"], result["unknown"]), (0, 1))
        inv = inventory(flags=["avx2"])
        result = reconcile(self.db, inv, ingestion(inv), AT)
        self.assertEqual((result["opened"], result["filtered"]), (0, 1))

    def test_mitigation_is_checked_and_removed_flag_reopens(self):
        inv = inventory(flags=["avx512vbmi"])
        reconcile(self.db, inv, ingestion(inv), AT)
        inv["assets"][0]["mitigations"] = ["-XX:UseAVX=2"]
        self.assertEqual(reconcile(self.db, inv, ingestion(inv), AT)["closed"], 1)
        inv["assets"][0]["mitigations"] = []
        self.assertEqual(reconcile(self.db, inv, ingestion(inv), AT)["opened"], 1)

    def test_aliases_collapse_into_one_item_and_conflicts_stay_unresolved(self):
        inv = inventory(flags=["avx512vbmi"])
        first = ingestion(inv)
        first["advisories"][0]["aliases"] = ["GHSA-aaaa-bbbb-cccc"]
        reconcile(self.db, inv, first, AT)
        second = ingestion(inv)
        second["advisories"][0]["id"] = "GHSA-aaaa-bbbb-cccc"
        second["advisories"][0]["aliases"] = [RULE["id"]]
        second["advisories"][0]["affected"][0]["verdict"] = "unaffected"
        combined = {"advisories": first["advisories"] + second["advisories"]}
        result = reconcile(self.db, inv, combined, AT)
        self.assertEqual((result["closed"], result["unknown"], len(report(self.db)["items"])), (0, 1, 1))

    def test_delivery_failure_is_durable_and_retry_uses_identical_transaction(self):
        inv = inventory(flags=["avx512vbmi"])
        reconcile(self.db, inv, ingestion(inv), AT)
        poster = {"room_id": "!vulns:example.org", "command": ["poster"]}
        payloads = []

        def send(*args, **kwargs):
            payloads.append(json.loads(kwargs["input"]))
            if len(payloads) == 1:
                raise subprocess.TimeoutExpired("poster", 60)
            return subprocess.CompletedProcess(args[0], 0, '{"event_id":"$accepted"}')

        with patch("watcher.subprocess.run", side_effect=send):
            with self.assertRaises(subprocess.TimeoutExpired):
                deliver(self.db, poster)
            self.assertTrue(all(r["event_id"] is None for r in report(self.db)["receipts"]))
            deliver(self.db, poster)
        self.assertEqual(payloads[0], payloads[1])
        self.assertTrue(all(r["event_id"] == "$accepted" for r in report(self.db)["receipts"]))

    def test_no_receipt_does_not_mark_delivery(self):
        inv = inventory(flags=["avx512vbmi"])
        reconcile(self.db, inv, ingestion(inv), AT)
        with patch("watcher.subprocess.run", return_value=subprocess.CompletedProcess([], 0, '{}')):
            with self.assertRaises(ValueError):
                deliver(self.db, {"room_id": "!test:example.org", "command": ["poster"]})
        self.assertTrue(all(r["event_id"] is None for r in report(self.db)["receipts"]))


if __name__ == "__main__":
    unittest.main()
