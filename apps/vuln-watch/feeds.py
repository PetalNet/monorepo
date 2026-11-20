"""Bounded, stdlib feed ingestion for the cron watcher; no HTTP service.

API: ingest(inventory, config, cache_dir) -> {advisories, gaps, stats}.
Config (all keys optional):
  product_aliases: {asset_id: [exact KEV product or 'vendor product' names]}
  repositories: {asset_id: ['owner/repo', ...]} (public GitHub advisories)
  vendor_packages: {asset_id: [{repository, ecosystem, name, version}, ...]}
    Explicit bindings for products without package inventory. GitHub ecosystem
    names are used here, e.g. pip, npm, go. Otherwise inventory packages bind.
    Nix/OCI package identities need explicit upstream ecosystem mappings in
    inventory; querying unsupported ecosystems cannot establish coverage.
  cve_ids: [CVE-YYYY-NNNN, ...] (evaluate against all assets, never text match)
  email: {host, username, password_file, folder, dedicated: true,
          allowed_hosts: [host], max_messages: 50}
    Dedicated inbox only; readonly IMAP TLS, BODY.PEEK; only IDs leave memory.
  timeout: seconds (1..30, default 15), cache_ttl: seconds (default 3600),
  max_nvd_queries: default 50 (0..200), max_pages: default 10 (1..20).
  max_osv_queries: default 200, max_github_queries: default 50 (network
    budgets per ingestion; cached queries do not consume these budgets).

Only fixed official HTTPS API paths are fetched, including on redirects. No
URLs from messages, references or config are fetched. Failed fetches preserve
cache and report a gap; cached responses can still be evaluated. Version
ordering supports numeric dotted releases only; unsupported ordering is unknown.
Host CPEs can prove environmental constraints, but absence cannot disprove them.
Sources: https://google.github.io/osv.dev/post-v1-query/
https://docs.github.com/en/rest/security-advisories/repository-advisories
https://nvd.nist.gov/developers/vulnerabilities
https://www.cisa.gov/known-exploited-vulnerabilities-catalog
"""
from __future__ import annotations

import hashlib
import http.client
import imaplib
import json
import re
import ssl
import time
import urllib.parse
import urllib.request
from pathlib import Path
from datetime import datetime, timedelta, timezone
from email.parser import BytesParser
from email.utils import getaddresses

KEV = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json'
OSV = 'https://api.osv.dev/v1/query'
NVD = 'https://services.nvd.nist.gov/rest/json/cves/2.0'
CVE = re.compile(r'\bCVE-\d{4}-\d{4,}\b', re.I)
ID = re.compile(r'(?:CVE-\d{4}-\d{4,}|GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})', re.I)
ECOSYSTEM = {'pip': 'PyPI', 'npm': 'npm', 'go': 'Go', 'maven': 'Maven',
             'rubygems': 'RubyGems', 'nuget': 'NuGet', 'rust': 'crates.io',
             'composer': 'Packagist', 'actions': 'GitHub Actions', 'pub': 'Pub'}


def _allowed(url):
    p = urllib.parse.urlsplit(url)
    return p.scheme == 'https' and not p.username and not p.password and p.port in (None, 443) and (
        (p.hostname == 'www.cisa.gov' and p.path == urllib.parse.urlsplit(KEV).path) or
        (p.hostname == 'api.osv.dev' and p.path == '/v1/query') or
        (p.hostname == 'services.nvd.nist.gov' and p.path == '/rest/json/cves/2.0') or
        (p.hostname == 'api.github.com' and re.fullmatch(
            r'/repos/[\w.-]+/[\w.-]+/security-advisories', p.path)))


