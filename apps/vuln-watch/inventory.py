#!/usr/bin/env python3
"""Collect a read-only inventory. Optional config.inventory keys: docker_ssh,
minecraft_ssh, ha_ssh, truenas_ssh and proxmox_ssh. SSH aliases are accepted.
The CLI retains the previous output when a source cannot be refreshed.
"""
import argparse
import datetime
import json
import os
import re
import shlex
import subprocess
import tempfile
import ssl
import urllib.request
import urllib.parse
from pathlib import Path

import droplet


def run(args, timeout=90):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=True)
    return result.stdout


def ssh(host, command, timeout=90, identity_file=None):
    identity = ['-i', str(Path(identity_file).expanduser()), '-o', 'IdentitiesOnly=yes'] if identity_file else []
    return run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', *identity, host, command], timeout)


def asset(host, service, product, version=None, **kwargs):
    return dict(id=f'{host}:{service}', host=host, service=service, product=product,
                version=version, exposure='unknown', evidence=[], packages=[], cpes=[],
                cpu_flags=None, mitigations=[], owner='unknown', **kwargs)


def docker_assets(data, labels):
    routes = {}
    owners = {}
    for router in data['routers']:
        for name in router.get('containers', []):
            routes.setdefault(name, []).extend(router.get('hosts', []))
        for detail in router.get('container_details', []):
            if detail.get('hard_exclusion'):
                owners[detail['name']] = detail['hard_exclusion']
    assets = []
    for name, info in data['all_containers'].items():
        image = info.get('image') or 'unknown'
        image_id = info.get('image_id')
        repository = image.split('@')[0]
        if ':' in repository.rsplit('/', 1)[-1]:
            repository = repository.rsplit(':', 1)[0]
        product = repository.rsplit('/', 1)[-1]
        original_version = labels.get(image_id) or None
        version = original_version.removeprefix('refs/tags/version/') if original_version else None
        item = asset('10.10.10.14', name, product, version)
        item['image_repository'] = repository
        item['owner'] = 'eli' if name.lower().startswith(('eli-', 'lishaduck-')) else owners.get(name, 'unknown')
        item['evidence'] = [f'configured image: {image}', f'container state: {info.get("state", "unknown")}']
        if image_id:
            item['evidence'].append(f'actual image id: {image_id}')
        if version:
            item['evidence'].append('actual image OCI version label: ' + original_version)
        if info.get('state') == 'running' and product.lower() in ('traefik', 'cloudflared'):
            item['exposure'] = 'internet'
            item['evidence'].append('running internet gateway: ' + product)
        if routes.get(name):
            item['exposure'] = 'internet'
            item['evidence'].append('Traefik routes: ' + ', '.join(sorted(set(routes[name]))))
        assets.append(item)
    return assets


