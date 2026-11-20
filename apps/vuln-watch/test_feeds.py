"""Offline boundary tests, including saved public Caddy advisory responses."""
import copy
import imaplib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import feeds
import watcher

CID = 'CVE-2026-99999'
APP = 'cpe:2.3:a:vendor:widget:*:*:*:*:*:*:*:*'
OS = 'cpe:2.3:o:vendor:system:10:*:*:*:*:*:*:*'


def asset(identifier='one', version='1.2.3', **extra):
    return dict(id=identifier, host='host-' + identifier, product='Widget', version=version,
                cpes=[APP], packages=[], **extra)


def leaf(cpe=APP, vulnerable=True, **bounds):
    return dict(criteria=cpe, vulnerable=vulnerable, **bounds)


def cve(*nodes):
    return dict(id=CID, configurations=[dict(nodes=list(nodes))])


def kev(product='Widget'):
    return dict(vulnerabilities=[dict(cveID=CID, product=product, vendorProject='Vendor',
        shortDescription='Synthetic test only', requiredAction='Apply vendor update')])


class FeedTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name)

    def run_ingest(self, assets, *, catalog=None, nvd=None, osv=None, github=None, config=None):
        calls = []

        def get(client, source, url, payload=None, **kwargs):
            calls.append((source, url, payload))
            if source == 'kev':
                return catalog or {'vulnerabilities': []}
            if source == 'nvd':
                if callable(nvd):
                    return nvd(url)
                return {'vulnerabilities': [{'cve': nvd}]} if nvd else None
            if source == 'osv':
                return osv(payload) if callable(osv) else osv or {}
            if source == 'github':
                return github or []
            self.fail(source)

        with patch.object(feeds._Client, 'get', get):
            result = feeds.ingest({'assets': assets}, config or {}, self.path)
        return result, calls

    def test_irrelevant_kev_is_excluded_and_not_queried(self):
        result, calls = self.run_ingest([asset()], catalog=kev('Other Product'))
        self.assertEqual([], result['advisories'])
        self.assertEqual(['kev'], [x[0] for x in calls])

    def test_kev_alias_without_range_is_unknown_with_action(self):
        result, _ = self.run_ingest([asset()], catalog=kev())
        record = result['advisories'][0]
        self.assertEqual('unknown', record['affected'][0]['verdict'])
        self.assertTrue(record['kev'])
        self.assertEqual('Apply vendor update', record['fix'])
        self.assertTrue(any(CID in gap for gap in result['gaps']))

    def test_unknown_version_cannot_prove_affected(self):
        for version in (None, '', 'unknown', '*', '-'):
            with self.subTest(version=version):
                a = asset(version=version)
                result = feeds.evaluate_nvd(cve(dict(cpeMatch=[leaf(versionEndExcluding='2.0')])), a, [a])
                self.assertEqual('unknown', result)

    def test_numeric_versions_and_exclusive_boundaries(self):
        record = cve(dict(cpeMatch=[leaf(versionStartIncluding='1.2.3', versionEndExcluding='1.10')]))
        for version, expected in [('1.2.2', 'unaffected'), ('1.2.3', 'affected'),
                                  ('1.9', 'affected'), ('1.10', 'unaffected'),
                                  ('1.3-rc1', 'unknown')]:
            with self.subTest(version=version):
                a = asset(version=version)
                self.assertEqual(expected, feeds.evaluate_nvd(record, a, [a]))

    def test_nested_and_environment_cannot_be_ignored(self):
        record = cve(dict(operator='AND', nodes=[
            dict(operator='OR', cpeMatch=[leaf(versionEndExcluding='2')]),
            dict(operator='OR', cpeMatch=[leaf(OS, vulnerable=False)])]))
        a = asset()
        self.assertEqual('unknown', feeds.evaluate_nvd(record, a, [a]))
        env = dict(id='os', host=a['host'], cpes=[OS], version='10')
        self.assertEqual('affected', feeds.evaluate_nvd(record, a, [a, env]))
        env['host'] = 'another-host'
        self.assertEqual('unknown', feeds.evaluate_nvd(record, a, [a, env]))
        env['host'] = a['host']
        env['cpes'] = [OS.replace(':10:', ':11:')]
        self.assertEqual('unaffected', feeds.evaluate_nvd(record, a, [a, env]))

    def test_or_environment_alone_cannot_prove_target_affected(self):
        a = asset(version='3')
        a['cpes'].append(OS)
        record = cve(dict(operator='OR', cpeMatch=[leaf(versionEndExcluding='2'), leaf(OS, False)]))
        self.assertEqual('unaffected', feeds.evaluate_nvd(record, a, [a]))

    def test_sibling_service_does_not_supply_target_vulnerable_version(self):
        a, b = asset(version='3'), asset('two', '1')
        b['host'] = a['host']
        record = cve(dict(cpeMatch=[leaf(versionEndExcluding='2')]))
        self.assertEqual('unaffected', feeds.evaluate_nvd(record, a, [a, b]))

    def test_osv_exact_query_only_affects_queried_asset_and_merges_alias(self):
        a, b = asset(), asset('two')
        a['packages'] = [dict(ecosystem='PyPI', name='widget', version='1.2.3')]
        b['packages'] = [dict(ecosystem='PyPI', name='widget', version='3.0')]
        queries = []

        def response(payload):
            queries.append(payload)
            if payload['version'] == '3.0':
                return {}
            return {'vulns': [dict(id='GHSA-2345-6789-abcd', aliases=[CID], summary='Test',
                affected=[dict(package=dict(ecosystem='PyPI', name='widget'),
                               ranges=[dict(events=[dict(fixed='2.0')])])])]}

        result, _ = self.run_ingest([a, b], osv=response, catalog=kev('Other Product'))
        self.assertEqual(dict(package=dict(ecosystem='PyPI', name='widget'), version='1.2.3'), queries[0])
        record = result['advisories'][0]
        self.assertEqual(CID, record['id'])
        self.assertEqual(['GHSA-2345-6789-abcd'], record['aliases'])
        self.assertEqual(['one'], [x['asset_id'] for x in record['affected']])
        self.assertEqual('affected', record['affected'][0]['verdict'])
        self.assertTrue(record['kev'])
        self.assertIn('2.0', record['fix'])

    def test_vendor_bounds_require_explicit_package_binding(self):
        advisory = dict(ghsa_id='GHSA-2345-6789-abcd', vulnerabilities=[dict(
            package=dict(ecosystem='pip', name='widget'), vulnerable_version_range='>= 1, < 2',
            patched_versions='2.0')])
        config = dict(repositories={'one': ['vendor/widget']})
        result, _ = self.run_ingest([asset()], github=[advisory], config=config)
        self.assertEqual('unknown', result['advisories'][0]['affected'][0]['verdict'])
        config['vendor_packages'] = {'one': [dict(repository='vendor/widget', ecosystem='pip', name='widget', version='1.2')]}
        result, _ = self.run_ingest([asset()], github=[advisory], config=config)
        self.assertEqual('affected', result['advisories'][0]['affected'][0]['verdict'])

    def test_unsupported_vendor_range_is_unknown(self):
        for expression in ('^1.2', '< 2 || >= 3', '*', '', None):
            self.assertIsNone(feeds._range('1.2', expression))

    def test_no_description_matching(self):
        a = asset()
        record = cve(dict(cpeMatch=[leaf(APP.replace(':widget:', ':other:'))]))
        record['descriptions'] = [dict(lang='en', value='Widget 1.2.3 affected')]
        result, _ = self.run_ingest([a], catalog=kev(), nvd=record)
        self.assertEqual('unknown', result['advisories'][0]['affected'][0]['verdict'])

    def test_cache_failure_preserves_bytes_and_reports_gap(self):
        gaps = []
        client = feeds._Client({'cache_ttl': 0}, self.path, gaps)
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(kev()).encode()
        with patch.object(client.opener, 'open', return_value=response):
            self.assertEqual(kev(), client.get('kev', feeds.KEV, required='vulnerabilities'))
        path = next(self.path.glob('*.json'))
        before = path.read_bytes()
        for effect in (OSError('secret must not leak'), None):
            with self.subTest(effect=effect):
                if effect:
                    context = patch.object(client.opener, 'open', side_effect=effect)
                else:
                    response.__enter__.return_value.read.return_value = b'{broken'
                    context = patch.object(client.opener, 'open', return_value=response)
                with context:
                    self.assertEqual(kev(), client.get('kev', feeds.KEV, required='vulnerabilities'))
                self.assertEqual(before, path.read_bytes())
        self.assertEqual(2, len(gaps))
        self.assertNotIn('secret', ' '.join(gaps))

    def test_nvd_public_requests_are_paced(self):
        client = feeds._Client({'cache_ttl': 0}, self.path, [])
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'{"vulnerabilities": []}'
        with patch.object(client.opener, 'open', return_value=response), \
             patch.object(feeds.time, 'monotonic', return_value=100), \
             patch.object(feeds.time, 'sleep') as sleep:
            client.get('nvd', feeds.NVD + '?cveId=' + CID)
            client.get('nvd', feeds.NVD + '?cveId=CVE-2026-99998')
        self.assertAlmostEqual(6.1, sleep.call_args_list[1].args[0])

    def test_network_endpoint_allowlist_including_redirects(self):
        for url in ('http://api.osv.dev/v1/query', 'https://evil.test/',
                    'https://api.osv.dev/evil', 'https://api.osv.dev@evil.test/v1/query',
                    'https://user:password@api.osv.dev/v1/query'):
            self.assertFalse(feeds._allowed(url))
        handler = feeds._Redirects()
        with self.assertRaises(ValueError):
            handler.redirect_request(None, None, 302, '', {}, 'http://169.254.169.254/')

    def test_email_requires_dedicated_and_uses_readonly_peek(self):
        gaps = []
        with patch.object(imaplib, 'IMAP4_SSL') as factory:
            self.assertEqual(set(), feeds._email_ids(dict(host='mail.test'), gaps))
            factory.assert_not_called()
        password = self.path / 'password'
        password.write_text('private')
        mailbox = MagicMock()
        mailbox.select.return_value = ('OK', [])
        mailbox.uid.side_effect = [('OK', [b'1']),
            ('OK', [(b'1', b'Delivered-To: lab+vulns@mail.test\r\n\r\n')]),
            ('OK', [(b'1', (CID + ' private body').encode())])]
        factory = MagicMock()
        factory.return_value.__enter__.return_value = mailbox
        with patch.object(imaplib, 'IMAP4_SSL', factory):
            ids = feeds._email_ids(dict(host='mail.test', allowed_hosts=['mail.test'], dedicated=True,
                username='lab', password_file=str(password), recipient='lab+vulns@mail.test'), gaps)
        self.assertEqual({CID}, ids)
        mailbox.select.assert_called_once_with('INBOX', readonly=True)
        self.assertEqual(('search', None, 'HEADER', 'Delivered-To', '"lab+vulns@mail.test"'), mailbox.uid.call_args_list[0].args)
        self.assertEqual(('fetch', b'1', '(BODY.PEEK[]<0.262144>)'), mailbox.uid.call_args.args)
        self.assertNotIn('private', ' '.join(gaps))

    def test_substring_recipient_never_reads_body(self):
        password = self.path / 'password'
        password.write_text('private')
        mailbox = MagicMock()
        mailbox.select.return_value = ('OK', [])
        mailbox.uid.side_effect = [('OK', [b'1']), ('OK', [(b'1', b'Delivered-To: other-vulns@example.com\r\n\r\n')])]
        factory = MagicMock()
        factory.return_value.__enter__.return_value = mailbox
        with patch.object(imaplib, 'IMAP4_SSL', factory):
            ids = feeds._email_ids(dict(host='mail.test', allowed_hosts=['mail.test'], dedicated=True,
                username='lab', password_file=str(password), recipient='vulns@example.com'), [])
        self.assertEqual(set(), ids)
        self.assertEqual(2, mailbox.uid.call_count)

    def test_stale_environment_cannot_disprove_affected_application(self):
        app = asset()
        system = asset('os', '3.0')
        system.update(host=app['host'], cpes=['cpe:2.3:o:vendor:system:*:*:*:*:*:*:*:*'],
                      observed_at='2020-01-01T00:00:00+00:00')
        record = cve(dict(operator='AND', cpeMatch=[leaf(versionEndExcluding='2.0'),
            leaf('cpe:2.3:o:vendor:system:*:*:*:*:*:*:*:*', False, versionEndExcluding='2.0')]))
        self.assertEqual('unknown', feeds.evaluate_nvd(record, app, [app, system]))

    def test_stale_nvd_cache_produces_unknown_check(self):
        a = asset(version='3.0')
        def get(client, source, url, **kwargs):
            if source == 'kev':
                return kev()
            client.last_fresh = False
            return {'vulnerabilities': [{'cve': cve(dict(cpeMatch=[leaf(versionEndExcluding='2.0')]))}]}
        with patch.object(feeds._Client, 'get', get):
            result = feeds.ingest({'assets': [a]}, {}, self.path)
        self.assertEqual('unknown', result['advisories'][0]['affected'][0]['verdict'])

    def test_complete_osv_exclusion_resolves_prior_coordinate(self):
        a = asset(version='2.0')
        a['packages'] = [dict(ecosystem='PyPI', name='widget', version='2.0')]
        config = {'_tracked_advisories': [feeds._advisory(CID, affected=[
            dict(asset_id=a['id'], verdict='affected', evidence='OSV exact query: PyPI/widget@1.0')])],
            '_tracked_osv': [dict(advisory=CID, asset=a['id'], ecosystem='PyPI', name='widget')]}
        result, _ = self.run_ingest([a], config=config)
        self.assertEqual('unaffected', result['advisories'][0]['affected'][0]['verdict'])

    def test_unavailable_second_osv_binding_cannot_resolve(self):
        a = asset(version='2.0')
        a['packages'] = [dict(ecosystem='PyPI', name=n, version='2.0') for n in ['first', 'second']]
        config = {'_tracked_advisories': [feeds._advisory(CID)], '_tracked_osv': [
            dict(advisory=CID, asset=a['id'], ecosystem='PyPI', name=n) for n in ['first', 'second']]}
        def get(client, source, url, payload=None, **kwargs):
            if source == 'kev':
                return {'vulnerabilities': []}
            return {} if payload['package']['name'] == 'first' else None
        with patch.object(feeds._Client, 'get', get):
            result = feeds.ingest({'assets': [a]}, config, self.path)
        self.assertEqual('unknown', result['advisories'][0]['affected'][0]['verdict'])

    def test_saved_caddy_exclusions_close_tracked_findings(self):
        fixture = json.loads(Path(__file__).with_name('fixtures').joinpath('caddy-reconciliation.json').read_text())
        a = asset(version=fixture['query']['version'])
        a.update(service='caddy', product='caddy', exposure='internet',
                 cpes=['cpe:2.3:a:caddyserver:caddy:*:*:*:*:*:*:*:*'],
                 evidence=['saved runtime observation'])
        a['packages'] = [dict(fixture['query']['package'], version=a['version'])]
        config = {'repositories': {a['id']: ['caddyserver/caddy']}}
        db = watcher.database(self.path / 'coverage.sqlite')
        self.addCleanup(db.close)
        at = watcher.now()
        inv = dict(collected_at=at, assets=[a], gaps=[])
        original = []
        for row in fixture['github']:
            cid = row.get('cve_id') or row['ghsa_id']
            original.append(feeds._advisory(cid, aliases=[row['ghsa_id']], affected=[dict(
                asset_id=a['id'], verdict='affected', source='osv',
                package=fixture['query']['package'], evidence='OSV exact query at 2.11.2')]))
        watcher.reconcile(db, inv, dict(advisories=original), at, emit_digest=False)
        config['_tracked_advisories'] = [json.loads(r[0]) for r in db.execute('SELECT payload FROM advisories')]
        config['_tracked_osv'] = [dict(r) for r in db.execute('SELECT * FROM osv_tracking')]
        result, _ = self.run_ingest([a], osv=fixture['osv'], github=fixture['github'], config=config,
                                  nvd=lambda url: fixture['nvd'][url.split('cveId=')[1]])
        summary = watcher.reconcile(db, inv, result, at, emit_digest=False)
        self.assertEqual((7, 0), (summary['closed'], summary['open']))
        self.assertTrue(all('all 1 tracked package bindings: unaffected' in r['evidence']
                            for r in watcher.report(db)['items']))

    def test_osv_negative_precedence_requires_complete_fresh_bindings(self):
        package = dict(ecosystem='PyPI', name='widget', version='2.0')
        advisory = dict(cve_id=CID, ghsa_id='GHSA-2345-6789-abcd', vulnerabilities=[dict(
            package=dict(ecosystem='pip', name='widget'), vulnerable_version_range='^1')])
        base = {'repositories': {'one': ['vendor/widget']},
                '_tracked_advisories': [feeds._advisory(CID, aliases=[advisory['ghsa_id']])],
                '_tracked_osv': [dict(advisory=CID, asset='one', ecosystem='PyPI', name='widget')]}
        cases = ['complete', 'second_complete', 'stale_osv', 'stale_github', 'stale_nvd', 'failed_osv',
                 'failed_nvd', 'missing_version', 'missing_binding', 'second_binding',
                 'duplicate_versions', 'duplicate_missing_version', 'affected',
                 'github_extra_package', 'github_other_version', 'untracked_advisory',
                 'pagination_limit', 'stale_page', 'github_affected', 'nvd_affected',
                 'duplicate_versions_reverse', 'duplicate_missing_version_reverse',
                 'github_later_failure', 'github_missing', 'github_stale_empty',
                 'github_pagination_limit', 'github_stale_lastpage', 'github_later_success']
        for case in cases:
            with self.subTest(case=case):
                a = asset(version='2.0')
                a['packages'] = [dict(package)]
                config = copy.deepcopy(base)
                github = copy.deepcopy(advisory)
                if case == 'missing_version':
                    a['packages'][0]['version'] = None
                if case in ('missing_binding', 'second_binding', 'second_complete'):
                    config['_tracked_osv'].append(dict(advisory=CID, asset='one', ecosystem='PyPI', name='other'))
                    if case != 'missing_binding':
                        a['packages'].append(dict(package, name='other'))
                if case.startswith('duplicate_'):
                    a['packages'].insert(0, dict(package, version=None if 'missing_version' in case else '1.0'))
                    if case.endswith('_reverse'):
                        a['packages'].reverse()
                if case == 'github_affected':
                    github['vulnerabilities'][0]['vulnerable_version_range'] = '>= 1, < 3'
                if case == 'github_extra_package':
                    github['vulnerabilities'].append(dict(package=dict(ecosystem='pip', name='other')))
                    a['packages'].append(dict(package, name='other'))
                if case == 'github_other_version':
                    config['vendor_packages'] = {'one': [dict(repository='vendor/widget', ecosystem='pip', name='widget', version='1.0')]}
                if case == 'untracked_advisory':
                    config['_tracked_osv'][0]['advisory'] = 'CVE-2026-99998'
                if case in ('pagination_limit', 'github_pagination_limit'):
                    config['max_pages'] = 1

                def get(client, source, url, payload=None, **kwargs):
                    client.last_fresh = case != 'stale_' + source
                    if source == 'kev':
                        return {'vulnerabilities': []}
                    if source == 'github':
                        if case == 'github_missing':
                            return None
                        if case == 'github_stale_empty':
                            client.last_fresh = False
                            return []
                        if case in ('github_later_failure', 'github_pagination_limit',
                                    'github_stale_lastpage', 'github_later_success'):
                            if url.endswith('page=1'):
                                return [github] * 100
                            if case == 'github_later_failure':
                                return None
                            client.last_fresh = case != 'github_stale_lastpage'
                            return []
                        return [github]
                    if source == 'nvd':
                        if case == 'failed_nvd':
                            return None
                        if case == 'nvd_affected':
                            return {'vulnerabilities': [dict(cve=cve(dict(cpeMatch=[leaf(versionEndExcluding='3')])))]}
                        return {'vulnerabilities': [dict(cve=dict(id=CID))]}
                    if case == 'failed_osv' or (case == 'second_binding' and payload['package']['name'] == 'other'):
                        return None
                    if case == 'pagination_limit':
                        return {'next_page_token': 'next'}
                    if case == 'stale_page' and 'page_token' not in payload:
                        client.last_fresh = False
                        return {'next_page_token': 'next'}
                    if case == 'affected' or (case.startswith('duplicate_versions') and payload['version'] == '1.0'):
                        return {'vulns': [dict(id=CID)]}
                    return {}

                with patch.object(feeds._Client, 'get', get):
                    result = feeds.ingest({'assets': [a]}, config, self.path)
                record = next(r for r in result['advisories'] if r['id'] == CID)
                expected = ('unaffected' if case in ('complete', 'second_complete', 'github_later_success') else
                            'affected' if case in ('affected', 'duplicate_versions', 'duplicate_versions_reverse',
                                                  'github_affected', 'nvd_affected') else 'unknown')
                self.assertEqual(expected, record['affected'][0]['verdict'])

    def test_stale_empty_osv_cache_alone_cannot_prove_remediation(self):
        a = asset(version='2.0')
        a['packages'] = [dict(ecosystem='PyPI', name='widget', version='2.0')]
        config = {'_tracked_osv': [dict(advisory=CID, asset=a['id'], ecosystem='PyPI', name='widget')]}

        def get(client, source, url, payload=None, **kwargs):
            client.last_fresh = source != 'osv'
            return {'vulnerabilities': []} if source == 'kev' else {}

        with patch.object(feeds._Client, 'get', get):
            result = feeds.ingest({'assets': [a]}, config, self.path)
        self.assertEqual('unknown', result['advisories'][0]['affected'][0]['verdict'])

    def test_vendor_open_range_conflicting_with_fixed_release_is_unknown(self):
        a = asset(version='11.17.4')
        a['packages'] = [dict(ecosystem='npm', name='directus', version='11.17.4')]
        advisory = dict(ghsa_id='GHSA-g65h-35f3-x2w3', cve_id='CVE-2024-34709', vulnerabilities=[
            dict(package=dict(ecosystem='npm', name='directus'),
                 vulnerable_version_range='>=10.10.0', patched_versions='10.11.0')])
        result, _ = self.run_ingest([a], github=[advisory], config={'repositories': {a['id']: ['directus/directus']}})
        self.assertEqual('unknown', result['advisories'][0]['affected'][0]['verdict'])

    def test_query_budget_reports_unknown(self):
        result, calls = self.run_ingest([asset()], catalog=kev(), config={'max_nvd_queries': 0})
        self.assertNotIn('nvd', [x[0] for x in calls])
        self.assertEqual('unknown', result['advisories'][0]['affected'][0]['verdict'])
        self.assertTrue(any('budget exhausted' in x for x in result['gaps']))

    def test_nix_package_is_a_mapping_gap_not_an_empty_coverage_success(self):
        a = asset()
        a['packages'] = [dict(ecosystem='Nix', name='openssl', version='3.0')]
        result, calls = self.run_ingest([a])
        self.assertEqual(['kev'], [c[0] for c in calls])
        self.assertTrue(any('unsupported ecosystem Nix' in x for x in result['gaps']))

    def test_missing_cpe_identity_is_unknown_even_with_description(self):
        a = asset()
        a['cpes'] = []
        self.assertEqual('unknown', feeds.evaluate_nvd(cve(dict(cpeMatch=[leaf()])), a, [a]))

    def test_invalid_schema_does_not_replace_cache(self):
        client = feeds._Client({'cache_ttl': 0}, self.path, [])
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(kev()).encode()
        with patch.object(client.opener, 'open', return_value=response):
            client.get('kev', feeds.KEV, required='vulnerabilities')
            response.__enter__.return_value.read.return_value = b'{"vulnerabilities": "bad"}'
            self.assertEqual(kev(), client.get('kev', feeds.KEV, required='vulnerabilities'))
        self.assertEqual(kev(), json.loads(next(self.path.glob('*.json')).read_text()))

    def test_osv_pagination_is_followed(self):
        a = asset()
        a['packages'] = [dict(ecosystem='PyPI', name='widget', version='1.2.3')]
        def response(payload):
            if 'page_token' not in payload:
                return {'next_page_token': 'next'}
            return {'vulns': [dict(id=CID)]}
        result, calls = self.run_ingest([a], osv=response)
        self.assertEqual(CID, result['advisories'][0]['id'])
        self.assertEqual(2, len([c for c in calls if c[0] == 'osv']))


if __name__ == '__main__':
    unittest.main()
