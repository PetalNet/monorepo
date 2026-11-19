import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import zipfile

import pull_evidence as evidence


DATE = "2026-11-19T00:00:00Z"
CATALOG = {"gpt-6-astra", "claude-opus-5-5", "gemini-4-neon"}


class FixtureCache:
    def __init__(self, *responses):
        self.responses = iter(responses)
        self.urls = []

    def get(self, url, token=None):
        self.urls.append(url)
        response = next(self.responses)
        return response if isinstance(response, tuple) else (json.dumps(response).encode(), DATE)


def arena_page(names, total):
    return {
        "num_rows_total": total,
        "rows": [{"row": {"model_name": name, "rating": 1300,
                           "category": "overall", "leaderboard_publish_date": DATE},
                  "truncated_cells": []} for name in names],
    }


class PullerTests(unittest.TestCase):
    def test_exact_releases_and_efforts_without_preview_or_generation_guessing(self):
        for name, expected in [
            ("GPT-6 Astra (Max)", ("gpt-6-astra", "max")),
            ("openai/gpt-6-astra_high", ("gpt-6-astra", "high")),
            ("openai/gpt-6-astra_none", ("gpt-6-astra", "none")),
            ("Claude Opus 5.5", ("claude-opus-5-5", "unspecified")),
            ("Gemini 4 Neon (High)", ("gemini-4-neon", "high")),
            ("Claude Opus 4.6", None),
            ("GPT-6 Astra Preview", None),
            ("GPT-6 Astra (Thinking)", None),
            ("GPT-6 Astra (High, 32K)", None),
            ("GPT-6 Astra (Codex Harness)", None),
        ]:
            with self.subTest(name=name):
                self.assertEqual(evidence.model_key(name, CATALOG), expected)
        self.assertEqual(evidence.catalog_ids({"models": [{"id": "opus"},
                                                          {"id": "gemini-4-neon-high"}]}),
                         {"claude-opus-5-5", "gemini-4-neon"})

    def test_arena_pagination_provenance_unmapped_and_zero_scores(self):
        cache = FixtureCache(arena_page(["GPT-6 Astra (Max)"], 2),
                             arena_page(["GPT-6 Astra Preview"], 2))
        rows = evidence.Rows(CATALOG)
        evidence.arena(cache, rows, "webdev", "overall", "arena_webdev")
        self.assertEqual(len(rows.rows), 1)
        self.assertIn("offset=1", cache.urls[1])
        self.assertEqual(rows.unmapped, {"Arena: GPT-6 Astra Preview"})
        self.assertEqual(rows.rows[0]["effort"], "max")
        self.assertEqual(rows.rows[0]["halfLifeDays"], 90)
        self.assertEqual(rows.rows[0]["reporter"], "Arena")
        self.assertEqual(rows.rows[0]["asof"], DATE)
        rows.add("GPT-6 Astra", 0, "arena_text", "Arena", DATE, "https://example.test")
        self.assertEqual(rows.rows[-1]["value"], 0)

    def test_arena_incomplete_pages_fail_instead_of_committing_partial_source(self):
        rows = evidence.Rows(CATALOG)
        with self.assertRaises(ValueError):
            evidence.arena(FixtureCache(arena_page([], 1)), rows, "webdev", "overall", "x")
        page = arena_page(["GPT-6 Astra"], 1)
        page["rows"][0]["truncated_cells"] = ["model_name"]
        with self.assertRaises(ValueError):
            evidence.arena(FixtureCache(page), rows, "webdev", "overall", "x")

    def test_eq_csv_and_json_literals_are_data_not_executed_javascript(self):
        rows = evidence.Rows(CATALOG)
        creative = b'let leaderboardDataCreativeWritingV3 = `model_name,elo_score\n"GPT-6 Astra",1350\n`; throw Error("do not execute");'
        evidence.eq_creative(FixtureCache((creative, DATE)), rows)
        four = b'const EQBENCH4_DATA = {"generated_at":"2026-11-18","models":[{"model":"Claude Opus 5.5","elo":1400}]}; throw Error("do not execute");'
        evidence.eq_four(FixtureCache((four, DATE)), rows)
        self.assertEqual([r["signal"] for r in rows.rows], ["eqbench_creative_v3", "eqbench4"])
        self.assertEqual([r["effort"] for r in rows.rows], ["unspecified", "unspecified"])
        self.assertEqual(rows.rows[1]["asof"], "2026-11-18")
        with self.assertRaises(ValueError):
            evidence.eq_creative(FixtureCache((creative.replace(b"1350", b"${danger()}"), DATE)), rows)

    def test_design_requires_key_and_uses_only_official_website_api(self):
        rows = evidence.Rows(CATALOG)
        with patch.dict(os.environ, {}, clear=True), self.assertRaises(PermissionError):
            evidence.design(FixtureCache(), rows)
        cache = FixtureCache({"success": True, "data": [{"displayName": "GPT-6 Astra", "elo": 1300}],
                              "meta": {"arena": "models", "category": "website", "lastUpdated": DATE}})
        with patch.dict(os.environ, {"DESIGNARENA_API_KEY": "test-credential"}):
            evidence.design(cache, rows)
        self.assertEqual(cache.urls, ["https://www.designarena.ai/api/v1/leaderboard/models/website"])
        self.assertEqual(rows.rows[0]["halfLifeDays"], 90)
        self.assertNotIn("test-credential", json.dumps(rows.rows))

    def test_epoch_zip_uses_run_date_and_separate_code_reasoning_cross_checks(self):
        data = io.BytesIO()
        with zipfile.ZipFile(data, "w") as archive:
            for name in ["gpqa_diamond", "mirrorcode", "swe_bench_verified"]:
                archive.writestr(name + ".csv", "Model version,mean_score,Started at\ngpt-6-astra_max,0.8,2026-11-01\n")
        rows = evidence.Rows(CATALOG)
        evidence.epoch(FixtureCache((data.getvalue(), DATE)), rows)
        self.assertEqual({r["signal"] for r in rows.rows}, {"epoch_gpqa", "epoch_mirrorcode", "epoch_swe_verified"})
        self.assertTrue(all(r["halfLifeDays"] == 180 and r["asof"] == "2026-11-01" for r in rows.rows))

    def test_cyber_keeps_vendor_provenance_and_filters_mismatched_trials(self):
        records = [{"model": "GPT-6 Astra", "score_10": 0.5, "date": DATE,
                    "source": "Example lab", "agent": "Example harness", "trials": 1, "focus": "model"}]
        records.extend([{**records[0], "trials": 10}, {**records[0], "hidden": True},
                        {**records[0], "focus": "agent"}])
        rows = evidence.Rows(CATALOG)
        evidence.cybergym(FixtureCache({"level1": records}), rows)
        self.assertEqual(len(rows.rows), 1)
        self.assertEqual(rows.rows[0]["kind"], "vendor")
        self.assertEqual(rows.rows[0]["halfLifeDays"], 365)
        self.assertIn("Example harness", rows.rows[0]["reporter"])
        csv_data = "Model,End-to-End % Solved\nClaude Opus 5.5²,42\nGPT-6 Astra¹,40\n"
        evidence.cybench(FixtureCache((csv_data.encode(), DATE)), rows)
        self.assertEqual([r["kind"] for r in rows.rows[1:]], ["vendor", "measured"])

    def test_invalid_values_and_dates_are_rejected(self):
        for value, date in [(float("nan"), DATE), (float("inf"), DATE), (True, DATE), (1, "yesterday")]:
            with self.subTest(value=value, date=date), self.assertRaises(ValueError):
                evidence.Rows(CATALOG).add("GPT-6 Astra", value, "x", "Arena", date, "https://example.test")

    def test_aa_cyber_keeps_effort_release_harness_and_zero_scores(self):
        model = {"slug": "gpt-6-astra", "name": "GPT-6 Astra (Max)",
                 "release": {"slug": "gpt-6-astra"}, "effort": {"slug": "max"},
                 "cyberIndex": 30, "cweBench": 0.6, "deepsecBench": 0.3, "cybergymE2e": 0}
        variant = {**model, "slug": "gpt-6-astra-daybreak-blue",
                   "release": {"slug": "gpt-6-astra-daybreak-blue"}}
        flight = "1:" + json.dumps([model, variant, model]) + "\n2:I[123]\n"
        html = '<script>self.__next_f.push(' + json.dumps([1, flight]) + ')</script>'
        html += '<script>throw Error("must not execute")</script>'
        rows = evidence.Rows(CATALOG)
        evidence.aa_cyber(FixtureCache((html.encode(), DATE)), rows)
        self.assertEqual(len(rows.rows), 4)
        self.assertEqual({r["signal"] for r in rows.rows},
                         {"aa_cyber_index", "aa_cwe_bench", "aa_deepsec_bench", "aa_cybergym_e2e"})
        self.assertTrue(all(r["model"] == "gpt-6-astra" and r["effort"] == "max"
                            and r["kind"] == "measured" and r["halfLifeDays"] == 180
                            and r["asof"] == DATE and "Stirrup" in r["reporter"] for r in rows.rows))
        self.assertEqual(rows.rows[-1]["value"], 0)
        self.assertEqual(rows.unmapped, {"AA Cyber: gpt-6-astra-daybreak-blue (max)"})
        with self.assertRaises(ValueError):
            evidence.aa_cyber(FixtureCache((b"<html>No model data</html>", DATE)), rows)

    def test_cache_reuses_original_fetch_date_and_never_persists_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = evidence.Cache(Path(directory))
            with patch.object(evidence.urllib.request, "urlopen", return_value=io.BytesIO(b"public data")) as request:
                first = cache.get("https://example.test/data", "test-credential")
                second = cache.get("https://example.test/data", "test-credential")
            self.assertEqual(first, second)
            self.assertEqual(request.call_count, 1)
            sent = request.call_args.args[0]
            self.assertEqual(sent.get_header("Authorization"), "Bearer test-credential")
            redirected = evidence.urllib.request.HTTPRedirectHandler().redirect_request(
                sent, None, 302, "redirect", {}, "https://other.example.test/data")
            self.assertIsNone(redirected.get_header("Authorization"))
            for file in Path(directory).iterdir():
                self.assertNotIn("test-credential", file.read_text())
                self.assertEqual(file.stat().st_mode & 0o777, 0o600)

    def test_cache_expires_after_a_day_and_spaces_network_requests(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = evidence.Cache(Path(directory))
            with (patch.object(evidence.time, "time", return_value=1000) as clock,
                  patch.object(evidence.time, "monotonic", return_value=100),
                  patch.object(evidence.time, "sleep") as sleep,
                  patch.object(evidence.urllib.request, "urlopen",
                               side_effect=lambda *args, **kwargs: io.BytesIO(b"data")) as request):
                cache.get("https://example.test/data")
                clock.return_value = 1001
                cache.get("https://example.test/data")
                self.assertEqual(request.call_count, 1)
                clock.return_value = 87400
                cache.get("https://example.test/data")
                self.assertEqual(request.call_count, 2)
                self.assertEqual([call.args[0] for call in sleep.call_args_list], [0, 1])

    def test_failure_does_not_retry_or_replace_old_rows_with_partial_results(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            old = {"rows": [{"model": "gpt-6-astra", "asof": "2026-10-01"}],
                   "unmapped": ["old unknown"], "notes": ["Original source attribution"]}
            evidence.atomic(state / "evidence-open.json", json.dumps({"sources": {"test": old}}).encode())
            catalog = state / "catalog.json"
            catalog.write_text(json.dumps({"models": [{"id": model} for model in CATALOG]}))
            attempts = []

            def fail(cache, rows):
                attempts.append(1)
                rows.add("GPT-6 Astra", 1, "x", "Arena", DATE, "https://example.test")
                raise urllib.error.HTTPError("https://example.test", 429, "test-credential", {}, None)

            output = io.StringIO()
            with patch.dict(evidence.PULLERS, {"test": fail}, clear=True), contextlib.redirect_stdout(output):
                self.assertEqual(evidence.pull(state, catalog), 0)
            self.assertEqual(attempts, [1])
            result = json.loads((state / "evidence-open.json").read_text())
            self.assertEqual(result["rows"], old["rows"])
            self.assertIn("Original source attribution", result["notes"])
            self.assertIn("HTTP 429", output.getvalue())
            self.assertNotIn("test-credential", output.getvalue())


if __name__ == "__main__":
    unittest.main()
