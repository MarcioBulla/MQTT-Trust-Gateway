// Dedicated aggregate table: no topics, payloads, credentials, or device identities.
export function createTrafficStore(sqlite) {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS traffic_history (
    timestamp INTEGER PRIMARY KEY, received INTEGER NOT NULL, sent INTEGER NOT NULL,
    dropped INTEGER NOT NULL, publicationFailures INTEGER NOT NULL
  )`);
  const upsert = sqlite.prepare(`INSERT INTO traffic_history VALUES(?,?,?,?,?) ON CONFLICT(timestamp) DO UPDATE SET
    received=excluded.received,sent=excluded.sent,dropped=excluded.dropped,publicationFailures=excluded.publicationFailures`);
  return {
    load(cutoff) { return sqlite.prepare('SELECT * FROM traffic_history WHERE timestamp >= ? ORDER BY timestamp').all(cutoff); },
    save(sample, cutoff) {
      upsert.run(sample.timestamp, sample.received, sample.sent, sample.dropped, sample.publicationFailures);
      sqlite.prepare('DELETE FROM traffic_history WHERE timestamp < ?').run(cutoff);
    },
  };
}