class _Redirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not _allowed(newurl):
            raise ValueError('unapproved redirect')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class _Client:
    def __init__(self, config, cache_dir, gaps):
        self.config, self.gaps = config, gaps
        self.cache = Path(cache_dir)
        self.cache.mkdir(parents=True, exist_ok=True)
        self.timeout = max(1, min(30, float(config.get('timeout', 15))))
        self.ttl = max(0, float(config.get('cache_ttl', 3600)))
        self.next_nvd = 0.0
        self.last_fresh = True
        self.remaining = {s: max(0, min(2000, int(config.get('max_' + s + '_queries', n))))
                          for s, n in [('osv', 200), ('github', 50)]}
        self.opener = urllib.request.build_opener(_Redirects())

    def get(self, source, url, payload=None, shape=dict, required=None):
        self.last_fresh = False
        if not _allowed(url):
            raise ValueError('unapproved feed URL')
        body = json.dumps(payload, sort_keys=True).encode() if payload is not None else None
        key = hashlib.sha256(url.encode() + (body or b'')).hexdigest()
        path = self.cache / (key + '.json')
        cached = None
        try:
            cached = json.loads(path.read_text())
            if not _valid_response(source, cached, shape, required):
                cached = None
            if cached is not None and time.time() - path.stat().st_mtime < self.ttl:
                self.last_fresh = True
                return cached
        except (OSError, ValueError):
            pass
        try:
            if source in self.remaining:
                if self.remaining[source] == 0:
                    self.gaps.append(f'{source}: network query budget exhausted; '
                                     + ('using cached data' if cached is not None else 'no cached data'))
                    return cached
                self.remaining[source] -= 1
            if source == 'nvd':
                time.sleep(max(0, self.next_nvd - time.monotonic()))
                # Public NVD limit: five requests per rolling thirty seconds.
                self.next_nvd = time.monotonic() + 6.1
            req = urllib.request.Request(url, data=body, headers={
                'User-Agent': 'lab-vuln-watch/1.0', 'Accept': 'application/json',
                'Content-Type': 'application/json'})
            with self.opener.open(req, timeout=self.timeout) as response:
                data = response.read(32 * 1024 * 1024 + 1)
            if len(data) > 32 * 1024 * 1024:
                raise ValueError('response too large')
            result = json.loads(data)
            if not _valid_response(source, result, shape, required):
                raise ValueError('unexpected response schema')
            temp = path.with_suffix('.tmp')
            temp.write_text(json.dumps(result))
            temp.replace(path)
            self.last_fresh = True
            return result
        except (OSError, ValueError, TimeoutError, http.client.HTTPException) as exc:
            # Exception messages may contain credentials/URLs; record only class.
            self.gaps.append(f'{source}: fetch failed ({type(exc).__name__}); '
                             + ('using cached data' if cached is not None else 'no cached data'))
            return cached


def _valid_response(source, data, shape, required):
    if not isinstance(data, shape) or (required and required not in data):
        return False
    if isinstance(data, dict) and ('error' in data or 'code' in data):
        return False
    key = {'kev': 'vulnerabilities', 'nvd': 'vulnerabilities', 'osv': 'vulns'}.get(source)
    rows = data.get(key, []) if key else data
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        return False
    def structured(value):
        if isinstance(value, list):
            return all(structured(v) for v in value)
        if not isinstance(value, dict):
            return True
        lists = {'aliases', 'affected', 'ranges', 'events', 'references',
                 'vulnerabilities', 'vulns', 'configurations', 'nodes',
                 'children', 'cpeMatch', 'descriptions'}
        objects = {'package', 'database_specific', 'ecosystem_specific',
                   'metrics', 'cvssData', 'cve'}
        for key, child in value.items():
            if key in lists and not isinstance(child, list):
                return False
            if key in objects and not isinstance(child, dict):
                return False
            if key in lists - {'aliases'} and not all(isinstance(v, dict) for v in child):
                return False
            if key == 'aliases' and not all(isinstance(v, str) for v in child):
                return False
            if not structured(child):
                return False
        return True
    if not structured(data):
        return False
    if source == 'nvd':
        return all(isinstance(row.get('cve'), dict) for row in rows)
    if source == 'osv':
        return all(isinstance(row.get('id'), str) and
                   isinstance(row.get('aliases', []), list) and
                   isinstance(row.get('affected', []), list) for row in rows)
    if source == 'github':
        return all(isinstance(row.get('vulnerabilities', []), list) for row in rows)
    return True


def _and(values):
    return False if False in values else None if None in values else True


def _or(values):
    return True if True in values else None if None in values else False


