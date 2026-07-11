#!/usr/bin/env python3
"""N0.1 light validation: (1) each schema parses as JSON, (2) each is a valid
draft 2020-12 schema per the metaschema, (3) a canonical example instance
validates, (4) a deliberately-broken instance is rejected."""
import json, sys
from pathlib import Path
from jsonschema import Draft202012Validator
from jsonschema.validators import RefResolver

SDIR = Path(__file__).parent / "schemas"
schemas = {}
for p in sorted(SDIR.glob('*.schema.json')):
    schemas[p.name] = json.loads(p.read_text())
    print(f"parse OK        {p.name}")

# metaschema check
for name, s in schemas.items():
    Draft202012Validator.check_schema(s)
    print(f"metaschema OK   {name}")

# cross-file $ref store (task-card -> queue-lease#leasePublic)
store = {s['$id']: s for s in schemas.values()}

def v(name, instance, should_pass, label):
    s = schemas[name]
    resolver = RefResolver(base_uri=s['$id'], referrer=s, store=store)
    errs = list(Draft202012Validator(s, resolver=resolver).iter_errors(instance))
    ok = (not errs) == should_pass
    verdict = 'OK' if ok else 'FAIL'
    detail = '' if not errs else f" [{errs[0].message[:90]}]"
    print(f"instance {verdict:4}   {name}: {label}{'' if ok else detail}")
    if not ok:
        for e in errs[:3]: print('   !', e.message)
        sys.exit(1)

now = "2026-07-09T08:00:00Z"
u = "0b6da2c4-3a89-4a5f-9a3e-2f4f5f6a7b8c"

v('session-state.schema.json',
  {"schema_version": 1, "sessionId": u, "bootstrapped": True}, True, "canonical state")
v('session-state.schema.json', {"sessionId": u}, True, "legacy state (no version)")
v('session-state.schema.json', {"bootstrapped": False}, False, "missing sessionId rejected")

hb = {"schema_version": 2, "version": "0.3.0", "handle": "janet", "pid": 4242,
      "state": "running", "session_id": u, "tmux_session": "janet-claude",
      "pane_id": "%12", "io_ok": True, "crash_count": 0,
      "started_at_epoch": 1783500000, "last_sync_ok_epoch": 1783500100,
      "updated_at_epoch": 1783500101,
      "channel_lock": {"state": "held", "owner": "janet@dot14/manager", "acquired_at_epoch": 1783500000}}
hbs = {"$ref": "#/$defs/heartbeat", **{k: schemas['session-state.schema.json'][k] for k in ('$schema','$defs')}}
schemas['heartbeat-sub'] = hbs | {"$id": "https://schemas.petalnet.lab/contracts/v1/hb-sub.json"}
store[schemas['heartbeat-sub']['$id']] = schemas['heartbeat-sub']
v('heartbeat-sub', hb, True, "canonical heartbeat (windows-null variant next)")
v('heartbeat-sub', hb | {"tmux_session": None, "pane_id": None}, True, "OS-neutral nulls")
v('heartbeat-sub', hb | {"state": "zombie"}, False, "bad state rejected")
v('heartbeat-sub', {k: x for k, x in hb.items() if k != 'schema_version'}, False, "missing version rejected")

fe = {"schema_version": 1, "handle": "janet", "host": ".14", "event": "post_tool",
      "status": "working", "current_tool": "Bash", "task_id": 670,
      "session_id": u, "started_at": now, "updated_at": now}
v('fleet-event.schema.json', fe, True, "canonical event")
v('fleet-event.schema.json', fe | {"extra_field": 1}, True, "unknown fields tolerated (many producers)")
v('fleet-event.schema.json', fe | {"status": "offline"}, False, "producer-written offline rejected")
v('fleet-event.schema.json', fe | {"handle": "Janet"}, False, "non-canonical handle rejected")

lease = {"schema_version": 1, "task_id": 670, "worker": "scout", "claim_token": u,
         "fence": 3, "granted_at": now, "lease_expires_at": "2026-07-09T08:30:00Z",
         "lease_seconds": 1800}
v('queue-lease.schema.json', lease, True, "canonical lease")
v('queue-lease.schema.json', {k: x for k, x in lease.items() if k != 'fence'}, False, "missing fence rejected")

card = {"schema_version": 1, "card_id": u, "task_id": 670, "sender": "@parker:petalnet.lab",
        "sender_class": "principal", "recipient": "janet", "priority": 0,
        "thread": "$abc123", "requires_reply": True, "interrupt_policy": "principal_command",
        "body": "status on the rewrite?", "capability": None,
        "lease": {"schema_version": 1, "task_id": 670, "worker": "janet",
                  "lease_expires_at": "2026-07-09T08:30:00Z"},
        "created_at": now, "expires_at": None}
v('task-card.schema.json', card, True, "canonical card w/ cross-file leasePublic $ref")
bad_lease_card = dict(card); bad_lease_card['lease'] = lease  # full lease w/ claim_token
v('task-card.schema.json', bad_lease_card, False, "card carrying claim_token rejected")
v('task-card.schema.json', card | {"interrupt_policy": "always"}, False, "bad interrupt_policy rejected")
v('task-card.schema.json', {k: x for k, x in card.items() if k != 'task_id'}, False, "missing task_id rejected")

req = {"schema_version": 1, "id": u, "type": "request", "method": "task.dispatch",
       "agent": "scout", "task_id": 670, "payload": {"card": "..."}, "ts": now,
       "deadline_ms": 30000}
v('backchannel-rpc.schema.json', req, True, "canonical request")
v('backchannel-rpc.schema.json',
  {"schema_version": 1, "id": u, "type": "response", "in_reply_to": u, "agent": "scout",
   "payload": {"ok": True}, "ts": now}, True, "canonical response")
v('backchannel-rpc.schema.json',
  {"schema_version": 1, "id": u, "type": "error", "in_reply_to": u, "agent": "scout",
   "error": {"code": "lease_lost", "message": "fence stale", "retryable": False},
   "ts": now}, True, "canonical error")
v('backchannel-rpc.schema.json',
  {"schema_version": 1, "id": u, "type": "heartbeat", "agent": "scout", "ts": now},
  True, "canonical heartbeat")
v('backchannel-rpc.schema.json', {k: x for k, x in req.items() if k != 'method'},
  False, "request without method rejected")
v('backchannel-rpc.schema.json',
  {"schema_version": 1, "id": u, "type": "response", "agent": "scout", "ts": now},
  False, "response without in_reply_to rejected")

cfg = {"creds_path": "~/.claude/shared/janet-account.json",
       "control_room": "!abc123:petalnet.lab", "agent_name": "janet",
       "work_dir": "~", "claude_args": ["--dangerously-skip-permissions"],
       "kill_agent_on_shutdown": True, "tmux_width": 220, "tmux_height": 50}
v('manager-config.schema.json', cfg, True, "canonical config (today's shape, no schema_version)")
v('manager-config.schema.json', cfg | {"schema_version": 1}, True, "rewrite config w/ schema_version")
v('manager-config.schema.json', cfg | {"contrl_room": "!x:y"}, False, "typo'd key rejected (deny-unknown)")
v('manager-config.schema.json', {"creds_path": "~/x.json"}, False, "missing control_room rejected")

print("\nALL VALIDATION CHECKS PASSED")
