#!/usr/bin/env python3
"""Exercise the bridge and CLI through live lab ntfy, with test speech and an ephemeral paired client."""

import asyncio
import json
from pathlib import Path
import sys
import unittest

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))
import ringing
from tests.test_ring import RingTest
from websockets.asyncio.client import connect

publish_real = ringing.publish

class LiveRing(RingTest):
    async def test_real_ntfy_and_command(self):
        self.mock_publish.side_effect = publish_real
        self.rings.timeout = 12
        config = self.dir / 'phone.toml'
        config.write_text(f'http_listen = "127.0.0.1:{self.http.server_port}"\nring_secret_file = "{self.dir / "root"}"\nring_timeout_s = 12\n')
        topic = self.rings.topic(self.device)
        async with connect('wss://ntfy.petalcat.dev/' + topic + '/ws', proxy=None) as wake:
            await asyncio.wait_for(wake.recv(), 8)
            async def command(reason):
                return await asyncio.create_subprocess_exec(sys.executable,
                    str(APP / 'janet_ring.py'),
                    '--config', str(config), reason, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            async def notice():
                while True:
                    event = json.loads(await asyncio.wait_for(wake.recv(), 15))
                    if event.get('event') == 'message':
                        data = json.loads(event['message'])
                        self.assertEqual(set(data), {'id', 'expires'})
                        return data['id']
            proc = await command('The water sensor needs your attention.')
            ident = await notice()
            pending = await self.post('/pending', {'id': ident})
            self.assertEqual(pending[1]['reason'], 'The water sensor needs your attention.')
            words, pcm = [], 0
            async with connect(self.url, additional_headers={**self.phone, 'X-Janet-Ring': ident}) as audio:
                async with asyncio.timeout(10):
                    while proc.returncode is None:
                        try:
                            message = await asyncio.wait_for(audio.recv(), .5)
                        except TimeoutError:
                            continue
                        if isinstance(message, bytes):
                            pcm += len(message)
                        else:
                            event = json.loads(message)
                            if event.get('type') == 'words':
                                words.append(event['text'])
                output, errors = await proc.communicate()
                self.assertEqual(proc.returncode, 0, errors.decode())
                self.assertGreater(pcm, 0)
                self.assertIn("I'm calling because: The water sensor needs your attention.", words)
                print(f'LIVE answer: {output.decode().strip()}; received PCM={pcm} bytes; reason spoken', flush=True)
            await asyncio.sleep(.1)
            proc = await command('Decline test')
            ident = await notice()
            self.assertEqual((await self.post('/decline', {'id': ident}))[0], 200)
            output, errors = await proc.communicate()
            self.assertEqual(proc.returncode, 1, errors.decode())
            print(f'LIVE decline: {output.decode().strip()}; exit={proc.returncode}', flush=True)
            self.rings.timeout = .5
            proc = await command('Timeout test')
            await notice()
            output, errors = await proc.communicate()
            self.assertEqual(proc.returncode, 1, errors.decode())
            self.assertIn('timeout', output.decode())
            print(f'LIVE timeout: {output.decode().strip()}; exit={proc.returncode}', flush=True)

if __name__ == '__main__':
    unittest.main(defaultTest='LiveRing.test_real_ntfy_and_command', verbosity=2)
