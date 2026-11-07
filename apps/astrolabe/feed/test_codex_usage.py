import json
import os
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("codex-usage")

# Writes the initialize reply and the rate-limit reply in ONE write, then stays
# alive like the real app-server. A reader that select()s the fd after a
# buffered readline() never sees the second line and times out.
FAKE_APP_SERVER = """#!{python}
import os, sys, time
for _ in range(3):
    sys.stdin.readline()
os.write(1, b'{{"id":1,"result":{{}}}}\\n'
            b'{{"id":2,"result":{{"rateLimits":{{"primary":{{"usedPercent":42,'
            b'"windowDurationMins":10080,"resetsAt":1793774155}},"secondary":null,'
            b'"credits":{{"balance":"12.5"}},"planType":"prolite",'
            b'"rateLimitReachedType":null}}}}}}\\n')
time.sleep(60)
"""


class LiveReadTest(unittest.TestCase):
    def test_replies_in_one_write_are_read_live(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake = Path(tmp, "codex")
            fake.write_text(FAKE_APP_SERVER.format(python=sys.executable))
            fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
            env = {"PATH": f"{tmp}:{os.environ['PATH']}", "HOME": tmp}
            started = time.monotonic()
            out = subprocess.run(
                [sys.executable, str(SCRIPT), "--json"],
                env=env, capture_output=True, text=True, timeout=60, check=True,
            ).stdout
            elapsed = time.monotonic() - started
        snap = json.loads(out)
        self.assertEqual(snap["seven_day_pct"], 42.0)
        self.assertEqual(snap["credits_balance"], 12.5)
        self.assertEqual(snap["snapshot_age_sec"], 0)
        self.assertLess(elapsed, 10)


if __name__ == "__main__":
    unittest.main()
