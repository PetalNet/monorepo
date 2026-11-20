"""Read-only Ubuntu edge inventory; executable over SSH without installing files."""
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess


SSH_FIELDS = {'permitrootlogin', 'passwordauthentication', 'kbdinteractiveauthentication',
              'pubkeyauthentication', 'gatewayports', 'allowtcpforwarding', 'maxauthtries',
              'permitopen', 'permitlisten', 'allowagentforwarding', 'x11forwarding'}


def java_version(release):
    """Read JVM metadata in its mount namespace without executing its binary as root."""
    try:
        fd = os.open(release, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
        with os.fdopen(fd) as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                return None
            text = stream.read(65536)
    except (OSError, UnicodeError):
        return None
    match = re.search(r'^JAVA_VERSION="([0-9][A-Za-z0-9.+_~-]*)"$', text, re.M)
    return match.group(1) if match else None


def snapshot():
    gaps = []

    def command(args):
        try:
            return subprocess.run(args, capture_output=True, text=True, check=True, timeout=30).stdout.strip()
        except (OSError, subprocess.SubprocessError) as exc:
            gaps.append(f'{args[0]}: {type(exc).__name__}')
            return None

    distro = {}
    for line in Path('/etc/os-release').read_text().splitlines():
        key, sep, value = line.partition('=')
        if sep and key in {'ID', 'VERSION_ID', 'VERSION_CODENAME', 'PRETTY_NAME'}:
            distro[key] = shlex.split(value)[0]
    package_text = command(['dpkg-query', '-W', '-f', '${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\t${db:Status-Status}\n'])
    if not package_text:
        raise ValueError('installed package inventory unavailable')
    packages = []
    for line in package_text.splitlines():
        name, version, source, source_version, status = line.split('\t')
        if status == 'installed':
            packages.append({'name': name, 'version': version, 'source': source or name,
                             'source_version': source_version or version})
    upgrades = command(['apt', 'list', '--upgradable'])
    security = []
    try:
        import apt
        for package in apt.Cache():
            if package.is_upgradable and any(o.origin == 'Ubuntu' and o.archive.endswith('-security')
                                            for o in package.candidate.origins):
                security.append({'name': package.name, 'installed': package.installed.version,
                                 'candidate': package.candidate.version})
    except (ImportError, OSError, SystemError) as exc:
        gaps.append('APT security origins unavailable: ' + type(exc).__name__)
    apt_config = command(['apt-config', 'dump'])
    auto = [line for line in (apt_config or '').splitlines()
            if line.startswith(('APT::Periodic::', 'Unattended-Upgrade::Allowed-Origins',
                                'Unattended-Upgrade::Origins-Pattern', 'Unattended-Upgrade::Automatic-Reboot'))]
    ssh = {}
    for user in ('root', 'tunnel'):
        text = command(['/usr/sbin/sshd', '-T', '-C', f'user={user},host=localhost,addr=127.0.0.1'])
        ssh[user] = {key: value for line in (text or '').splitlines()
                     for key, _, value in [line.partition(' ')] if key in SSH_FIELDS}
    container_text = command(['docker', 'ps', '-aq'])
    containers = []
    for container_id in (container_text or '').splitlines():
        # Never request environment variables, command arguments, or arbitrary labels.
        text = command(['docker', 'inspect', '--format',
                        '{"name":{{json .Name}},"image":{{json .Config.Image}},"image_id":{{json .Image}},'
                        '"state":{{json .State.Status}},"network":{{json .HostConfig.NetworkMode}}}', container_id])
        if not text:
            continue
        info = json.loads(text)
        info['name'] = info['name'].lstrip('/')
        info['version'] = None
        label = command(['docker', 'image', 'inspect', '--format',
                         '{{index .Config.Labels "org.opencontainers.image.version"}}', info['image_id']])
        if label and label not in ('<no value>', '<nil>'):
            info['version'] = label.removeprefix('v')
        repository = info['image'].split('@')[0]
        if ':' in repository.rsplit('/', 1)[-1]:
            repository = repository.rsplit(':', 1)[0]
        info['repository'] = repository
        if repository in ('caddy', 'docker.io/library/caddy') and info['state'] == 'running':
            version = command(['docker', 'exec', container_id, 'caddy', 'version'])
            match = re.match(r'v?(\d+\.\d+\.\d+)\b', version or '')
            info['version'] = match.group(1) if match else None
        containers.append(info)
    jvms = []
    for pid in os.listdir('/proc'):
        if not pid.isdigit():
            continue
        try:
            exe = os.readlink('/proc/' + pid + '/exe')
        except FileNotFoundError:
            continue
        except PermissionError:
            gaps.append('JVM process inventory incomplete: permission denied')
            continue
        if Path(exe.removesuffix(' (deleted)')).name == 'java':
            release = Path('/proc', pid, 'root', exe.lstrip('/')).parent.parent / 'release'
            jvms.append({'pid': pid, 'version': java_version(release)})
    binaries = {}
    for name, args in {'caddy': ['caddy', 'version'], 'cloudflared': ['cloudflared', '--version'],
                       'mc-router': ['/usr/local/bin/mc-router', '-version'],
                       'docker': ['docker', 'version', '--format', '{{.Server.Version}}']}.items():
        text = command(args)
        match = re.search(r'(?<!\d)(\d+\.\d+\.\d+)\b', text or '')
        binaries[name] = match.group(1) if match else None
    cpu = next((line.split(':', 1)[1].split() for line in Path('/proc/cpuinfo').read_text().splitlines()
                if line.startswith('flags')), None)
    return {'distro': distro, 'kernel': command(['uname', '-r']), 'packages': packages,
            'apt_lists_modified_at': max((p.stat().st_mtime for p in Path('/var/lib/apt/lists').glob('*InRelease')), default=None),
            'upgradable': upgrades, 'security_updates': security, 'unattended_upgrades': auto,
            'reboot_required': Path('/var/run/reboot-required').exists(),
            'listeners': command(['ss', '-H', '-lntup']),
            'services': command(['systemctl', 'list-units', '--type=service', '--state=running',
                                 '--no-legend', '--plain', '--no-pager']),
            'sshd': ssh, 'containers': containers, 'binaries': binaries,
            'jvms': jvms, 'cpu_flags': cpu, 'gaps': gaps}


def collect(settings, ssh):
    from inventory import asset

    host = settings['host']
    data = json.loads(ssh(settings['ssh'], 'python3 -c ' + shlex.quote(Path(__file__).read_text()),
                          180, identity_file=settings.get('identity_file')))
    items = []

    def add(service, product, version, **fields):
        item = asset(host, service, product, version)
        item.update(exposure='internet', owner='parker', cpu_flags=data['cpu_flags'], **fields)
        item['evidence'].append('internet-facing DigitalOcean edge host; component reachability recorded in host posture')
        items.append(item)
        return item

    add('os', data['distro']['ID'], data['distro']['VERSION_ID'],
        posture={key: value for key, value in data.items() if key not in {'packages', 'containers', 'binaries', 'jvms', 'gaps'}},
        evidence=['/etc/os-release; dpkg-query; apt package cache; ss; systemctl; sshd -T'])
    add('kernel', 'linux-kernel', data['kernel'], evidence=['uname -r (running kernel, distribution build)'])
    for package in data['packages']:
        add('package:' + package['name'], package['name'], package['version'],
            distro=data['distro'], source_package=package['source'], source_version=package['source_version'],
            evidence=['dpkg-query installed package; Ubuntu backport version retained'])
    for name, version in data['binaries'].items():
        item = add('binary:' + name, name, version, evidence=['host binary version command'])
        if name == 'caddy':
            item['image_repository'] = 'caddy'
    for container in data['containers']:
        add('container:' + container['name'], container['repository'].rsplit('/', 1)[-1], container['version'],
            image_repository=container['repository'],
            evidence=['actual image id: ' + container['image_id'], 'configured image: ' + container['image'],
                      'container state: ' + container['state'], 'network mode: ' + container['network']])
    for jvm in data['jvms']:
        add('java:' + jvm['pid'], 'java', jvm['version'], evidence=['running java executable; JAVA_VERSION from process mount namespace release file'],
            runtime_flags_verified=False)
    gaps = [{'host': host, 'reason': reason} for reason in data['gaps']]
    gaps.append({'host': host, 'reason': 'Ubuntu packages and running kernel require distribution advisory comparison; upstream numeric ranges cannot prove backport status'})
    return items, gaps


if __name__ == '__main__':
    print(json.dumps(snapshot()))
