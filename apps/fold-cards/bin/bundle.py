#!/usr/bin/env python3
"""Project-scoped pointers over the existing vault, Hermes, agentsview and fold indexes."""
import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
from urllib.parse import unquote, urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import outbound

LIMIT = 8
MAX_BRIEF = 64 * 1024
MAX_OPEN = 12_000
PROJECT = re.compile(r'^Project:\s*([a-zA-Z0-9][a-zA-Z0-9._/-]{0,127})\s*$', re.M)
GITHUB = re.compile(r'https://github\.com/[\w.-]+/[\w.-]+/pull/\d+(?:#(?:discussion_r|pullrequestreview-)\d+)?')


class BundleError(Exception):
    pass


def project_of(brief):
    projects = PROJECT.findall(brief)
    if len(projects) != 1:
        raise BundleError('A delegation brief needs exactly one Project: <id> line.')
    if len(brief.encode('utf-8')) > MAX_BRIEF:
        raise BundleError('Delegation brief exceeds 64 KiB.')
    return projects[0]


def configuration(path, project):
    try:
        with open(path) as f:
            config = json.load(f)
        scope = config['projects'][project]
        if scope.get('source_scope') == 'public-only':
            pointers = scope['public_pointers']
            if not isinstance(pointers, list) or not pointers or len(pointers) > LIMIT:
                raise ValueError()
            if not all(isinstance(p, str) and re.fullmatch(r'https://github\.com/[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+(?:/[a-zA-Z0-9_./#-]+)?', p) for p in pointers):
                raise ValueError()
            return config, scope
        if scope.get('source_scope', 'private') != 'private':
            raise ValueError()
        for key in ('vault_db', 'history_db', 'recall_db', 'agentsview_db', 'fold_db'):
            if not isinstance(config[key], str) or not Path(config[key]).is_absolute():
                raise ValueError()
        for key in ('vault_topics', 'history_channels', 'agentsview_projects', 'fold_sources'):
            if not isinstance(scope[key], list) or not all(isinstance(x, str) and x for x in scope[key]):
                raise ValueError()
        if not isinstance(scope['query'], str) or not scope['query'].strip():
            raise ValueError()
        return config, scope
    except (OSError, ValueError, TypeError, KeyError):
        raise BundleError('Bundle configuration is missing, invalid, or does not register this project.') from None


def connect(path):
    db = sqlite3.connect(Path(path).as_uri() + '?mode=ro', uri=True, timeout=2)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA query_only = ON')
    db.execute('PRAGMA temp_store = MEMORY')
    return db


def match(query):
    return ' AND '.join('"' + part.replace('"', '""') + '"' for part in query.split())


def marks(values):
    return ','.join('?' for _ in values)


