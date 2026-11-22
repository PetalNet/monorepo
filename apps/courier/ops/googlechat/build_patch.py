"""Regenerate the proposed bot-only patch from the pinned public source."""
from pathlib import Path
import difflib
import pprint
import shutil
import subprocess
from import_curl import COOKIE_FIELDS

ROOT = Path(__file__).resolve().parent
BASE = ROOT / 'sources/upstream'
TARGET = ROOT / 'patched'
SHA = 'a835bccd269eace6c28196a3f869eb1fb3c8acf7'
assert subprocess.check_output(['git', '-C', str(BASE), 'rev-parse', 'HEAD'], text=True).strip() == SHA
shutil.copytree(BASE, TARGET, ignore=shutil.ignore_patterns('.git', '__pycache__'), dirs_exist_ok=True)


def replace_once(source, old, new):
    assert source.count(old) == 1, 'Pinned source does not match patch input'
    return source.replace(old, new, 1)


path = TARGET / 'maugclib/http_utils.py'
s = path.read_text()
s = replace_once(s, 'from . import exceptions', 'from . import exceptions\nfrom .event import Event')
extra = ''.join(f'    {field}: str | None = None\n' for field in list(COOKIE_FIELDS.values())[5:])
s = replace_once(s, '    hsid: str\n', '    hsid: str\n' + extra)
for field in list(COOKIE_FIELDS.values())[:5]:
    s = replace_once(s, f'    {field}: str\n', f'    {field}: str | None\n')
wire = {field: name for name, field in COOKIE_FIELDS.items()}
s = replace_once(s, 'chat_google_com = URL', 'COOKIE_NAMES = ' + pprint.pformat(wire, sort_dicts=False) + '\n\n\nchat_google_com = URL')
s = replace_once(s, '        self._proxy = proxy\n', '''        self._proxy = proxy
        self.on_cookies_changed = Event("Session.on_cookies_changed")
        self._cookie_save_lock = asyncio.Lock()
        self._last_auth_cookies = cookies
''')
s = replace_once(s, '''            cookie[key.upper()] = value
            cookie[key.upper()].update({"domain": "chat.google.com", "path": "/"})''', '''            if value is None:
                continue
            name = COOKIE_NAMES[key]
            cookie[name] = value
            domain = "chat.google.com" if key in {"compass", "osid"} else "google.com"
            cookie[name].update({"domain": domain, "path": "/", "secure": True})''')
s = replace_once(s, '        timeout = aiohttp.ClientTimeout(connect=CONNECT_TIMEOUT)', '''        trace = aiohttp.TraceConfig()
        trace.on_request_end.append(self._on_request_end)
        trace.on_request_exception.append(self._on_request_end)
        timeout = aiohttp.ClientTimeout(connect=CONNECT_TIMEOUT)''')
s = replace_once(s, '            cookie_jar=self._cookie_jar,', '            cookie_jar=self._cookie_jar,\n            trace_configs=[trace],')
s = replace_once(s, '''    def get_auth_cookies(self) -> Cookies:
        vals = {}
        cookie = self._cookie_jar.filter_cookies(chat_google_com)
        for field in Cookies._fields:
            vals[field] = cookie[field.upper()].value
        return Cookies(**vals)''', '''    def get_auth_cookies(self) -> Cookies:
        cookies = self._auth_cookie_snapshot()
        if any(not getattr(cookies, field) for field in ("compass", "ssid", "sid", "osid", "hsid")):
            raise exceptions.NotLoggedInError("Required auth cookie is missing")
        return cookies

    def _auth_cookie_snapshot(self) -> Cookies:
        vals = {}
        cookie = self._cookie_jar.filter_cookies(chat_google_com)
        for field in Cookies._fields:
            value = cookie.get(COOKIE_NAMES[field])
            vals[field] = value.value if value else None
        return Cookies(**vals)''')
s = replace_once(s, '    def get_cookie(', '''    async def _on_request_end(self, session, context, params) -> None:
        async with self._cookie_save_lock:
            cookies = self._auth_cookie_snapshot()
            if cookies != self._last_auth_cookies:
                await self.on_cookies_changed.fire(cookies)
                self._last_auth_cookies = cookies
            self.get_auth_cookies()

    def get_cookie(''')
# Auth cookies must not traverse an unverified TLS connection.
s = replace_once(s, '            ssl=False,', '            ssl=True,')
path.write_text(s)

path = TARGET / 'maugclib/client.py'
s = path.read_text()
s = replace_once(s, '''            cookies, user_agent=user_agent, proxy=os.environ.get("HTTP_PROXY")
        )''', '''            cookies, user_agent=user_agent, proxy=os.environ.get("HTTP_PROXY")
        )
        self.on_cookies_changed = self._session.on_cookies_changed''')
path.write_text(s)

path = TARGET / 'mautrix_googlechat/user.py'
s = path.read_text()
s = replace_once(s, '''        await client.refresh_tokens()
        self.client = client''', '''        refreshing = True

        async def save_rotated_cookies(updated: Cookies) -> None:
            if not refreshing and self.client is not client:
                return
            self.cookies = updated
            await self.save()

        client.on_cookies_changed.add_observer(save_rotated_cookies)
        try:
            await client.refresh_tokens()
        finally:
            refreshing = False
        self.client = client''')
path.write_text(s)

path = TARGET / 'mautrix_googlechat/commands/auth.py'
s = path.read_text()
s = replace_once(s, '''        await evt.sender.connect(Cookies(**{k.lower(): v for k, v in data.items()}))''', '''        cookies = Cookies(**{k.lower(): v for k, v in data.items()})
        if any(value is not None and not isinstance(value, str) for value in cookies):
            return await evt.reply("Cookie values must be strings")
    except (TypeError, AttributeError):
        return await evt.reply("Invalid cookie fields")

    try:
        await evt.sender.connect(cookies)''')
path.write_text(s)

patch = []
for name in ['maugclib/http_utils.py', 'maugclib/client.py', 'mautrix_googlechat/user.py', 'mautrix_googlechat/commands/auth.py']:
    patch.extend(difflib.unified_diff((BASE/name).read_text().splitlines(True),
                                    (TARGET/name).read_text().splitlines(True),
                                    fromfile='a/'+name, tofile='b/'+name))
(ROOT/'consumer-cookie-rotation.patch').write_text(''.join(patch))
print('Generated patch against ' + SHA)
