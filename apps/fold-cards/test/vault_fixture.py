"""Synthetic vault CLI peer for hook failure and sequencing tests."""
import json
import os
from pathlib import Path
import sys

root = Path(os.environ['FIXTURE_VAULT'])
with (root / 'calls.jsonl').open('a') as f:
    f.write(json.dumps(sys.argv[1:]) + '\n')
if sys.argv[1] == 'research-check':
    if sys.argv[2] == 'failure':
        print('private diagnostic must stay local', file=sys.stderr)
        sys.exit(1)
    print(json.dumps({'claims': [{'id': 'c-12345678', 'freshness': 'stale',
                                 'sources': [{'id': 'src-12345678'}]}], 'passages': [],
                      'recheck': [{'id': 'src-12345678'}]}))
elif sys.argv[1] == 'research-run':
    run = json.load(sys.stdin)
    if run['summary'] == 'reject':
        sys.exit(1)
    (root / 'written.json').write_text(json.dumps(run))
    print('Synthetic run recorded')
else:
    sys.exit(2)
