"""Private, crash-durable operation journal and cross-process exclusion."""
import contextlib
import fcntl
import json
import os
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

TERMINAL = {"COMPLETED", "ROLLED_BACK", "FAILED", "RECOVERY_REQUIRED"}
STATES = {"IDLE", "CHECKING", "AVAILABLE", "DOWNLOADING", "VERIFYING", "BACKING_UP", "PREPARING", "STOPPING", "MIGRATING", "INSTALLING", "STARTING", "HEALTH_CHECKING", "COMMITTING", "ROLLING_BACK"} | TERMINAL


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".journal-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(value, output, separators=(",", ":"))
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class OperationBusy(RuntimeError):
    pass


class Journal:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.directory.chmod(0o700)
        self.path = self.directory / "operation.json"

    @contextlib.contextmanager
    def lock(self):
        fd = os.open(self.directory / "operation.lock", os.O_CREAT | os.O_RDWR, 0o600)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise OperationBusy("Another update or recovery is running") from error
            yield
        finally:
            os.close(fd)

    def read(self):
        if not self.path.exists():
            return None
        value = json.loads(self.path.read_text())
        if value.get("state") not in STATES or not isinstance(value.get("id"), str):
            raise ValueError("Invalid updater journal; manual recovery required")
        return value

    def begin(self, version, previous, kind="install"):
        current = self.read()
        if current and current["state"] not in TERMINAL:
            raise OperationBusy("An interrupted operation requires recovery")
        if current and current["state"] == "RECOVERY_REQUIRED":
            raise OperationBusy("Manual recovery is required before another update")
        value = {"id": str(uuid.uuid4()), "state": "CHECKING", "version": version,
                 "previous": previous, "kind": kind, "startedAt": timestamp(),
                 "updatedAt": timestamp(), "committed": False, "events": []}
        self.write(value)
        return value

    def write(self, value):
        atomic_json(self.path, value)
        atomic_json(self.directory / "history" / (value["id"] + ".json"), value)

    def transition(self, value, state, **fields):
        if state not in STATES:
            raise ValueError("Unknown updater state")
        if value["state"] in TERMINAL:
            raise ValueError("A finished operation cannot be resumed")
        if value.get("committed") and state == "ROLLING_BACK":
            raise ValueError("Automatic rollback after commit is forbidden")
        value.update(fields, state=state, updatedAt=timestamp())
        value["events"].append({"state": state, "at": value["updatedAt"]})
        self.write(value)
        return value
