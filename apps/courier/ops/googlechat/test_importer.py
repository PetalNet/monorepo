from pathlib import Path
import subprocess
import sys
import unittest
from import_curl import CaptureError, COOKIE_FIELDS, parse_capture

ROOT = Path(__file__).resolve().parent
FIXTURE = (ROOT/'fixtures/firefox-fake.curl').read_text()


class ImporterTests(unittest.TestCase):
    def test_firefox_capture_preserves_current_cookie_values(self):
        result = parse_capture(FIXTURE)
        self.assertEqual(len(result.bridge_fields()), 16)
        self.assertEqual(result.bridge_fields()['compass'], 'dynamite-ui=FAKE-EXPIRED')
        self.assertEqual(result.bridge_fields()['secure_1psidts'], 'FAKE-OLD')
        self.assertNotIn('nid', result.bridge_fields())
        self.assertNotIn('FAKE', repr(result))

    def test_cookie_option(self):
        capture = FIXTURE.replace("-H 'Cookie: ", "--cookie '")
        self.assertEqual(parse_capture(capture).bridge_fields(), parse_capture(FIXTURE).bridge_fields())

    def test_case_insensitive_http_header(self):
        self.assertEqual(parse_capture(FIXTURE.replace('Cookie:', 'cOoKiE:')).bridge_fields(),
                         parse_capture(FIXTURE).bridge_fields())

    def test_cookie_values_with_equals(self):
        self.assertEqual(parse_capture(FIXTURE.replace('FAKE-OLD', 'FAKE=a=b')).bridge_fields()['secure_1psidts'], 'FAKE=a=b')

    def test_only_six_required(self):
        pairs = '; '.join(f'{name}=FAKE' for name in list(COOKIE_FIELDS)[:6])
        self.assertEqual(len(parse_capture(f"curl 'https://chat.google.com/' -b '{pairs}'").bridge_fields()), 6)

    def test_reject_bad_captures_without_input_in_errors(self):
        bad = {
            'shell command': FIXTURE + '; touch /tmp/SHOULD-NOT-EXIST',
            'newline executable': FIXTURE + '\ntouch /tmp/SHOULD-NOT-EXIST',
            'pipeline': FIXTURE + '| tee /tmp/SHOULD-NOT-EXIST',
            'redirect': FIXTURE + '> /tmp/SHOULD-NOT-EXIST',
            'substitution': FIXTURE.replace('FAKE-OLD', '$(touch /tmp/SHOULD-NOT-EXIST)'),
            'backticks': FIXTURE.replace('FAKE-OLD', '`id`'),
            'ansi c quotes': FIXTURE.replace("curl '", "curl $'", 1),
            'wrong host': FIXTURE.replace('chat.google.com', 'chat.google.com.evil.test'),
            'insecure URL': FIXTURE.replace('https://', 'http://'),
            'userinfo': FIXTURE.replace('https://', 'https://fake:password@'),
            'bad port': FIXTURE.replace('chat.google.com/', 'chat.google.com:no/'),
            'duplicate cookie': FIXTURE.replace('SSID=FAKE-SSID;', 'SSID=FAKE-SSID; SSID=other;'),
            'missing rotation': FIXTURE.replace('__Secure-1PSIDTS=FAKE-OLD; ', ''),
            'missing legacy': FIXTURE.replace('HSID=FAKE-HSID; ', ''),
            'wrong cookie casing': FIXTURE.replace('__Secure-1PSIDTS', '__SECURE-1PSIDTS'),
            'empty value': FIXTURE.replace('SID=FAKE-SID;', 'SID=;'),
            'file cookie': "curl 'https://chat.google.com/' -b @secrets",
            'file header': "curl 'https://chat.google.com/' -H @secrets",
            'file body': FIXTURE + ' --data-binary @secrets',
            'second URL': FIXTURE + " 'https://chat.google.com/'",
            'second header': FIXTURE + " -H 'Cookie: SID=second'",
            'unsupported output option': FIXTURE + ' --output /tmp/SHOULD-NOT-EXIST',
            'unclosed quote': FIXTURE + " '",
            'over limit': FIXTURE + 'x'*8192,
        }
        for label, capture in bad.items():
            with self.subTest(label=label), self.assertRaises(CaptureError) as caught:
                parse_capture(capture)
            self.assertNotIn('FAKE-', str(caught.exception))
            self.assertNotIn('password', str(caught.exception))

    def test_cli_never_emits_cookie_values(self):
        for capture, code in [(FIXTURE, 0), (FIXTURE+'; id', 2)]:
            proc = subprocess.run([sys.executable, str(ROOT/'import_curl.py')],
                                  input=capture, text=True, capture_output=True)
            self.assertEqual(proc.returncode, code)
            self.assertNotIn('FAKE-', proc.stdout+proc.stderr)
            self.assertNotIn('dynamite-ui', proc.stdout+proc.stderr)

    def test_expired_shaped_input_is_not_claimed_authenticated(self):
        summary = parse_capture(FIXTURE).summary()
        self.assertFalse(summary['account_verified'])
        self.assertEqual(summary['session_validity'], 'not_checked')
        self.assertFalse(summary['network_attempted'])


if __name__ == '__main__':
    unittest.main()
