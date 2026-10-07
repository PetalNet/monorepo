#!/usr/bin/env python3
"""Idempotently import Parker's private prototype. Never put voice data in Git."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import uuid
import wave

parser = argparse.ArgumentParser()
parser.add_argument('source', type=Path)
parser.add_argument('destination', type=Path)
args = parser.parse_args()
target = args.destination / 'parker_parker'
target.mkdir(parents=True, exist_ok=True, mode=0o700)
target.chmod(0o700)
records = []
source_records = [json.loads(line) for line in (args.source / 'clips.jsonl').read_text().splitlines()]
latest = {record['file']: record for record in source_records}
for original in latest.values():
    name = original['file']
    if Path(name).name != name or not name.endswith('.wav'):
        raise ValueError('Unsafe source filename')
    source = args.source / name
    with wave.open(str(source), 'rb') as wav:
        assert (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) == (16000, 1, 2)
        duration = wav.getnframes() / 16000
    dest = target / name
    if dest.exists():
        assert hashlib.sha256(dest.read_bytes()).digest() == hashlib.sha256(source.read_bytes()).digest()
    else:
        shutil.copyfile(source, dest)
        dest.chmod(0o600)
    # UUID4-shaped deterministic key remains accepted by the review API.
    clip_id = str(uuid.UUID(bytes=hashlib.sha256(('parker/' + name).encode()).digest()[:16], version=4))
    meta = target / (clip_id + '.clip.json')
    if meta.exists():
        record = json.loads(meta.read_text())
        record.update({k: original[k] for k in ('peak', 'at')})
        record['sourceEntries'] = [r for r in source_records if r['file'] == name]
        meta.write_text(json.dumps(record) + '\n')
    else:
        record = dict(original, id='parker', name='Parker', participantId='parker', participantName='Parker',
                      authSub=None, clipId=clip_id, setId='prototype-2026-10-07', duration=duration,
                      userAgent='unknown (prototype did not retain user agent)', deviceType='desktop',
                      decision='undecided', flags=['near-silent-probable-misfire'] if name.startswith('pos_17_') else [],
                      source='Parker prototype, 2026-10-07', sourceEntries=[r for r in source_records if r['file'] == name], sourceSha256=hashlib.sha256(source.read_bytes()).hexdigest())
        meta.write_text(json.dumps(record) + '\n')
        meta.chmod(0o600)
    records.append(record)
assert len(records) == 40, f'Expected 40 clips, got {len(records)}'
# Include later additions if this participant folder has any.
records = [json.loads(p.read_text()) for p in sorted(target.glob('*.clip.json'))]
journal = target / 'clips.jsonl'
tmp = target / 'clips.jsonl.import.tmp'
tmp.write_text(''.join(json.dumps(r) + '\n' for r in records))
tmp.chmod(0o600)
tmp.replace(journal)
print(f'Imported/verified {len(records)} clips at {target}; pos_17 preserved and flagged.')