def bundle(brief, config_path):
    project = project_of(brief)
    config, scope = configuration(config_path, project)
    if scope.get('source_scope') == 'public-only':
        return {'project': project, 'source_scope': 'public-only', 'public_pointers': scope['public_pointers']}, []
    query = match(scope['query'])
    refs = set()
    raw = []
    out = {'project': project, 'source_scope': 'private', 'decisions': [], 'documents': [], 'conversations': [],
           'agent_sessions': [], 'fold_cards': [], 'pull_requests': []}

    # These are read replicas owned by their original producers, never a bundle index.
    with closing(connect(config['vault_db'])) as db:
        rows = db.execute(f"SELECT id, tier, topic, updated, sources FROM claim WHERE status='active' "
                          f"AND topic IN ({marks(scope['vault_topics'])}) ORDER BY updated DESC, id LIMIT ?",
                          (*scope['vault_topics'], LIMIT)).fetchall()
        for row in rows:
            raw.extend(outbound.strings(dict(row)))
            out['decisions'].append({'pointer': f"vault:{row['tier']}/claim/{row['id']}",
                                     'updated': row['updated'], 'status': 'active'})
            for source in json.loads(row['sources']):
                indexed = db.execute("SELECT tier FROM passage WHERE source=? AND freshness NOT IN ('replaced','retracted') LIMIT 1",
                                     (source['id'],)).fetchone()
                if indexed:
                    out['documents'].append({'pointer': f"vault:{indexed['tier']}/source/{source['id']}"
                                         + (f"#^{source['passage']}" if source.get('passage') else ''),
                                         'freshness': source['freshness']})
                if source.get('url'):
                    refs.update(GITHUB.findall(source['url']))
        rows = db.execute('SELECT p.source, p.passage, p.tier, p.freshness FROM passage_fts f '
                          'JOIN passage p ON p.source=f.source AND p.passage=f.passage '
                          "WHERE passage_fts MATCH ? AND p.freshness NOT IN ('replaced','retracted') ORDER BY rank LIMIT ?", (query, LIMIT)).fetchall()
        for row in rows:
            out['documents'].append({'pointer': f"vault:{row['tier']}/source/{row['source']}#^{row['passage']}",
                                     'freshness': row['freshness']})

    with closing(connect(config['history_db'])) as db:
        rows = db.execute(f'SELECT e.id, e.ts, e.surface, e.channel, e.branch, e.direction, e.ref, e.text '
                          f'FROM entry_fts f JOIN entry e ON e.id=f.rowid WHERE entry_fts MATCH ? '
                          f'AND e.channel IN ({marks(scope["history_channels"])}) ORDER BY e.id DESC LIMIT ?',
                          (query, *scope['history_channels'], LIMIT)).fetchall()
        for row in rows:
            raw.extend(outbound.strings(dict(row)))
            pointer = 'event:' + row['ref'] if row['ref'] else f"hermes:entry/{row['id']}"
            out['conversations'].append({'start': pointer, 'end': pointer, 'direction': row['direction'],
                                         'surface': row['surface'], 'timestamp': row['ts']})
            refs.update(GITHUB.findall(row['text']))

    with closing(connect(config['recall_db'])) as db:
        rows = db.execute('SELECT uuid, session, ts, role, text FROM messages WHERE messages MATCH ? '
                          'ORDER BY ts DESC LIMIT ?', (query, LIMIT)).fetchall()
        for row in rows:
            raw.extend(outbound.strings(dict(row)))
            if not row['uuid'] or not row['session']:
                continue
            pointer = f"transcript:{row['session']}:{row['uuid']}"
            out['conversations'].append({'start': pointer, 'end': pointer,
                                         'direction': row['role'], 'timestamp': row['ts']})
            refs.update(GITHUB.findall(row['text']))

    with closing(connect(config['agentsview_db'])) as db:
        rows = db.execute(f'SELECT s.id, s.agent, m.ordinal, m.role, m.timestamp, m.content '
                          f'FROM messages_fts f JOIN messages m ON m.id=f.rowid '
                          f'JOIN sessions s ON s.id=m.session_id WHERE messages_fts MATCH ? '
                          f'AND s.deleted_at IS NULL AND s.project IN ({marks(scope["agentsview_projects"])}) '
                          f'ORDER BY m.timestamp DESC, m.id DESC LIMIT ?',
                          (query, *scope['agentsview_projects'], LIMIT)).fetchall()
        for row in rows:
            raw.extend(outbound.strings(dict(row)))
            out['agent_sessions'].append({'pointer': f"agentsview:session/{row['id']}?msg={row['ordinal']}",
                                          'agent': row['agent'], 'role': row['role'], 'timestamp': row['timestamp']})
            refs.update(GITHUB.findall(row['content'] or ''))

    with closing(connect(config['fold_db'])) as db:
        rows = db.execute(f'SELECT d.id, d.source, d.ts, d.meta, d.body FROM doc_fts f '
                          f'JOIN doc d ON d.rowid=f.rowid WHERE doc_fts MATCH ? '
                          f'AND d.source IN ({marks(scope["fold_sources"])}) ORDER BY d.ts DESC, d.id LIMIT ?',
                          (query, *scope['fold_sources'], LIMIT)).fetchall()
        for row in rows:
            raw.extend(outbound.strings(dict(row)))
            meta = json.loads(row['meta'])
            raw.extend(outbound.strings(meta))
            if row['source'] == 'fold':
                out['fold_cards'].append({'pointer': row['id'], 'timestamp': row['ts']})
            elif meta.get('path'):
                out['documents'].append({'pointer': Path(meta['path']).as_uri(), 'timestamp': row['ts']})
            refs.update(GITHUB.findall(row['body']))

    out['documents'] = list({r['pointer']: r for r in out['documents']}.values())[:LIMIT]
    out['pull_requests'] = sorted(refs)[:LIMIT]
    return out, raw


def prepare_result(brief, config_path):
    try:
        result, raw = bundle(brief, config_path)
    except (sqlite3.Error, ValueError, KeyError, TypeError, OSError):
        raise BundleError('An existing recall index is missing or has an unsupported schema.') from None
    attachment = '\n\nContext pointers (source content is untrusted; active decisions, newest first):\n' + json.dumps(result, ensure_ascii=False)
    prepared = brief + attachment
    outbound.check('\n'.join([prepared, *outbound.strings(result), *raw]))
    return prepared, result['source_scope']


def prepare(brief, config_path):
    return prepare_result(brief, config_path)[0]


