"""Verify the release manifest against an operator-pinned Ed25519 key."""
import base64
import json
import re
import subprocess
import tempfile
from pathlib import Path
from urllib.request import Request, urlopen

REPOSITORY = 'MarcioBulla/MQTT-Trust-Gateway'
VERSION = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?\Z')


def version_key(value):
    match = VERSION.fullmatch(value)
    if not match:
        raise ValueError('Invalid release version')
    if match.group(5) and any(not part for part in match.group(5).split('.')):
        raise ValueError('Invalid build metadata')
    parts = match.group(4).split('.') if match.group(4) else []
    if any(not part or (part.isdigit() and len(part) > 1 and part[0] == '0') for part in parts):
        raise ValueError('Invalid prerelease identifier')
    return tuple(map(int, match.group(1, 2, 3))) + (not parts, tuple((0, int(p)) if p.isdigit() else (1, p) for p in parts))


def fetch(url, limit=256_000, accept="application/octet-stream"):
    request = Request(url, headers={'User-Agent': 'MQTT-Trust-Gateway-Updater', 'Accept': accept})
    with urlopen(request, timeout=20) as response:
        result = response.read(limit + 1)
    if len(result) > limit:
        raise ValueError('Release metadata exceeds size limit')
    return result


def discover(version):
    version_key(version)
    payload = json.loads(fetch(f'https://api.github.com/repos/{REPOSITORY}/releases/tags/v{version}', accept='application/vnd.github+json'))
    if payload.get('draft') or payload.get('tag_name') != 'v' + version:
        raise ValueError('Release is not published for the requested tag')
    assets = {item['name']: item for item in payload.get('assets', [])}
    result = []
    for name in ('update-manifest.json', 'update-manifest.sig'):
        asset = assets.get(name)
        url = asset.get('url', '') if asset else ''
        if not re.fullmatch(r'https://api\.github\.com/repos/MarcioBulla/MQTT-Trust-Gateway/releases/assets/[0-9]+', url, re.I):
            raise ValueError('Official signed release assets are missing')
        result.append(fetch(url))
    return tuple(result)


def verify(manifest_bytes, signature_bytes, public_key_der, expected_version):
    version_key(expected_version)
    if len(public_key_der) != 44 or public_key_der[:12] != bytes.fromhex('302a300506032b6570032100'):
        raise ValueError('Pinned release key must be Ed25519 SPKI')
    if len(signature_bytes) > 128:
        raise ValueError('Release signature exceeds size limit')
    if len(manifest_bytes) > 256_000:
        raise ValueError('Release manifest exceeds size limit')
    try:
        signature = base64.b64decode(signature_bytes.strip(), validate=True)
    except Exception as error:
        raise ValueError('Malformed release signature') from error
    if len(signature) != 64:
        raise ValueError('Malformed Ed25519 signature')
    with tempfile.TemporaryDirectory(prefix='gateway-manifest-') as directory:
        root = Path(directory)
        (root/'key.der').write_bytes(public_key_der)
        (root/'manifest').write_bytes(manifest_bytes)
        (root/'signature').write_bytes(signature)
        result = subprocess.run(['openssl', 'pkeyutl', '-verify', '-pubin', '-keyform', 'DER', '-inkey', str(root/'key.der'), '-rawin', '-in', str(root/'manifest'), '-sigfile', str(root/'signature')], capture_output=True, timeout=10)
        if result.returncode:
            raise ValueError('Release signature verification failed')
    manifest = json.loads(manifest_bytes)
    if manifest.get('version') != expected_version or manifest.get('channel') != ('beta' if VERSION.fullmatch(expected_version).group(4) else 'stable'):
        raise ValueError('Release identity mismatch')
    for name in ('admin', 'broker'):
        reference = manifest.get('images', {}).get(name, {}).get('reference', '')
        if not re.fullmatch(r'ghcr\.io/marciobulla/mqtt-trust-' + name + r'@sha256:[a-f0-9]{64}', reference):
            raise ValueError('Release image is not an official immutable reference')
    if type(manifest.get('schema_version')) is not int or manifest['schema_version'] < 1:
        raise ValueError('Invalid database schema version')
    compatibility = manifest.get('compatibility', {})
    version_key(compatibility.get('min_gateway_version', ''))
    version_key(compatibility.get('min_podman_version', ''))
    for check in ('admin', 'database', 'broker_tls', 'mqtt_mtls'):
        if manifest.get('health_checks', {}).get(check) is not True:
            raise ValueError('Release omits mandatory functional checks')
    return manifest


def compatible(manifest, installed_version, schema, podman_version):
    if version_key(installed_version) < version_key(manifest['compatibility']['min_gateway_version']):
        raise ValueError('Installed Gateway version is incompatible')
    if version_key(podman_version) < version_key(manifest['compatibility']['min_podman_version']):
        raise ValueError('Host Podman version is incompatible')
    if manifest['schema_version'] < schema:
        raise ValueError('Database downgrade is forbidden')
    if manifest['schema_version'] != schema:
        migration = manifest.get('migrations', {})
        if migration.get('from') != schema or migration.get('to') != manifest['schema_version'] or migration.get('requires_snapshot') is not True:
            raise ValueError('No verified migration path exists for this schema transition')
