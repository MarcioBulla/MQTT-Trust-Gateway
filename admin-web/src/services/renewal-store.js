// The coordinator serializes writes. The partial index also prevents a second
// pending operation if another caller attempts to insert one.
export function createRenewalStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mqtt_renewals (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      status TEXT NOT NULL,
      operation TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS mqtt_renewals_pending_device
      ON mqtt_renewals(device_id)
      WHERE status IN ('requested', 'staged', 'testing');
  `);
  const select = db.prepare('SELECT operation FROM mqtt_renewals WHERE id = ?');
  const pending = db.prepare(`
    SELECT operation FROM mqtt_renewals
    WHERE device_id = ? AND status IN ('requested', 'staged', 'testing')
  `);
  const allPending = db.prepare(
    "SELECT operation FROM mqtt_renewals WHERE status IN ('requested', 'staged', 'testing') ORDER BY rowid",
  );
  const write = db.prepare(`
    INSERT INTO mqtt_renewals (id, device_id, status, operation) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status = excluded.status, operation = excluded.operation
    WHERE mqtt_renewals.device_id = excluded.device_id
  `);
  const decode = (row) => row ? JSON.parse(row.operation) : undefined;
  return {
    listPending: () => allPending.all().map(decode),
    get: (id) => decode(select.get(id)),
    pendingForDevice: (deviceId) => decode(pending.get(deviceId)),
    save(operation) {
      if (write.run(operation.id, operation.deviceId, operation.status, JSON.stringify(operation)).changes !== 1)
        throw new Error('Renewal operation cannot move to a different device');
    },
  };
}
