#!/usr/bin/env python3
"""Shared pending-count predicate for run.sh and worker.sh.

Counts cite jobs still due (QUEUED or RUNNING) plus derivations still due
(PENDING, or RUNNING because a worker holds their lease). The drain loop in
both scripts exits only once this reaches zero, so a leased-but-unfinished
derivation must count: otherwise a killed extraction leaves work outstanding
while the loop has already stopped.
"""

import os
import sqlite3

root = os.environ["CITE_ROOT"]
db = sqlite3.connect(f"file:{root}/index-v2.sqlite?mode=ro", uri=True)
jobs = db.execute("SELECT count(*) FROM jobs WHERE state IN ('QUEUED','RUNNING')").fetchone()[0]
derivations = db.execute(
    "SELECT count(*) FROM derivations WHERE state IN ('PENDING','RUNNING')"
).fetchone()[0]
print(jobs + derivations)
