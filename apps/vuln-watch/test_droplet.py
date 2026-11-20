import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import droplet
import inventory


def snapshot():
    return {'distro': {'ID': 'ubuntu', 'VERSION_ID': '24.04'}, 'kernel': '6.8.0-147-generic',
            'cpu_flags': ['avx2'], 'packages': [{'name': 'libssl3t64:amd64', 'version': '3.0.13-0ubuntu3.6',
                                             'source': 'openssl', 'source_version': '3.0.13-0ubuntu3.6'}],
            'upgradable': 'Listing...\n', 'security_updates': [], 'sshd': {'tunnel': {'gatewayports': 'no'}},
            'containers': [{'name': 'caddy', 'repository': 'caddy', 'version': '2.11.7',
                            'image_id': 'sha256:old', 'image': 'caddy:latest', 'state': 'running', 'network': 'host'}],
            'binaries': {'caddy': '2.11.7'}, 'jvms': [], 'gaps': []}


class DropletTests(unittest.TestCase):
    def test_java_version_reads_metadata_without_executing_process(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(droplet.subprocess, 'run') as execute:
            release = Path(directory) / 'release'
            release.write_text('JAVA_VERSION="21.0.13"\nEVIL=ignored\n')
            self.assertEqual(droplet.java_version(release), '21.0.13')
            release.unlink()
            self.assertIsNone(droplet.java_version(release))
            os.mkfifo(release)
            self.assertIsNone(droplet.java_version(release))
            release.unlink()
            release.write_bytes(b'\xff')
            self.assertIsNone(droplet.java_version(release))
        execute.assert_not_called()

    def test_observed_versions_posture_and_existing_identity(self):
        ssh = Mock(return_value=json.dumps(snapshot()))
        items, gaps = droplet.collect({'host': 'edge', 'ssh': 'root@edge', 'identity_file': '~/.ssh/existing'}, ssh)
        by_id = {i['service']: i for i in items}
        self.assertTrue(all(i['exposure'] == 'internet' and i['owner'] == 'parker' for i in items))
        self.assertEqual(by_id['kernel']['version'], '6.8.0-147-generic')
        self.assertEqual(by_id['package:libssl3t64:amd64']['source_package'], 'openssl')
        self.assertEqual(by_id['package:libssl3t64:amd64']['version'], '3.0.13-0ubuntu3.6')
        self.assertEqual(by_id['container:caddy']['version'], '2.11.7')
        self.assertIn('actual image id: sha256:old', by_id['container:caddy']['evidence'])
        self.assertEqual(by_id['os']['posture']['sshd']['tunnel']['gatewayports'], 'no')
        self.assertNotIn('packages', by_id['os']['posture'])
        self.assertTrue(any('backport' in g['reason'] for g in gaps))
        self.assertEqual(ssh.call_args.kwargs['identity_file'], '~/.ssh/existing')

    def test_runtime_java_is_not_assumed_absent(self):
        data = snapshot()
        data['jvms'] = [{'pid': '42', 'version': '21.0.10'}]
        items, _ = droplet.collect({'host': 'edge', 'ssh': 'root@edge'}, Mock(return_value=json.dumps(data)))
        java = next(i for i in items if i['product'] == 'java')
        self.assertEqual(java['version'], '21.0.10')
        self.assertEqual(java['cpu_flags'], ['avx2'])
        self.assertFalse(java['runtime_flags_verified'])

    def test_failed_edge_retains_prior_observation(self):
        old = inventory.asset('edge', 'kernel', 'linux-kernel', '6.8.0-147-generic')
        old['observed_at'] = '2020-01-01T00:00:00+00:00'
        with patch.object(inventory, 'ssh', side_effect=OSError), patch.object(inventory, 'run', side_effect=OSError), \
                patch.object(inventory.urllib.request, 'urlopen', side_effect=OSError):
            result = inventory.collect({'inventory': {'droplets': [{'host': 'edge', 'ssh': 'root@edge'}]},
                                        '_previous_inventory': {'assets': [old]}})
        self.assertEqual(result['assets'][0]['observed_at'], old['observed_at'])
        self.assertIn('stale: latest collection failed', result['assets'][0]['evidence'])
        self.assertTrue(any(g['host'] == 'edge' for g in result['gaps']))

    def test_identity_is_an_ssh_argument(self):
        with patch.object(inventory, 'run') as run:
            inventory.ssh('root@edge', 'uname -r', identity_file='/path/key with spaces')
        args = run.call_args.args[0]
        self.assertIn('/path/key with spaces', args)
        self.assertEqual(args[-2:], ['root@edge', 'uname -r'])
