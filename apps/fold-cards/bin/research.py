#!/usr/bin/env python3
"""Lab-first web hooks and checked research-run writeback through the existing vault CLI."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bundle
import outbound


class ResearchError(Exception):
    pass


def vault(args, text=None):
    try:
        command = json.loads(os.environ.get('VAULT_RESEARCH_ARGV', 'null'))
        if not isinstance(command, list) or not command or not all(isinstance(v, str) and v for v in command):
            raise ValueError()
        result = subprocess.run([*command, *args], input=text, text=True, capture_output=True, timeout=60)
        if result.returncode != 0:
            raise ValueError()
        return result.stdout
    except (OSError, ValueError, subprocess.SubprocessError):
        raise ResearchError('Vault research operation failed; no web search or completion is authorized.') from None


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def state_dir(session):
    if not isinstance(session, str) or not session.strip():
        raise ResearchError('Research hooks require session_id.')
    return Path(os.environ.get('RESEARCH_STATE_DIR', '~/.local/state/lab-research')).expanduser() / digest(session)


def save(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as f:
        json.dump(value, f)
    os.replace(f.name, path)


def check(question, project, session):
    if not isinstance(question, str) or not question.strip() or len(question) > 16_000:
        raise ResearchError('Research query must be nonempty and at most 16000 characters.')
    if not project:
        raise ResearchError('Set RESEARCH_PROJECT to a registered project before research.')
    # The same project policy applies to research, and no query leaves before scanning.
    prepared = bundle.prepare(f'Project: {project}\nGoal: research {question}', os.environ.get('CONTEXT_BUNDLE_CONFIG'))
    output = vault(['research-check', question])
    try:
        result = json.loads(output)
        outbound.check('\n'.join([output, *outbound.strings(result)]))
        claims, passages, recheck = result['claims'], result['passages'], result['recheck']
        if not all(isinstance(items, list) for items in (claims, passages, recheck)):
            raise ValueError()
        ids = [c['id'] for c in claims]
        sources = list({s['id'] for c in claims for s in c['sources']} | {p['source'] for p in passages})
        stale = [c['id'] for c in claims if c['freshness'] != 'fresh']
        if not all(isinstance(x, str) and x for x in [*ids, *sources, *stale]):
            raise ValueError()
        pointers = {'lab_claims': ids, 'lab_sources': sources,
                    'recheck': [r['id'] for r in recheck]}
    except (KeyError, TypeError, ValueError):
        raise ResearchError('research_check returned an unsupported response.') from None
    context = prepared + '\nLab research_check provenance:\n' + json.dumps(pointers, ensure_ascii=False)
    context += '\nAfter researching, use research.py finish with this session and a research-run JSON file. Refreshed claims require replaces; unresolved checks require explicit gaps.'
    outbound.check(context)
    path = state_dir(session) / (digest(question) + '.json')
    save(path, {'question_hash': digest(question), 'project': project, 'claims': ids, 'sources': sources, 'stale': stale})
    return context


def finish(session, run_file):
    with open(run_file) as f:
        run = json.load(f)
    try:
        question = run['question']
        path = state_dir(session) / (digest(question) + '.json')
        receipt = json.loads(path.read_text())
        claims = run['claims']
        replaces = {c['replaces'] for c in claims if c.get('replaces')}
        gaps = {g['ref'] for g in run.get('gaps', []) if isinstance(g.get('reason'), str) and g['reason'].strip()}
        if not replaces.issubset(set(receipt['claims'])) or set(receipt['stale']) - replaces - gaps:
            raise ResearchError('Refreshed claims need replaces pointing to checked claims; unresolved stale claims need gaps.')
        cited = {link['to'] for c in claims for link in c['links']}
        cited |= {p['source'] for p in run.get('passages', [])}
        used = cited | set(run.get('reused', []))
        new_sources = cited - set(receipt['claims'] + receipt['sources']) - {p['key'] for p in run.get('passages', [])} - {c['key'] for c in claims}
        provenance = {'lab': sorted(used & set(receipt['claims'] + receipt['sources'])),
                      'web': sorted(id for id in new_sources if id.startswith('src-')),
                      'other_new_sources': sorted(id for id in new_sources if not id.startswith('src-')),
                      'replaces': sorted(replaces)}
    except (KeyError, TypeError, ValueError, OSError):
        raise ResearchError('Writeback needs the original question and a successful research_check in this session.') from None
    encoded = json.dumps(run, ensure_ascii=False)
    outbound.check('\n'.join([encoded, *outbound.strings(run)]))
    output = vault(['research-run'], encoded)
    # The vault operation has committed at this point, even if its note is refused.
    path.unlink(missing_ok=True)
    outbound.check(output)
    return provenance


def search_queries(payload):
    tool = payload.get('tool_name')
    args = payload.get('tool_input', {})
    if tool == 'WebSearch':
        return [args['query']]
    if tool in ('web.run', 'web__run', 'mcp__web__run'):
        return [q['q'] for q in args.get('search_query', [])]
    return []


def hook(payload):
    queries = search_queries(payload)
    if not queries:
        return None
    # Complete every lab check before the harness permits any search in a batch.
    context = '\n\n'.join(check(q, os.environ.get('RESEARCH_PROJECT'), payload.get('session_id')) for q in queries)
    return {'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'allow', 'additionalContext': context}}


def stop(payload):
    pending = list(state_dir(payload.get('session_id')).glob('*.json'))
    if pending:
        return {'decision': 'block', 'reason': 'Research has a pending writeback. Run research.py finish --session <session_id> --run <research-run.json>; use replaces for refreshed claims and gaps for unresolved sources.'}
    return None


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='command', required=True)
    sub.add_parser('hook')
    sub.add_parser('stop')
    c = sub.add_parser('check')
    c.add_argument('--session', required=True)
    c.add_argument('--project', required=True)
    c.add_argument('question')
    f = sub.add_parser('finish')
    f.add_argument('--session', required=True)
    f.add_argument('--run', required=True)
    a = ap.parse_args()
    try:
        if a.command in ('hook', 'stop'):
            payload = json.load(sys.stdin)
            result = hook(payload) if a.command == 'hook' else stop(payload)
        elif a.command == 'check':
            result = check(a.question, a.project, a.session)
        else:
            result = finish(a.session, a.run)
        if result is not None:
            outbound.emit_json(result)
        return 0
    except (ResearchError, bundle.BundleError) as error:
        reason = str(error)
    except outbound.Refused:
        reason = 'Research output was refused by the shared secret scanner.'
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        reason = 'Research input or state is invalid.'
    if a.command == 'hook':
        print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny', 'permissionDecisionReason': reason}}))
        return 0
    if a.command == 'stop':
        print(json.dumps({'decision': 'block', 'reason': reason}))
        return 0
    print(reason, file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main())