def collect(config):
    settings = config.get('inventory', {})
    assets, gaps, failed = [], [], set()
    observed_at = datetime.datetime.now(datetime.timezone.utc).isoformat()

    def source(host, fn):
        try:
            assets.extend(fn())
        except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError) as exc:
            failed.add(host)
            detail = f'collection failed: {type(exc).__name__}'
            if isinstance(exc, subprocess.CalledProcessError):
                detail += f' (exit {exc.returncode})'
            gaps.append({'host': host, 'reason': detail})

    def docker():
        target = settings.get('docker_ssh', 'docker@10.10.10.14')
        template = '[{"Config":{"Image":{{json .Config.Image}},"Labels":{"com.docker.compose.project":{{json (index .Config.Labels "com.docker.compose.project")}},"com.docker.compose.project.working_dir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"com.docker.compose.project.config_files":{{json (index .Config.Labels "com.docker.compose.project.config_files")}},"com.docker.compose.service":{{json (index .Config.Labels "com.docker.compose.service")}}}},"State":{"Status":{{json .State.Status}},"Restarting":{{json .State.Restarting}}},"NetworkSettings":{"Ports":{{json .NetworkSettings.Ports}}},"Image":{{json .Image}}}]'
        original = '["docker", "inspect", n]'
        replacement = repr(['docker', 'inspect', '--format', template])[:-1] + ', n]'
        remote = "p=__import__('os').path.expanduser('~/.claude/shared/derek/final_inventory.py'); s=open(p).read(); old=" + repr(original) + "; new=" + repr(replacement) + "; assert old in s; exec(compile(s.replace(old,new),p,'exec'))"
        data = json.loads(ssh(target, 'python3 -c ' + shlex.quote(remote), 180))
        ids = sorted({v.get('image_id') for v in data['all_containers'].values() if v.get('image_id') and re.fullmatch(r'sha256:[0-9a-f]{64}', v['image_id'])})
        labels = {}
        if ids:
            try:
                output = ssh(target, "for id in " + ' '.join(ids) + "; do docker image inspect --format '{{.Id}} {{index .Config.Labels \"org.opencontainers.image.version\"}}' \"$id\" 2>/dev/null || :; done", 90)
                for line in output.splitlines():
                    fields = line.split(maxsplit=1)
                    if len(fields) == 2 and fields[1] not in ('<no value>', '<nil>'):
                        labels[fields[0]] = fields[1]
            except (OSError, subprocess.SubprocessError):
                gaps.append({'host': '10.10.10.14', 'reason': 'image version labels unavailable'})
        for router in data['routers']:
            if router.get('backend_kind', '').startswith('remote_'):
                gaps.append({'host': '10.10.10.14', 'reason': 'unmapped remote Traefik backend: ' + str(urllib.parse.urlsplit(router.get('backend_url') or '').hostname or 'unknown')})
        result = docker_assets(data, labels)
        binaries = {'traefik': ['traefik', 'version'], 'lab-traefik': ['traefik', 'version'],
                    'cloudflared': ['cloudflared', '--version'], 'lishaduck-cloudflared': ['cloudflared', '--version'],
                    'jellyfin': ['jellyfin', '--version']}
        for item in result:
            if item['product'].lower() not in binaries or 'container state: running' not in item['evidence']:
                continue
            try:
                output = ssh(target, shlex.join(['docker', 'exec', item['service'], *binaries[item['product'].lower()]]), 20)
                match = re.search(r'(?<![0-9])([0-9]+\.[0-9]+\.[0-9]+(?:[.+~-][A-Za-z0-9.+~-]+)?)', output)
                if match:
                    item['version'] = match.group(1)
                    item['evidence'].append('runtime version from docker exec: ' + item['version'])
                    if item['product'].lower() in ('lab-traefik', 'lishaduck-cloudflared'):
                        item['exposure'] = 'internet'
                        item['evidence'].append('running internet gateway binary')
            except (OSError, subprocess.SubprocessError):
                gaps.append({'host': item['host'], 'reason': item['service'] + ': runtime version unavailable'})
        missing = sum(item['version'] is None for item in result)
        if missing:
            gaps.append({'host': '10.10.10.14', 'reason': f'{missing} containers have no available OCI version label'})
        return result

    def nix():
        paths = run(['nix-store', '--query', '--requisites', '/run/current-system'], 120).splitlines()
        items = []
        for path in paths:
            match = re.match(r'^/nix/store/[a-z0-9]{32}-(.+?)-([0-9][A-Za-z0-9.+_~-]*)$', path)
            if match:
                name, version = match.groups()
                item = asset('202', 'nix:' + path.rsplit('/', 1)[-1], name, version)
                item['evidence'] = ['NixOS system closure: ' + path]
                items.append(item)
        if not items:
            raise ValueError('empty NixOS closure')
        gaps.append({'host': '202', 'reason': 'Nix closure packages lack a supported OSV ecosystem mapping'})
        return items

    def minecraft():
        script = r'''import json, os, re, subprocess
for pid in os.listdir('/proc'):
    if not pid.isdigit():
        continue
    try:
        exe = os.readlink('/proc/' + pid + '/exe')
        if not re.search(r'(^|/)java$', exe):
            continue
        args = open('/proc/' + pid + '/cmdline', 'rb').read().split(b'\0')
        if not any(b'minecraft' in arg.lower() or b'paper' in arg.lower() or b'fabric' in arg.lower() for arg in args):
            continue
        version = subprocess.run(['/proc/' + pid + '/exe', '-version'], capture_output=True, text=True, check=True).stderr
        verified = False
        flags = []
        try:
            effective = subprocess.run([os.path.join(os.path.dirname(exe), 'jcmd'), pid, 'VM.flags'],
                                       capture_output=True, text=True, timeout=5, check=True).stdout
            flags = re.findall(r'(?<!\S)-XX:(?:-UseBASE64Intrinsics|UseAVX=[012])(?=\s|$)', effective)
            verified = True
        except (OSError, subprocess.SubprocessError):
            pass
        cpu = next(line.split(':', 1)[1].split() for line in open('/proc/cpuinfo') if line.startswith('flags'))
        print(json.dumps({'version': version, 'mitigations': flags, 'runtime_flags_verified': verified, 'cpu_flags': cpu}))
        break
    except (OSError, subprocess.SubprocessError, StopIteration):
        continue
else:
    raise SystemExit(1)
'''
        output = ssh(settings.get('minecraft_ssh', 'docker@10.10.10.14'), 'ssh -o BatchMode=yes -o ConnectTimeout=5 mc34 ' + shlex.quote('python3 -c ' + shlex.quote(script)), 30)
        data = json.loads(output)
        match = re.search(r'version "([^"]+)"', data['version'])
        if not match or not data['cpu_flags']:
            raise ValueError('Java or CPU flags unavailable')
        item = asset('10.10.10.34', 'java', 'java', match.group(1))
        item['cpu_flags'] = data['cpu_flags']
        item['mitigations'] = data['mitigations']
        item['runtime_flags_verified'] = data['runtime_flags_verified']
        item['evidence'] = ['running Minecraft JVM /proc/pid/exe -version', '/proc/cpuinfo flags',
                            'effective JVM flags verified with jcmd' if data['runtime_flags_verified'] else 'effective JVM flags unavailable']
        return [item]

    def api(url, token, verify=True):
        request = urllib.request.Request(url, headers={'Authorization': token}, method='GET')
        context = None if verify else ssl._create_unverified_context()
        with urllib.request.urlopen(request, timeout=20, context=context) as response:
            return json.load(response)

    def truenas():
        token = Path(settings.get('truenas_token_file', '/home/agent/.claude/shared/truenas-api-key')).read_text().strip()
        data = api(settings.get('truenas_url', 'http://10.10.10.12/api/v2.0') + '/system/info', 'Bearer ' + token, settings.get('tls_verify', True))
        item = asset('10.10.10.12', 'truenas', 'truenas', data.get('version'))
        item['evidence'] = ['TrueNAS system/info API']
        return [item]

    def proxmox():
        token = Path(settings.get('proxmox_token_file', '/home/agent/.claude/shared/proxmox-janet-token')).read_text().strip()
        base = settings.get('proxmox_url', 'https://10.10.10.10:8006/api2/json')
        auth = token if token.startswith('PVEAPIToken=') else 'PVEAPIToken=' + token
        verify = settings.get('tls_verify', True)
        packages = api(base + '/nodes/rackdaddy/apt/versions', auth, verify)['data']
        status = api(base + '/nodes/rackdaddy/status', auth, verify)['data']
        items = []
        seen = {}
        for package in packages:
            name, version = package.get('Package'), package.get('Version')
            if name and version:
                if name in seen:
                    if seen[name]['version'] != version:
                        seen[name]['version'] = None
                        gaps.append({'host': 'proxmox', 'reason': name + ': conflicting installed version records'})
                    continue
                item = asset('proxmox', 'package:' + name, name, version)
                item['evidence'] = ['Proxmox apt/versions limited package subset']
                items.append(item)
                seen[name] = item
        kernel = status.get('kversion') or status.get('current-kernel', {}).get('release')
        item = asset('proxmox', 'kernel', 'linux-kernel', kernel)
        item['evidence'] = ['Proxmox node status API']
        items.append(item)
        gaps.append({'host': 'proxmox', 'reason': 'apt/versions provides only a limited installed package subset'})
        return items

    source('10.10.10.14', docker)
    source('202', nix)
    source('10.10.10.34', minecraft)
    def home_assistant():
        output = ssh(settings.get('ha_ssh', 'haos'), 'ha core info --raw-json', 30)
        version = json.loads(output).get('data', {}).get('version')
        item = asset('10.10.10.11', 'home-assistant', 'home-assistant', version)
        item['evidence'] = ['Home Assistant core info']
        return [item]

    source('10.10.10.11', home_assistant)
    source('10.10.10.12', truenas)
    source('proxmox', proxmox)
    for edge in settings.get('droplets', []):
        def collect_edge():
            items, edge_gaps = droplet.collect(edge, ssh)
            gaps.extend(edge_gaps)
            return items
        source(edge['host'], collect_edge)
    for item in assets:
        item['observed_at'] = observed_at
        if not item.get('version'):
            gaps.append({'host': item['host'], 'reason': item['id'] + ': version unknown'})
        if not item.get('packages') and not item.get('cpes'):
            gaps.append({'host': item['host'], 'reason': item['id'] + ': product unmapped to package or CPE'})

    for old in config.get('_previous_inventory', {}).get('assets', []):
        if old.get('host') in failed:
            stale = dict(old)
            stale.setdefault('observed_at', config.get('_previous_inventory', {}).get('collected_at'))
            stale['evidence'] = [*old.get('evidence', []), 'stale: latest collection failed']
            assets.append(stale)
    return {'collected_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'assets': assets, 'gaps': gaps}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    output = Path(args.output)
    if output.exists():
        config['_previous_inventory'] = json.loads(output.read_text())
    inventory = collect(config)
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=output.parent, prefix='.inventory-')
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(inventory, stream, indent=2)
            stream.write('\n')
        os.replace(temp, output)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


if __name__ == '__main__':
    main()