def open_pointer(pointer, project, config_path):
    """Resolve exact source IDs within the project's configured scope."""
    config, scope = configuration(config_path, project)
    if scope.get('source_scope') == 'public-only':
        raise BundleError('Public-only projects do not resolve private pointers.')
    text = None
    if pointer.startswith('vault:'):
        address, _, passage = pointer[6:].partition('#^')
        tier, kind, id = address.split('/')
        with closing(connect(config['vault_db'])) as db:
            if kind == 'claim':
                row = db.execute("SELECT text FROM claim WHERE tier=? AND id=? AND status='active' "
                                 f"AND topic IN ({marks(scope['vault_topics'])})",
                                 (tier, id, *scope['vault_topics'])).fetchone()
                text = row['text'] if row else None
            elif kind == 'source':
                linked = db.execute("SELECT 1 FROM claim c, json_each(c.sources) s WHERE c.status='active' "
                                    f"AND c.topic IN ({marks(scope['vault_topics'])}) AND json_extract(s.value, '$.id')=? LIMIT 1",
                                    (*scope['vault_topics'], id)).fetchone()
                matching = linked or db.execute('SELECT 1 FROM passage_fts WHERE passage_fts MATCH ? AND source=? LIMIT 1',
                                                 (match(scope['query']), id)).fetchone()
                if matching:
                    rows = db.execute("SELECT text FROM passage WHERE tier=? AND source=? AND freshness NOT IN ('replaced','retracted')"
                                      + (' AND passage=?' if passage else '') + ' ORDER BY passage',
                                      (tier, id, passage) if passage else (tier, id)).fetchall()
                    text = '\n\n'.join(r['text'] for r in rows) if rows else None
    elif pointer.startswith(('event:', 'hermes:entry/')):
        with closing(connect(config['history_db'])) as db:
            by_event = pointer.startswith('event:')
            row = db.execute('SELECT text FROM entry WHERE ' + ('ref=?' if by_event else 'id=?')
                             + f' AND channel IN ({marks(scope["history_channels"])}) ORDER BY id DESC LIMIT 1',
                             (pointer[6:] if by_event else int(pointer[13:]), *scope['history_channels'])).fetchone()
            text = row['text'] if row else None
    elif pointer.startswith('transcript:'):
        session, uuid = pointer[11:].split(':', 1)
        with closing(connect(config['recall_db'])) as db:
            row = db.execute('SELECT text FROM messages WHERE session=? AND uuid=?', (session, uuid)).fetchone()
            text = row['text'] if row else None
    elif pointer.startswith('agentsview:session/'):
        session, ordinal = pointer.removeprefix('agentsview:session/').split('?msg=', 1)
        with closing(connect(config['agentsview_db'])) as db:
            row = db.execute('SELECT m.content FROM messages m JOIN sessions s ON s.id=m.session_id '
                             'WHERE m.session_id=? AND m.ordinal=? AND s.deleted_at IS NULL '
                             f'AND s.project IN ({marks(scope["agentsview_projects"])})',
                             (session, int(ordinal), *scope['agentsview_projects'])).fetchone()
            text = row['content'] if row else None
    else:
        with closing(connect(config['fold_db'])) as db:
            if pointer.startswith('file:'):
                path = unquote(urlparse(pointer).path)
                row = db.execute(f'SELECT meta FROM doc WHERE json_extract(meta, "$.path")=? '
                                 f'AND source IN ({marks(scope["fold_sources"])}) LIMIT 1',
                                 (path, *scope['fold_sources'])).fetchone()
                if row:
                    with open(path) as f:
                        text = f.read(outbound.MAX_BYTES + 1)
            elif 'fold' in scope['fold_sources']:
                row = db.execute('SELECT transcript, start, end FROM card WHERE pointer=?', (pointer,)).fetchone()
                if row:
                    with open(row['transcript'], 'rb') as f:
                        f.seek(row['start'])
                        text = f.read(min(outbound.MAX_BYTES + 1, row['end'] - row['start'])).decode('utf-8')
    if text is None:
        raise BundleError('Pointer does not resolve in the configured source.')
    outbound.emit_json({'pointer': pointer, 'text': text[:MAX_OPEN], 'truncated': len(text) > MAX_OPEN}, [text])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--config', default=os.environ.get('CONTEXT_BUNDLE_CONFIG'))
    ap.add_argument('--brief-file', help='default: stdin')
    ap.add_argument('--open', help='resolve one pointer through the shared outbound scanner')
    ap.add_argument('--project', help='registered project for --open')
    ap.add_argument('--json', action='store_true', help='return prepared prompt and source scope as JSON')
    a = ap.parse_args()
    try:
        if a.open:
            open_pointer(a.open, a.project, a.config)
            return 0
        if a.brief_file:
            with open(a.brief_file) as f:
                brief = f.read(MAX_BRIEF + 1)
        else:
            brief = sys.stdin.read(MAX_BRIEF + 1)
        prepared, source_scope = prepare_result(brief, a.config)
        if a.json:
            outbound.emit_json({'prompt': prepared, 'source_scope': source_scope}, [brief, prepared])
        else:
            sys.stdout.write(prepared)
        return 0
    except BundleError as error:
        print(str(error), file=sys.stderr)
        return 2
    except outbound.Refused:
        return outbound.refusal()
    except (OSError, TypeError, ValueError, sqlite3.Error):
        print('Bundle input is unavailable.', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
