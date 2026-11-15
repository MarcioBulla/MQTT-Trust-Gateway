// The caller runs this schema change as a versioned migration before opening
// the store. Observations and confirmed changes are kept separately so grace
// periods never rewrite the MQTT event history.
export function createDeviceHealthTables(database) {
  database.exec(`CREATE TABLE device_health_events (
    id INTEGER PRIMARY KEY,
    device_id TEXT NOT NULL,
    at_ms INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('observation', 'confirmed')),
    state TEXT NOT NULL CHECK(state IN ('online', 'offline', 'unknown', 'disabled')),
    retained_replay INTEGER NOT NULL DEFAULT 0 CHECK(retained_replay IN (0, 1))
  );
  CREATE INDEX device_health_events_lookup ON device_health_events(device_id, kind, at_ms, id);
  CREATE TABLE device_health_checkpoints (device_id TEXT PRIMARY KEY, at_ms INTEGER NOT NULL) WITHOUT ROWID;`);
}

export function createDeviceHealthStore(database) {
  const insert = database.prepare('INSERT INTO device_health_events(device_id,at_ms,kind,state,retained_replay) VALUES(?,?,?,?,?)');
  const previous = database.prepare('SELECT at_ms,state,retained_replay FROM device_health_events WHERE device_id=? AND kind=? AND at_ms < ? ORDER BY at_ms DESC,id DESC LIMIT 1');
  const range = database.prepare('SELECT at_ms,state,retained_replay FROM device_health_events WHERE device_id=? AND kind=? AND at_ms >= ? AND at_ms <= ? ORDER BY at_ms,id');
  return {
    prune(before) {
      if (!Number.isSafeInteger(before)) throw new Error('Invalid health retention date');
      database.prepare(`DELETE FROM device_health_events AS old WHERE old.at_ms < ? AND
        (old.kind='observation' OR old.id != (SELECT recent.id FROM device_health_events AS recent
          WHERE recent.device_id=old.device_id AND recent.kind='confirmed' AND recent.at_ms < ?
          ORDER BY recent.at_ms DESC,recent.id DESC LIMIT 1))`).run(before, before);
    },
    checkpoint(deviceId, at) {
      if (typeof deviceId !== 'string' || !deviceId || !Number.isSafeInteger(at)) throw new Error('Invalid health checkpoint');
      database.prepare('INSERT INTO device_health_checkpoints VALUES(?,?) ON CONFLICT(device_id) DO UPDATE SET at_ms=excluded.at_ms').run(deviceId, at);
    },
    lastCheckpoint(deviceId) {
      return database.prepare('SELECT at_ms FROM device_health_checkpoints WHERE device_id=?').get(deviceId)?.at_ms ?? null;
    },
    last(deviceId, kind) {
      const row = database.prepare('SELECT at_ms,state FROM device_health_events WHERE device_id=? AND kind=? ORDER BY at_ms DESC,id DESC LIMIT 1').get(deviceId, kind);
      return row ? { at: new Date(row.at_ms).toISOString(), state: row.state } : null;
    },
    append({ deviceId, at, kind, state, retainedReplay = false }) {
      const atMs = typeof at === 'number' ? at : Date.parse(at);
      if (typeof deviceId !== 'string' || !deviceId || !Number.isSafeInteger(atMs) ||
          !['observation', 'confirmed'].includes(kind) || !['online', 'offline', 'unknown', 'disabled'].includes(state) ||
          typeof retainedReplay !== 'boolean') throw new Error('Invalid device health event');
      insert.run(deviceId, atMs, kind, state, retainedReplay ? 1 : 0);
    },
    read(deviceId, kind, from, to) {
      if (typeof deviceId !== 'string' || !deviceId || !['observation', 'confirmed'].includes(kind) ||
          !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to) throw new Error('Invalid device health interval');
      const preceding = previous.get(deviceId, kind, from);
      return [...(preceding ? [preceding] : []), ...range.all(deviceId, kind, from, to)]
        .map((row) => ({ at: new Date(row.at_ms).toISOString(), state: row.state, retainedReplay: Boolean(row.retained_replay) }));
    },
  };
}
