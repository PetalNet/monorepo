import json
import subprocess
import sys
import unittest

from janet_voice_head import web_guard


def resolves(*addresses):
    return lambda host, port, **_: [(2, 1, 6, "", (address, port)) for address in addresses]


class RefusalTest(unittest.TestCase):
    def test_private_and_lab_targets_are_refused(self):
        for url in ("http://localhost:8080/", "http://127.0.0.1/", "http://10.1.2.3/", "http://192.168.0.9/", "http://169.254.169.254/",
                    "http://100.101.1.1/", "http://[::1]/", "http://[::ffff:10.0.0.1]/", "https://petalcat.dev/", "https://foo.petalcat.dev/",
                    "https://box.tail1234.ts.net/", "http://intranet/", "http://2130706433/", "ftp://example.com/", "file:///etc/passwd",
                    "http://user@example.com/", "http://[::127.0.0.1]/", "http://[64:ff9b::7f00:1]/", "http://224.0.0.1/",
                    "https://foo.petalcat\u3002dev/", "https://\uff50\uff45\uff54\uff41\uff4c\uff43\uff41\uff54.dev/"):
            self.assertIsNotNone(web_guard.refusal(url), url)

    def test_a_public_name_that_resolves_privately_is_refused(self):
        self.assertIsNotNone(web_guard.refusal("https://rebind.example.com/", resolve=resolves("93.184.216.34", "10.0.0.7")))

    def test_a_public_page_is_allowed(self):
        self.assertIsNone(web_guard.refusal("https://www.panerabread.com/en-us/home.html", resolve=resolves("93.184.216.34")))

    def test_the_hook_command_exits_2_when_it_cannot_run(self):
        command = web_guard.settings(("WebFetch",))["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
        self.assertTrue(command.endswith(" || exit 2"))

    def test_main_like_args_with_an_ambiguous_settings_flag_are_refused(self):
        for args in (["--settings=/x.json"], ["--settings", "{}", "--settings", "{}"], ["--settings"]):
            with self.assertRaises(ValueError):
                web_guard.main_like_args(args, ("WebFetch",))

    def test_the_hook_denies_on_stdin_and_fails_closed_on_garbage(self):
        def run(stdin):
            out = subprocess.run([sys.executable, "-I", web_guard.__file__], input=stdin, capture_output=True, text=True, check=True).stdout
            return json.loads(out)["hookSpecificOutput"]["permissionDecision"] if out else None
        self.assertEqual(run(json.dumps({"tool_input": {"url": "http://127.0.0.1:9/"}})), "deny")
        self.assertEqual(run("not json"), "deny")


if __name__ == "__main__":
    unittest.main()
