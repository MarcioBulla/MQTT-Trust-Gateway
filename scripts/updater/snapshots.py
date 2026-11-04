"""Verified snapshots and restartable restoration of a quiescent installation.

The caller owns the operation lock and must stop both Gateway services. No
service is stopped, started, or automatically initialized by this module.
"""
import hashlib
import json
import os
import shutil
import sqlite3
import stat
import tarfile
import tempfile
from pathlib import Path, PurePosixPath

from scripts.gateway import create_backup_archive, validate_backup_archive
from .journal import atomic_json, timestamp

UNITS = ('mqtt-admin.container', 'mqtt-broker.container', 'mqtt-gateway.network')
ESSENTIAL = (
    'admin/gateway.sqlite', 'admin/ca/ca.key', 'admin/ca/ca.crt',
    'admin/ca/index.txt', 'admin/ca/serial', 'admin/ca/crlnumber',
    'admin/ca/ca.crl', 'broker/server.crt', 'broker/server.key',
    'broker/ca.crt', 'broker/ca.crl', 'broker/acl',
)


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(descriptor)
    finally: os.close(descriptor)


def durable_rename(source, target):
    os.rename(source, target)
    for parent in {Path(source).parent, Path(target).parent}:
        sync_directory(parent)


def sync_tree(root):
    for item in Path(root).rglob('*'):
        if item.is_file():
            with item.open('rb') as stream: os.fsync(stream.fileno())
    for directory in sorted((p for p in Path(root).rglob('*') if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
        sync_directory(directory)
    sync_directory(root)


def digest(file):
    result = hashlib.sha256()
    with open(file, 'rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def regular_tree(root):
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        raise ValueError('Snapshot source must be a real directory')
    for item in root.rglob('*'):
        mode = item.lstat().st_mode
        if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
            raise ValueError('Links and special files are forbidden in snapshots')


def validate_database(file):
    database = sqlite3.connect(f'file:{Path(file).as_posix()}?mode=ro', uri=True)
    try:
        if database.execute('PRAGMA integrity_check').fetchone() != ('ok',):
            raise ValueError('Snapshot SQLite integrity check failed')
        row = database.execute('SELECT value FROM state WHERE id=1').fetchone()
        if not row or not isinstance(json.loads(row[0]), dict):
            raise ValueError('Snapshot database has no valid application state')
        return database.execute('PRAGMA user_version').fetchone()[0]
    finally:
        database.close()


def inventory(archive):
    result = {}
    with tarfile.open(archive, 'r:gz') as source:
        for member in source:
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or str(path) != member.name or member.name in result:
                raise ValueError('Unsafe or duplicate archive entry')
            if not (member.isfile() or member.isdir()):
                raise ValueError('Snapshot contains links or special files')
            entry = {'size': member.size, 'mode': member.mode, 'directory': member.isdir()}
            if member.isfile():
                payload = source.extractfile(member)
                hasher = hashlib.sha256()
                for block in iter(lambda: payload.read(1024 * 1024), b''):
                    hasher.update(block)
                entry['sha256'] = hasher.hexdigest()
            result[member.name] = entry
    return result


def verify(snapshot, expected_digest=None):
    snapshot = Path(snapshot)
    regular_tree(snapshot)
    metadata = json.loads((snapshot/'snapshot.json').read_text())
    archive = snapshot/'state.tar.gz'
    actual = digest(archive)
    if metadata.get('format') != 1 or actual != metadata.get('sha256') or (expected_digest and actual != expected_digest):
        raise ValueError('Snapshot digest mismatch')
    if inventory(archive) != metadata.get('inventory'):
        raise ValueError('Snapshot file inventory mismatch')
    validate_backup_archive(archive)
    for name in ESSENTIAL:
        if 'runtime/'+name not in metadata['inventory']:
            raise ValueError('Snapshot is missing essential Gateway state')
    for name in UNITS:
        if 'quadlets/'+name not in metadata['inventory']:
            raise ValueError('Snapshot is missing a managed Quadlet')
    if 'runtime/mosquitto' not in metadata['inventory']:
        raise ValueError('Snapshot is missing Mosquitto persistence')
    return metadata


def create(destination, data, environment, units, images, assert_quiescent, version):
    """Create a snapshot only after the caller proves all writers are stopped."""
    destination, data, environment, units = map(Path, (destination, data, environment, units))
    assert_quiescent()
    regular_tree(data)
    for name in ESSENTIAL:
        if not (data/name).is_file():
            raise ValueError('Installation is missing essential state; snapshot refused')
    if not (data/'mosquitto').is_dir():
        raise ValueError('Mosquitto persistence directory is missing')
    if not environment.is_file() or environment.is_symlink():
        raise ValueError('Environment configuration is missing or unsafe')
    for name in UNITS:
        if not (units/name).is_file() or (units/name).is_symlink():
            raise ValueError('Managed Quadlet is missing or unsafe')
    if set(images) != {'admin', 'broker'}:
        raise ValueError('Both installed image identities are required')
    import re
    if any(not re.fullmatch(r'sha256:[a-f0-9]{64}', value) for value in images.values()):
        raise ValueError('Installed image identities must be immutable')
    required = sum(p.stat().st_size for p in data.rglob('*') if p.is_file())
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if data == destination.parent or data in destination.parents:
        raise ValueError('Snapshots must be stored outside the runtime directory')
    if shutil.disk_usage(destination.parent).free < required * 3 + 16 * 1024 * 1024:
        raise OSError('Insufficient space for a verified snapshot')
    if destination.exists():
        raise FileExistsError('Snapshot destination already exists')
    with tempfile.TemporaryDirectory(prefix='.snapshot-', dir=destination.parent) as temporary:
        stage = Path(temporary)
        runtime = stage/'runtime'
        shutil.copytree(data, runtime, copy_function=shutil.copy2)
        # Use SQLite Backup API to include committed WAL pages and produce a
        # standalone database; the stopped files remain available for recovery.
        canonical = stage/'canonical.sqlite'
        source = sqlite3.connect(f'file:{(data/"admin/gateway.sqlite").as_posix()}?mode=ro', uri=True)
        target = sqlite3.connect(canonical)
        try:
            source.backup(target)
            target.execute('PRAGMA journal_mode=DELETE')
        finally:
            target.close()
            source.close()
        canonical.chmod(stat.S_IMODE((data/'admin/gateway.sqlite').stat().st_mode))
        for suffix in ('-wal', '-shm'):
            (runtime/('admin/gateway.sqlite'+suffix)).unlink(missing_ok=True)
        os.replace(canonical, runtime/'admin/gateway.sqlite')
        schema = validate_database(runtime/'admin/gateway.sqlite')
        assert_quiescent()
        prepared = stage/'complete'
        prepared.mkdir(mode=0o700)
        create_backup_archive(runtime, environment, prepared/'state.tar.gz', units, images)
        metadata = {'format': 1, 'version': version, 'createdAt': timestamp(),
                    'schemaVersion': schema, 'images': images,
                    'sha256': digest(prepared/'state.tar.gz'),
                    'inventory': inventory(prepared/'state.tar.gz')}
        atomic_json(prepared/'snapshot.json', metadata)
        verify(prepared)
        # fsync archive before publishing the recovery point.
        with open(prepared/'state.tar.gz', 'rb') as stream:
            os.fsync(stream.fileno())
        sync_directory(prepared)
        durable_rename(prepared, destination)
        parent = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    return metadata


def restore(snapshot, data, environment, units, work, assert_quiescent,
            expected_digest, checkpoint=lambda _: None):
    """Restore offline, retaining displaced data and an idempotent restore log.

    `work` must be a private operation-specific path outside runtime. Repeating
    with the same path resumes after interruption. Existing runtime is retained
    in work/previous-runtime, never deleted automatically.
    """
    snapshot, data, environment, units, work = map(Path, (snapshot, data, environment, units, work))
    assert_quiescent()
    metadata = verify(snapshot, expected_digest)
    if data == work or data in work.parents or work in data.parents:
        raise ValueError('Restore workspace must be separate from runtime')
    work.mkdir(mode=0o700, parents=True, exist_ok=True)
    work.chmod(0o700)
    progress_file = work/'restore.json'
    if progress_file.exists():
        progress = json.loads(progress_file.read_text())
        if progress.get('sha256') != metadata['sha256'] or progress.get('data') != str(data.resolve()):
            raise ValueError('Restore workspace belongs to another snapshot or installation')
    else:
        progress = {'sha256': metadata['sha256'], 'data': str(data.resolve()), 'completed': False}
        atomic_json(progress_file, progress)
    if progress['completed']:
        return metadata
    stage = work/'extracted'
    if not stage.exists():
        temporary = work/'extracting'
        if temporary.exists():
            shutil.rmtree(temporary)
        temporary.mkdir(mode=0o700)
        with tarfile.open(snapshot/'state.tar.gz', 'r:gz') as archive:
            archive.extractall(temporary, filter='data')
        validate_database(temporary/'runtime/admin/gateway.sqlite')
        sync_tree(temporary)
        durable_rename(temporary, stage)
    assert_quiescent()
    previous = work/'previous-runtime'
    data.parent.mkdir(parents=True, exist_ok=True)
    if (stage/'runtime').exists():
        if data.exists():
            if previous.exists():
                raise ValueError('Ambiguous runtime state; manual recovery required')
            durable_rename(data, previous)
        checkpoint('runtime-displaced')
        durable_rename(stage/'runtime', data)
        checkpoint('runtime-installed')
    elif not data.is_dir():
        raise ValueError('Restored runtime is missing; manual recovery required')
    regular_tree(data)
    for name, entry in metadata['inventory'].items():
        if name.startswith('runtime/') and not entry['directory']:
            restored = data / name.removeprefix('runtime/')
            if not restored.is_file() or digest(restored) != entry['sha256']:
                raise ValueError('Restored runtime differs from verified snapshot')
    # Configuration writes are independently atomic and safe to repeat.
    for source, target in [(stage/'gateway.env', environment), *[(stage/'quadlets'/name, units/name) for name in UNITS]]:
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix='.restore-', dir=target.parent)
        try:
            with os.fdopen(fd, 'wb') as output:
                output.write(source.read_bytes())
                output.flush()
                os.fchmod(output.fileno(), 0o600 if target == environment else stat.S_IMODE(source.stat().st_mode))
                os.fsync(output.fileno())
            os.replace(temporary, target)
            sync_directory(target.parent)
        finally:
            Path(temporary).unlink(missing_ok=True)
        checkpoint('configuration-installed')
    validate_database(data/'admin/gateway.sqlite')
    progress['completed'] = True
    atomic_json(progress_file, progress)
    return metadata