def _version(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d+(?:\.\d+)*', value):
        return None
    parts = [int(x) for x in value.split('.')]
    while len(parts) > 1 and parts[-1] == 0:
        parts.pop()
    return tuple(parts)


def _compare(a, b):
    x, y = _version(a), _version(b)
    if x is None or y is None:
        return None
    length = max(len(x), len(y))
    x, y = x + (0,) * (length - len(x)), y + (0,) * (length - len(y))
    return (x > y) - (x < y)


def _bounds(version, match):
    if not version or version in ('*', '-', 'unknown'):
        return None
    results = []
    for key, op in [('versionStartIncluding', lambda c: c >= 0),
                    ('versionStartExcluding', lambda c: c > 0),
                    ('versionEndIncluding', lambda c: c <= 0),
                    ('versionEndExcluding', lambda c: c < 0)]:
        if key in match:
            c = _compare(version, match[key])
            results.append(None if c is None else op(c))
    return _and(results)


def _cpe(value):
    # Escaped separators and pattern matching need the full CPE algorithm.
    if not isinstance(value, str) or '\\' in value:
        return None
    fields = value.split(':')
    return fields[2:] if len(fields) == 13 and fields[:2] == ['cpe', '2.3'] else None


def _identity(a, b):
    return a[:3] == b[:3] and all(x not in ('*', '-') for x in a[:3])


def _leaf(match, asset, environment):
    criteria = _cpe(match.get('criteria', ''))
    if not criteria:
        return None, None
    target = any(_identity(criteria, p) for p in
                 filter(None, (_cpe(x) for x in asset.get('cpes', []))))
    results = []
    for candidate in environment:
        for value in candidate.get('cpes', []):
            cpe = _cpe(value)
            if not cpe or not _identity(criteria, cpe):
                continue
            checks = []
            version = cpe[3] if cpe[3] != '*' else candidate.get('version')
            if criteria[3] != '*':
                checks.append(None if not version or version in ('*', '-', 'unknown')
                              else version == criteria[3])
            else:
                checks.append(_bounds(version, match))
            if criteria[3] != '*':
                checks.append(_bounds(version, match))
            for expected, actual in zip(criteria[4:], cpe[4:]):
                if expected != '*':
                    checks.append(None if actual == '*' else expected == actual)
            results.append(_and(checks))
    truth = _or(results) if results else None
    # Proof of vulnerability must belong to this asset, not a sibling service.
    if match.get('vulnerable') is True and target:
        own_truth, _ = _leaf(dict(match, vulnerable=False), asset, [asset])
        hit = own_truth
    else:
        hit = False
    return truth, hit


def _node(node, asset, environment):
    children = [_leaf(m, asset, environment) for m in node.get('cpeMatch', [])]
    children += [_node(n, asset, environment) for n in node.get('nodes', [])]
    children += [_node(n, asset, environment) for n in node.get('children', [])]
    if not children or node.get('operator', 'OR') not in ('AND', 'OR'):
        return None, None
    truth = (_and if node.get('operator') == 'AND' else _or)([c[0] for c in children])
    hit = _or([c[1] for c in children])
    if node.get('operator') == 'AND':
        hit = _and([truth, hit])
    if node.get('negate'):
        return None if truth is None else not truth, None if hit is not False else False
    return truth, hit


def _fresh_observation(asset):
    if any(str(e).startswith('stale:') for e in asset.get('evidence', [])):
        return False
    if asset.get('observed_at'):
        age = datetime.now(timezone.utc) - datetime.fromisoformat(asset['observed_at'])
        return timedelta(0) <= age <= timedelta(hours=26)
    return True


def evaluate_nvd(cve, asset, assets):
    """Evaluate complete configuration trees with three-valued logic."""
    environment = [a for a in assets if _fresh_observation(a) and (a is asset or (
        asset.get('host') and a.get('host') == asset['host']))]
    configs = cve.get('configurations', [])
    if cve.get('vulnStatus') == 'Rejected' or not configs:
        return 'unknown'
    if not any(_identity(p, q)
               for p in filter(None, (_cpe(x) for x in asset.get('cpes', [])))
               for q in _vulnerable_cpes(cve)):
        return 'unknown'
    hit = _or([_node(n, asset, environment)[1] for n in configs])
    return 'affected' if hit is True else 'unaffected' if hit is False else 'unknown'


def _range(version, expression):
    if not isinstance(expression, str) or not expression.strip():
        return None
    clauses = []
    for clause in expression.split(','):
        m = re.fullmatch(r'\s*(<=|>=|<|>|=)?\s*(\d+(?:\.\d+)*)\s*', clause)
        if not m:
            return None
        comp = _compare(version, m[2])
        if comp is None:
            return None
        clauses.append({'<': comp < 0, '>': comp > 0, '<=': comp <= 0,
                        '>=': comp >= 0, '=': comp == 0}[m[1] or '='])
    return _and(clauses)


def _email_ids(config, gaps):
    if not config:
        return set()
    if (config.get('dedicated') is not True or config.get('host') not in config.get('allowed_hosts', [])
            or not config.get('recipient')):
        gaps.append('email: dedicated recipient and explicit allowed_hosts required')
        return set()
    ids = set()
    try:
        password = Path(config['password_file']).read_text().strip()
        with imaplib.IMAP4_SSL(config['host'], ssl_context=ssl.create_default_context(), timeout=15) as mailbox:
            mailbox.login(config['username'], password)
            status, _ = mailbox.select(config.get('folder', 'INBOX'), readonly=True)
            if status != 'OK':
                raise ValueError('select failed')
            recipient = config['recipient']
            if not re.fullmatch(r'[a-zA-Z0-9+_.@-]+', recipient):
                raise ValueError('invalid recipient')
            status, data = mailbox.uid('search', None, 'HEADER', 'Delivered-To', '"' + recipient + '"')
            if status != 'OK':
                raise ValueError('search failed')
            limit = max(1, min(200, int(config.get('max_messages', 50))))
            messages = data[0].split()
            if len(messages) > limit:
                gaps.append('email: message limit reached; older messages not evaluated')
            for uid in messages[-limit:]:
                status, headers = mailbox.uid('fetch', uid, '(BODY.PEEK[HEADER.FIELDS (DELIVERED-TO)])')
                if status != 'OK':
                    raise ValueError('header fetch failed')
                raw_headers = b''.join(p[1] for p in headers if isinstance(p, tuple) and isinstance(p[1], bytes))
                header = BytesParser().parsebytes(raw_headers, headersonly=True)
                delivered = {address.casefold() for _, address in getaddresses(header.get_all('Delivered-To', []))}
                if recipient.casefold() not in delivered:
                    continue
                status, parts = mailbox.uid('fetch', uid, '(BODY.PEEK[]<0.262144>)')
                if status != 'OK':
                    raise ValueError('fetch failed')
                for part in parts:
                    if isinstance(part, tuple) and isinstance(part[1], bytes):
                        ids.update(x.upper() for x in CVE.findall(part[1].decode('ascii', 'ignore')))
                        if len(part[1]) >= 262144:
                            gaps.append('email: oversized message truncated')
    except (OSError, ValueError, KeyError, imaplib.IMAP4.error):
        gaps.append('email: inbox read failed (details suppressed)')
    return ids


def _advisory(identifier, **fields):
    result = dict(id=identifier, aliases=[], severity='UNKNOWN', kev=False,
                  summary='', url='', fix='Review vendor advisory and verify a fixed version.',
                  affected=[], modified='')
    result.update(fields)
    for key in ('summary', 'url', 'fix', 'modified', 'severity'):
        result[key] = str(result[key] or ('UNKNOWN' if key == 'severity' else ''))
    result['severity'] = result['severity'].upper()
    return result


def _identifier(record):
    ids = [record.get('id', '')] + record.get('aliases', [])
    valid = [x for x in ids if isinstance(x, str) and ID.fullmatch(x)]
    return next((x.upper() for x in valid if x.upper().startswith('CVE-')),
                next(iter(valid), None))


def ingest(inventory: dict, config: dict, cache_dir: Path) -> dict:
    """Ingest feeds without treating candidate names as vulnerability evidence."""
    gaps, records = [], []
    if not config.get('email'):
        gaps.append('email: dedicated inbox ingestion is not configured')
    stats = dict(kev=0, osv=0, github=0, nvd=0, email=0)
    assets = inventory.get('assets', [])
    client = _Client(config, cache_dir, gaps)
    candidates = {}
    kev_entries = {}
    osv_results = {}
    incomplete_github = set()
    max_pages = max(1, min(20, int(config.get('max_pages', 10))))
    kev = client.get('kev', KEV, required='vulnerabilities')
    if kev:
        for entry in kev['vulnerabilities']:
            cid = entry.get('cveID', '')
            if not CVE.fullmatch(cid):
                continue
            kev_entries[cid] = entry
            stats['kev'] += 1
            names = {str(entry.get('product', '')).casefold(),
                     (str(entry.get('vendorProject', '')) + ' ' + str(entry.get('product', ''))).casefold()}
            for asset in assets:
                if not (asset.get('cpes') or asset.get('packages') or
                        config.get('product_aliases', {}).get(asset['id'])):
                    continue
                aliases = [asset.get('product', '')] + config.get('product_aliases', {}).get(asset['id'], [])
                if names.intersection(str(x).casefold() for x in aliases if x):
                    candidates.setdefault(cid, set()).add(asset['id'])
    for asset in assets:
        for package in asset.get('packages', []):
            results = osv_results.setdefault((asset['id'], package.get('ecosystem'), package.get('name')), [])
            if package.get('ecosystem') in ('Nix', 'Docker', 'OCI', 'generic'):
                results.append((package.get('version'), None))
                gaps.append(f"osv: unsupported ecosystem {package['ecosystem']} on {asset['id']}; map upstream package identity")
                continue
            if not all(package.get(k) and str(package[k]).casefold() not in ('unknown', '*', '-', 'latest', 'stable')
                       for k in ('ecosystem', 'name', 'version')):
                results.append((package.get('version'), None))
                gaps.append(f"osv: incomplete package identity/version on {asset['id']}")
                continue
            query = {k: package[k] for k in ('ecosystem', 'name')}
            payload = dict(package=query, version=package['version'])
            seen = set()
            complete = False
            fresh = True
            gap_count = len(gaps)
            for page in range(max_pages):
                response = client.get('osv', OSV, payload)
                fresh &= client.last_fresh
                if response is None:
                    gaps.append(f"osv: query unavailable for {asset['id']} {package['ecosystem']}/{package['name']}@{package['version']}")
                    break
                for vuln in response.get('vulns', []):
                    if vuln.get('withdrawn'):
                        continue
                    cid = _identifier(vuln)
                    if not cid:
                        gaps.append(f"osv: advisory without CVE/GHSA identifier on {asset['id']}")
                        continue
                    stats['osv'] += 1
                    seen.update([cid, vuln.get('id', ''), *vuln.get('aliases', [])])
                    fixed = sorted({str(e['fixed']) for a in vuln.get('affected', [])
                                    if a.get('package', {}).get('name') == package['name']
                                    and a.get('package', {}).get('ecosystem') == package['ecosystem']
                                    for r in a.get('ranges', []) for e in r.get('events', []) if e.get('fixed')})
                    record = _advisory(cid, aliases=[vuln.get('id', '')] + vuln.get('aliases', []),
                        summary=vuln.get('summary', ''), modified=vuln.get('modified', ''),
                        url='https://osv.dev/vulnerability/' + urllib.parse.quote(vuln['id'], safe=''),
                        severity=vuln.get('database_specific', {}).get('severity', 'UNKNOWN'))
                    if fixed:
                        record['fix'] = 'Vendor fixed versions (choose applicable branch): ' + ', '.join(fixed)
                    record['affected'] = [dict(asset_id=asset['id'], verdict='affected' if client.last_fresh else 'unknown',
                        source='osv', package=query,
                        evidence=f"OSV exact query: {package['ecosystem']}/{package['name']}@{package['version']}")]
                    if client.last_fresh:
                        record['osv_bindings'] = [dict(asset_id=asset['id'], **query)]
                    records.append(record)
                token = response.get('next_page_token')
                if not token:
                    complete = fresh and len(gaps) == gap_count
                    break
                payload['page_token'] = token
            else:
                gaps.append(f"osv: pagination limit reached on {asset['id']}")
            results.append((package['version'], seen if complete else None))
        for repo in sorted(set(config.get('repositories', {}).get(asset['id'], []) + asset.get('repositories', []))):
            if not isinstance(repo, str) or not re.fullmatch(r'[\w.-]+/[\w.-]+', repo):
                incomplete_github.add(asset['id'])
                gaps.append(f"github: invalid repository on {asset['id']}")
                continue
            for page in range(1, max_pages + 1):
                response = client.get('github', f'https://api.github.com/repos/{repo}/security-advisories?per_page=100&page={page}', shape=list)
                if response is None or not client.last_fresh:
                    incomplete_github.add(asset['id'])
                if response is None:
                    gaps.append(f"github: repository query unavailable for {asset['id']} {repo}")
                    break
                for advisory in response:
                    if advisory.get('withdrawn_at'):
                        continue
                    cid = advisory.get('cve_id') or advisory.get('ghsa_id')
                    if not cid or not ID.fullmatch(cid):
                        continue
                    stats['github'] += 1
                    verdicts = []
                    packages = []
                    fixes = []
                    for v in advisory.get('vulnerabilities', []):
                        p = v.get('package', {})
                        bindings = [x for x in config.get('vendor_packages', {}).get(asset['id'], []) + asset.get('vendor_packages', []) if x.get('repository') == repo]
                        versions = [x.get('version') for x in bindings if x.get('name') == p.get('name') and x.get('ecosystem') == p.get('ecosystem')]
                        versions += [x.get('version') for x in asset.get('packages', []) if
                                     x.get('name') == p.get('name') and x.get('ecosystem') == ECOSYSTEM.get(p.get('ecosystem'), p.get('ecosystem'))]
                        patched = v.get('patched_versions') or v.get('first_patched_version')
                        for version in versions:
                            packages.append((ECOSYSTEM.get(p.get('ecosystem'), p.get('ecosystem')), p.get('name'), version))
                            bounded = _range(version, v.get('vulnerable_version_range'))
                            fixed = patched.removeprefix('v') if isinstance(patched, str) else None
                            comparison = _compare(version, fixed)
                            if bounded is True and comparison is not None and comparison >= 0:
                                # Some vendor advisories leave the affected range open after a fix.
                                bounded = None
                            verdicts.append(bounded)
                        if patched:
                            fixes.append(str(patched))
                    proof = _or(verdicts) if verdicts else None
                    verdict = ('affected' if proof is True else 'unaffected' if proof is False else 'unknown') if client.last_fresh else 'unknown'
                    record = _advisory(cid, aliases=[advisory.get('ghsa_id', '')],
                        summary=advisory.get('summary', ''), url=advisory.get('html_url', ''),
                        modified=advisory.get('updated_at', ''), severity=advisory.get('severity', 'UNKNOWN'))
                    if fixes:
                        record['fix'] = 'Vendor patched versions: ' + ', '.join(fixes)
                    record['affected'] = [dict(asset_id=asset['id'], verdict=verdict,
                        source_fresh=client.last_fresh, packages=packages,
                        evidence=f'Configured vendor repository {repo}; package version bounds: {proof}')]
                    records.append(record)
                    if CVE.fullmatch(cid) and verdict == 'unknown':
                        candidates.setdefault(cid, set()).add(asset['id'])
                if len(response) < 100:
                    break
            else:
                incomplete_github.add(asset['id'])
                gaps.append(f'github: pagination limit reached for {repo}')
    tracked = {a['id']: a for a in config.get('_tracked_advisories', [])}
    bindings = {}
    for binding in config.get('_tracked_osv', []):
        bindings.setdefault((binding['advisory'], binding['asset']), []).append(binding)
    for (cid, asset_id), group in bindings.items():
        if not any(a['id'] == asset_id for a in assets):
            continue
        metadata = tracked.get(cid, _advisory(cid))
        names = {cid, *metadata.get('aliases', [])}
        verdicts = []
        packages = []
        for binding in group:
            results = osv_results.get((asset_id, binding['ecosystem'], binding['name']), [(None, None)])
            for version, seen in results:
                packages.append((binding['ecosystem'], binding['name'], version))
                verdicts.append(None if seen is None else bool(names.intersection(seen)))
        proof = _or(verdicts)
        verdict = 'affected' if proof is True else 'unaffected' if proof is False else 'unknown'
        if verdict == 'unaffected' and asset_id in incomplete_github:
            verdict = 'unknown'
        records.append(dict(metadata, affected=[dict(asset_id=asset_id, verdict=verdict,
            osv_exclusions=packages if verdict == 'unaffected' else [],
            evidence=f'OSV checks across all {len(group)} tracked package bindings: {verdict}'
                     + ('; GitHub repository coverage incomplete' if asset_id in incomplete_github else ''))]))
    email_ids = _email_ids(config.get('email'), gaps)
    stats['email'] = len(email_ids)
    for cid in email_ids | {c for c in config.get('cve_ids', []) if CVE.fullmatch(c)}:
        candidates.setdefault(cid.upper(), set()).update(a['id'] for a in assets)
    limit = max(0, min(200, int(config.get('max_nvd_queries', 50))))
    ordered = sorted(candidates.items(), key=lambda item: (
        kev_entries.get(item[0], {}).get('dateAdded', ''), item[0]), reverse=True)
    for index, (cid, asset_ids) in enumerate(ordered):
        entry = kev_entries.get(cid, {})
        response = client.get('nvd', NVD + '?cveId=' + cid, required='vulnerabilities') if index < limit else None
        if index >= limit:
            gaps.append(f'nvd: query budget exhausted for {cid}')
        cve = next((v['cve'] for v in (response or {}).get('vulnerabilities', []) if v.get('cve', {}).get('id') == cid), {})
        if cve:
            stats['nvd'] += 1
        record = _advisory(cid, kev=bool(entry), summary=entry.get('shortDescription', ''),
            url='https://nvd.nist.gov/vuln/detail/' + cid, modified=cve.get('lastModified', ''))
        if entry.get('requiredAction'):
            record['fix'] = entry['requiredAction']
        if not record['summary']:
            record['summary'] = next((d['value'] for d in cve.get('descriptions', []) if d.get('lang') == 'en'), '')
        metrics = cve.get('metrics', {})
        for kind in ('cvssMetricV40', 'cvssMetricV31', 'cvssMetricV30', 'cvssMetricV2'):
            if metrics.get(kind):
                metric = metrics[kind][0]
                record['severity'] = metric.get('cvssData', {}).get('baseSeverity', metric.get('baseSeverity', 'UNKNOWN'))
                break
        for asset in assets:
            if asset['id'] not in asset_ids:
                continue
            verdict = evaluate_nvd(cve, asset, assets) if cve and client.last_fresh else 'unknown'
            record['affected'].append(dict(asset_id=asset['id'], verdict=verdict,
                source_fresh=bool(cve) and client.last_fresh,
                evidence='NVD complete CPE configuration evaluation' if cve else 'Candidate only; NVD unavailable or not evaluated'))
        records.append(record)
    merged = []
    for record in records:
        names = {record['id'], *record['aliases']} - {''}
        matches = [old for old in merged if names.intersection({old['id'], *old['aliases']})]
        for old in matches:
            merged.remove(old)
            names.update([old['id'], *old['aliases']])
            record['affected'] += old['affected']
            record.setdefault('osv_bindings', []).extend(old.get('osv_bindings', []))
            record['kev'] |= old['kev']
            for key in ('summary', 'modified', 'url'):
                record[key] = record[key] or old[key]
            if record['severity'].upper() == 'UNKNOWN':
                record['severity'] = old['severity']
            if old['fix'] != _advisory('')['fix'] and record['fix'] == _advisory('')['fix']:
                record['fix'] = old['fix']
        record['id'] = next(iter(sorted(n for n in names if n.startswith('CVE-'))), record['id'])
        record['aliases'] = sorted(names - {record['id']})
        record['kev'] |= any(n in kev_entries for n in names)
        merged.append(record)
    for record in merged:
        exclusions = {item['asset_id']: set(map(tuple, item['osv_exclusions']))
                      for item in record['affected'] if item.get('osv_exclusions')}
        by_asset = {}
        for item in record['affected']:
            # Only complete tracked OSV exclusions can supersede fresh candidate checks.
            if (item['verdict'] == 'unknown' and item.get('source_fresh')
                    and item['asset_id'] in exclusions
                    and set(map(tuple, item.get('packages', []))) <= exclusions[item['asset_id']]):
                continue
            old = by_asset.get(item['asset_id'])
            rank = {'unaffected': 0, 'unknown': 1, 'affected': 2}
            if old is None or (rank[item['verdict']], bool(item.get('osv_exclusions'))) > (
                    rank[old['verdict']], bool(old.get('osv_exclusions'))):
                by_asset[item['asset_id']] = item
        record['affected'] = list(by_asset.values())
        for item in record['affected']:
            if item['verdict'] == 'unknown':
                gaps.append(f"{record['id']} on {item['asset_id']}: unverified applicability; {record['fix']}")
    for asset in assets:
        if not asset.get('packages') and not asset.get('cpes'):
            gaps.append(f"{asset['id']}: no package or CPE identity; feed coverage incomplete")
    return dict(advisories=sorted(merged, key=lambda x: x['id']), gaps=sorted(set(gaps)), stats=stats)


def _vulnerable_cpes(node):
    if isinstance(node, list):
        for child in node:
            yield from _vulnerable_cpes(child)
    elif isinstance(node, dict):
        if node.get('vulnerable') is True:
            cpe = _cpe(node.get('criteria', ''))
            if cpe:
                yield cpe
        for key in ('configurations', 'nodes', 'children', 'cpeMatch'):
            yield from _vulnerable_cpes(node.get(key, []))
