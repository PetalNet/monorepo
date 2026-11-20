import unittest
from unittest.mock import patch

import inventory


class InventoryTests(unittest.TestCase):
    def test_routing_and_actual_image_version(self):
        data = {'routers': [{'containers': ['web'], 'hosts': ['example.org']}],
                'all_containers': {'web': {'image': 'web:latest', 'image_id': 'sha256:old', 'state': 'running'},
                                   'db': {'image': 'db:15', 'image_id': 'sha256:db', 'state': 'running'}}}
        web, db = inventory.docker_assets(data, {'sha256:old': '1.2.3'})
        self.assertEqual(web['exposure'], 'internet')
        self.assertEqual(web['version'], '1.2.3')
        self.assertIn('actual image id: sha256:old', web['evidence'])
        self.assertEqual(db['exposure'], 'unknown')
        self.assertIsNone(db['version'])

    def test_ownership_repository_version_and_gateway(self):
        data = {'routers': [], 'all_containers': {
            'eli-web': {'image': 'ghcr.io/eli/server:latest', 'image_id': 'id', 'state': 'running'},
            'lishaduck-app': {'image': 'ghcr.io/lishaduck/app:latest', 'state': 'running'},
            'edge': {'image': 'traefik:v3', 'state': 'running'},
            'stopped': {'image': 'cloudflared:latest', 'state': 'exited'}}}
        web, app, edge, stopped = inventory.docker_assets(data, {'id': 'refs/tags/version/2026.5.7'})
        self.assertEqual((web['owner'], app['owner']), ('eli', 'eli'))
        self.assertEqual(web['image_repository'], 'ghcr.io/eli/server')
        self.assertEqual(web['version'], '2026.5.7')
        self.assertIn('actual image OCI version label: refs/tags/version/2026.5.7', web['evidence'])
        self.assertEqual(edge['exposure'], 'internet')
        self.assertEqual(stopped['exposure'], 'unknown')

    def test_failed_collection_preserves_previous_asset(self):
        old = inventory.asset('10.10.10.14', 'web', 'web', '1.0')
        old['observed_at'] = '2020-01-01T00:00:00+00:00'
        with patch.object(inventory, 'ssh', side_effect=OSError), patch.object(inventory, 'run', side_effect=OSError), patch.object(inventory.urllib.request, 'urlopen', side_effect=OSError):
            result = inventory.collect({'_previous_inventory': {'assets': [old]}})
        self.assertEqual(result['assets'][0]['version'], '1.0')
        self.assertEqual(result['assets'][0]['observed_at'], old['observed_at'])
        self.assertIn('stale: latest collection failed', result['assets'][0]['evidence'])
        self.assertTrue(any(g['host'] == '10.10.10.14' for g in result['gaps']))


if __name__ == '__main__':
    unittest.main()
