"""Exercise pinned bridge methods against a loopback HTTPS server and fake SQLite state."""
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import patch
import ast
import asyncio
import importlib.util
import json
import logging
import socket
import sqlite3
import ssl
import subprocess
import sys
import tempfile
import unittest

import aiohttp
from aiohttp import web
from yarl import URL
from import_curl import parse_capture

ROOT = Path(__file__).resolve().parent


def load_http(name, folder):
    package = ModuleType(name)
    package.__path__ = [str(folder/'maugclib')]
    sys.modules[name] = package
    spec = importlib.util.spec_from_file_location(name+'.http_utils', folder/'maugclib/http_utils.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


upstream = load_http('baseline_maugclib', ROOT/'sources/upstream')
modified = load_http('patched_maugclib', ROOT/'patched')


class LoopbackResolver(aiohttp.abc.AbstractResolver):
    async def resolve(self, host, port=0, family=socket.AF_INET):
        if host != 'chat.google.com':
            raise RuntimeError('Test DNS allows only the fake Chat endpoint')
        return [{'hostname': host, 'host': '127.0.0.1', 'port': port,
                 'family': socket.AF_INET, 'proto': 0, 'flags': 0}]

    async def close(self):
        pass


def isolated_methods(path, class_name, names):
    tree = ast.parse(path.read_text())
    cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == class_name)
    return [node for node in cls.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names]


def make_bridge_harness(client_factory):
    methods = isolated_methods(ROOT/'patched/mautrix_googlechat/user.py', 'User', {'connect'})
    methods += isolated_methods(ROOT/'patched/mautrix_googlechat/db/user.py', 'User', {'save', '_values'})
    tree = ast.Module(body=[ast.ClassDef(name='BridgeHarness', bases=[], keywords=[], body=methods, decorator_list=[])], type_ignores=[])
    ast.fix_missing_locations(tree)
    namespace = {'Client': client_factory, 'Cookies': modified.Cookies, 'asyncio': asyncio, 'json': json}
    exec(compile(tree, 'isolated_pinned_bridge_methods', 'exec'), namespace)
    return namespace['BridgeHarness']()


class RotationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=ROOT)
        cert, key = Path(self.tmp.name)/'cert.pem', Path(self.tmp.name)/'key.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                        '-keyout', str(key), '-out', str(cert), '-days', '1',
                        '-subj', '/CN=chat.google.com', '-addext', 'subjectAltName=DNS:chat.google.com'],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        server_ssl = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        server_ssl.load_cert_chain(cert, key)
        self.client_ssl = ssl.create_default_context(cafile=str(cert))
        self.requests = []
        self.counter = 0

        async def endpoint(request):
            self.requests.append(request.headers.get('Cookie', ''))
            response = web.Response(text='FAKE RESPONSE ONLY')
            if request.path == '/rotate':
                self.counter += 1
                response.set_cookie('__Secure-1PSIDTS', f'FAKE-ROTATED-{self.counter}',
                                    domain='.google.com', path='/', secure=True)
            if request.path == '/delete':
                response.del_cookie('__Secure-3PSIDCC', domain='.google.com', path='/')
            if request.path == '/delete-required':
                response.del_cookie('SID', domain='.google.com', path='/')
                response.set_cookie('__Secure-1PSIDTS', 'FAKE-ROTATED-AFTER-DELETE',
                                    domain='.google.com', path='/', secure=True)
            return response

        app = web.Application()
        app.router.add_get('/{tail:.*}', endpoint)
        self.runner = web.AppRunner(app, access_log=None)
        await self.runner.setup()
        site = web.TCPSite(self.runner, '127.0.0.1', 0, ssl_context=server_ssl)
        await site.start()
        self.port = site._server.sockets[0].getsockname()[1]
        self.base_url = f'https://chat.google.com:{self.port}'
        self.open_sessions = []
        self.fields = parse_capture((ROOT/'fixtures/firefox-fake.curl').read_text()).bridge_fields()

    async def asyncTearDown(self):
        for session in self.open_sessions:
            await session.close()
        await self.runner.cleanup()
        self.tmp.cleanup()

    def new_session(self, module=modified, fields=None):
        factory = aiohttp.ClientSession
        connector = aiohttp.TCPConnector(resolver=LoopbackResolver(), ssl=self.client_ssl)

        def local_client(**kwargs):
            kwargs['connector'] = connector
            kwargs['trust_env'] = False
            return factory(**kwargs)

        with patch.object(module.aiohttp, 'ClientSession', local_client):
            session = module.Session(module.Cookies(**(fields or self.fields)))
        self.open_sessions.append(session)
        return session

    async def test_baseline_rejects_extra_cookie_constructor(self):
        with self.assertRaises(TypeError):
            upstream.Cookies(**self.fields)

    async def test_imported_fields_pass_actual_login_handler(self):
        tree = ast.parse((ROOT/'patched/mautrix_googlechat/commands/auth.py').read_text())
        function = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == 'login_cookie')
        function.decorator_list = []
        code = ast.Module(body=[function], type_ignores=[])
        namespace = {'json': json, 'Cookies': modified.Cookies, 'CommandEvent': object,
                     'EventID': str, 'MForbidden': PermissionError,
                     'NotLoggedInError': modified.exceptions.NotLoggedInError}
        exec(compile(code, 'pinned_login_handler', 'exec'), namespace)
        received, replies = [], []
        future = asyncio.get_running_loop().create_future()
        future.set_result(None)
        async def connect(cookies):
            received.append(cookies)
            return True
        async def redact(*args):
            pass
        async def reply(message):
            replies.append(message)
        sender = SimpleNamespace(connect=connect, name_future=future, name='Fake',
                                 email='fake@example.invalid', gcid='FAKE-ID')
        event = SimpleNamespace(args=[json.dumps(self.fields)], sender=sender, reply=reply,
                                az=SimpleNamespace(intent=SimpleNamespace(redact=redact)),
                                room_id='!fake:example.invalid', event_id='$fake', log=logging.getLogger('fake'))
        await namespace['login_cookie'](event)
        self.assertEqual(received[0].secure_1psidts, 'FAKE-OLD')
        self.assertNotIn('FAKE-OLD', replies[0])
        event.args = [json.dumps({'unexpected': 'FAKE-DO-NOT-ECHO'})]
        await namespace['login_cookie'](event)
        self.assertEqual(replies[-1], 'Invalid cookie fields')
        self.assertNotIn('FAKE-DO-NOT-ECHO', replies[-1])

    async def test_baseline_drops_rotated_cookie_from_persistence(self):
        fields = {name: self.fields[name] for name in upstream.Cookies._fields}
        session = self.new_session(upstream, fields)
        await session.fetch('GET', self.base_url+'/rotate')
        self.assertEqual(session._cookie_jar.filter_cookies(URL(self.base_url))['__Secure-1PSIDTS'].value,
                         'FAKE-ROTATED-1')
        self.assertNotIn('secure_1psidts', session.get_auth_cookies()._asdict())

    async def test_rotation_notifies_before_response_is_returned(self):
        session = self.new_session()
        saved = []
        async def save(cookies):
            saved.append(cookies)
        session.on_cookies_changed.add_observer(save)
        await session.fetch('GET', self.base_url+'/rotate')
        self.assertEqual(saved[-1].secure_1psidts, 'FAKE-ROTATED-1')
        jar_entries = [c for c in session._cookie_jar if c.key == '__Secure-1PSIDTS']
        self.assertEqual(len(jar_entries), 1)
        self.assertEqual(jar_entries[0]['domain'], 'google.com')
        await session.fetch('GET', self.base_url+'/check')
        self.assertIn('__Secure-1PSIDTS=FAKE-ROTATED-1', self.requests[-1])
        self.assertNotIn('__Secure-1PSIDTS=FAKE-OLD', self.requests[-1])
        self.assertEqual(len(saved), 1)

    async def test_legacy_stored_json_remains_loadable(self):
        fields = {name: self.fields[name] for name in upstream.Cookies._fields}
        session = self.new_session(fields=fields)
        self.assertIsNone(session.get_auth_cookies().secure_1psidts)
        self.assertNotIn('__Secure-1PSIDTS', session._cookie_jar.filter_cookies(URL(self.base_url)))

    async def test_cookie_deletion_is_preserved(self):
        session = self.new_session()
        saved = []
        async def save(cookies):
            saved.append(cookies)
        session.on_cookies_changed.add_observer(save)
        await session.fetch('GET', self.base_url+'/delete')
        self.assertIsNone(saved[-1].secure_3psidcc)
        restored = self.new_session(fields=json.loads(json.dumps(saved[-1]._asdict())))
        self.assertNotIn('__Secure-3PSIDCC', restored._cookie_jar.filter_cookies(URL(self.base_url)))

    async def test_concurrent_rotations_keep_latest_saved_state(self):
        session = self.new_session()
        saved = []
        async def save(cookies):
            await asyncio.sleep(0.01)
            saved.append(cookies.secure_1psidts)
        session.on_cookies_changed.add_observer(save)
        await asyncio.gather(*(session.fetch('GET', self.base_url+'/rotate') for _ in range(4)))
        self.assertEqual(saved[-1], 'FAKE-ROTATED-4')
        self.assertEqual(session.get_auth_cookies().secure_1psidts, saved[-1])

    async def test_required_deletion_and_rotation_persist_before_auth_failure(self):
        session = self.new_session()
        db = sqlite3.connect(':memory:')
        self.addCleanup(db.close)
        db.execute('create table state (cookies text)')
        db.execute('insert into state values (?)', (json.dumps(self.fields),))

        async def save(cookies):
            db.execute('update state set cookies=?', (json.dumps(cookies._asdict()),))
            db.commit()

        session.on_cookies_changed.add_observer(save)
        with self.assertRaises(modified.exceptions.NotLoggedInError):
            await session.fetch('GET', self.base_url+'/delete-required')
        persisted = json.loads(db.execute('select cookies from state').fetchone()[0])
        self.assertIsNone(persisted['sid'])
        self.assertEqual(persisted['secure_1psidts'], 'FAKE-ROTATED-AFTER-DELETE')
        restored = self.new_session(fields=persisted)
        with self.assertRaises(modified.exceptions.NotLoggedInError):
            restored.get_auth_cookies()
        jar = restored._cookie_jar.filter_cookies(URL(self.base_url))
        self.assertNotIn('SID', jar)
        self.assertEqual(jar['__Secure-1PSIDTS'].value, 'FAKE-ROTATED-AFTER-DELETE')

    async def test_failed_save_does_not_mark_cookie_durable(self):
        session = self.new_session()
        calls = []
        async def failing_save(cookies):
            calls.append(cookies.secure_1psidts)
            raise OSError('FAKE DATABASE FAILURE')
        session.on_cookies_changed.add_observer(failing_save)
        with self.assertRaises(OSError):
            await session.fetch('GET', self.base_url+'/rotate')
        self.assertEqual(session._last_auth_cookies.secure_1psidts, 'FAKE-OLD')
        session.on_cookies_changed.remove_observer(failing_save)
        async def save(cookies):
            calls.append(cookies.secure_1psidts)
        session.on_cookies_changed.add_observer(save)
        await session.fetch('GET', self.base_url+'/check')
        self.assertEqual(session._last_auth_cookies.secure_1psidts, 'FAKE-ROTATED-1')

    async def test_real_bridge_connect_save_and_sqlite_restart_roundtrip(self):
        sessions = []
        outer = self
        class LocalClient:
            def __init__(self, cookies, **kwargs):
                self._session = outer.new_session(fields=cookies._asdict())
                sessions.append(self._session)
                self.on_cookies_changed = self._session.on_cookies_changed
                for name in ['on_stream_event', 'on_connect', 'on_reconnect', 'on_disconnect']:
                    setattr(self, name, modified.Event(name))
            async def refresh_tokens(self):
                await self._session.fetch('GET', outer.base_url+'/rotate')
            @property
            def cookies(self):
                return self._session.get_auth_cookies()

        db = sqlite3.connect(':memory:')
        self.addCleanup(db.close)
        db.execute('CREATE TABLE user (mxid TEXT PRIMARY KEY, gcid TEXT, cookies TEXT, user_agent TEXT, notice_room TEXT, revision INTEGER)')
        db.execute('INSERT INTO user(mxid) VALUES (?)', ('@fake:test.invalid',))
        class DB:
            async def execute(self, query, *values):
                db.execute(query, {str(i): value for i, value in enumerate(values, 1)})
                db.commit()
        user = make_bridge_harness(LocalClient)
        user.mxid, user.gcid = '@fake:test.invalid', 'FAKE-ID'
        user.cookies = None
        user.client = None
        user.user_agent = user.notice_room = user.revision = None
        user.periodic_sync_task = None
        user.db = DB()
        user.log = logging.getLogger('fake-bridge')
        async def no_op(*args):
            pass
        user.start = user._periodic_sync = no_op
        for name in ['on_stream_event', 'on_connect', 'on_reconnect', 'on_disconnect']:
            setattr(user, name, no_op)
        self.assertTrue(await user.connect(modified.Cookies(**self.fields)))
        await user.conn_task
        await user.periodic_sync_task
        initial = json.loads(db.execute('SELECT cookies FROM user').fetchone()[0])
        self.assertEqual(initial['secure_1psidts'], 'FAKE-ROTATED-1')
        await sessions[0].fetch('GET', self.base_url+'/rotate')
        stored = json.loads(db.execute('SELECT cookies FROM user').fetchone()[0])
        self.assertEqual(stored['secure_1psidts'], 'FAKE-ROTATED-2')
        self.assertEqual(stored['secure_3psidts'], 'FAKE-3PSIDTS')
        restarted = self.new_session(fields=stored)
        await restarted.fetch('GET', self.base_url+'/check')
        self.assertEqual(self.requests[-1].count('__Secure-1PSIDTS='), 1)
        self.assertIn('__Secure-1PSIDTS=FAKE-ROTATED-2', self.requests[-1])

    async def test_refresh_failure_persists_rotations_before_client_is_installed(self):
        for endpoint, error, replacement in [
            ('/rotate', KeyError, False),
            ('/delete-required', modified.exceptions.NotLoggedInError, False),
            ('/rotate', KeyError, True),
            ('/delete-required', modified.exceptions.NotLoggedInError, True),
        ]:
            with self.subTest(endpoint=endpoint, replacement=replacement):
                outer = self
                sessions = []

                class LocalClient:
                    def __init__(self, cookies, **kwargs):
                        self._session = outer.new_session(fields=cookies._asdict())
                        sessions.append(self._session)
                        self.on_cookies_changed = self._session.on_cookies_changed

                    async def refresh_tokens(self):
                        await self._session.fetch('GET', outer.base_url+endpoint)
                        raise KeyError('FAKE missing WIZ response')

                db = sqlite3.connect(':memory:')
                self.addCleanup(db.close)
                db.execute('CREATE TABLE user (mxid TEXT PRIMARY KEY, gcid TEXT, cookies TEXT, user_agent TEXT, notice_room TEXT, revision INTEGER)')
                db.execute('INSERT INTO user(mxid,cookies) VALUES (?,?)',
                           ('@fake:test.invalid', json.dumps(self.fields)))

                class DB:
                    async def execute(self, query, *values):
                        db.execute(query, {str(i): value for i, value in enumerate(values, 1)})
                        db.commit()

                user = make_bridge_harness(LocalClient)
                user.mxid, user.gcid = '@fake:test.invalid', 'FAKE-ID'
                user.cookies = modified.Cookies(**self.fields)
                previous_client = object()
                user.client = previous_client
                user.user_agent = user.notice_room = user.revision = None
                user.db = DB()
                user.log = logging.getLogger('fake-refresh')
                candidate = modified.Cookies(**{**self.fields, 'ssid': 'FAKE-NEW-SSID'}) if replacement else None
                with self.assertRaises(error):
                    await user.connect(candidate)
                self.assertIs(user.client, previous_client)
                stored = json.loads(db.execute('SELECT cookies FROM user').fetchone()[0])
                expected = self.fields['secure_1psidts'] if replacement else (
                    'FAKE-ROTATED-AFTER-DELETE' if endpoint.endswith('required') else f'FAKE-ROTATED-{self.counter}')
                self.assertEqual(stored['secure_1psidts'], expected)
                if replacement:
                    self.assertEqual(stored, self.fields)
                    self.assertEqual(user.cookies._asdict(), self.fields)
                restored = self.new_session(fields=stored)
                jar = restored._cookie_jar.filter_cookies(URL(self.base_url))
                self.assertEqual(jar['__Secure-1PSIDTS'].value, expected)
                if endpoint.endswith('required') and not replacement:
                    self.assertNotIn('SID', jar)
                elif not endpoint.endswith('required'):
                    from http.cookies import SimpleCookie
                    late = SimpleCookie()
                    late['__Secure-1PSIDTS'] = 'FAKE-LATE-FAILED-CLIENT'
                    late['__Secure-1PSIDTS'].update({'domain': '.google.com', 'path': '/'})
                    sessions[0]._cookie_jar.update_cookies(late, URL(self.base_url))
                    await sessions[0]._on_request_end(None, None, None)
                    self.assertEqual(json.loads(db.execute('SELECT cookies FROM user').fetchone()[0])['secure_1psidts'], expected)


if __name__ == '__main__':
    unittest.main()
