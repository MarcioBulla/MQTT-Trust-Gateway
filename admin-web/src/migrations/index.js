/** Explicit, transactional schema upgrades. Unknown versions always fail closed. */
export const CURRENT_SCHEMA_VERSION = 1;
const baseline = {
  id: '0001-state-audit-baseline', from: 0, to: 1,
  apply(database) {
    const row = database.prepare('SELECT value FROM state WHERE id=1').get();
    const state = row && JSON.parse(row.value);
    if (!state || !Array.isArray(state.devices) || !Array.isArray(state.certificates))
      throw new Error('Gateway state database failed baseline validation.');
    database.prepare('SELECT id, at, actor, action, detail FROM audit LIMIT 1').all();
  },
};
export const migrations = [baseline];

export function migrateDatabase(database, target = CURRENT_SCHEMA_VERSION, registry = migrations) {
  let current = database.prepare('PRAGMA user_version').get().user_version;
  if (!Number.isSafeInteger(target) || target < 0 || target > Math.max(CURRENT_SCHEMA_VERSION, ...registry.map(item => item.to)))
    throw new Error('Requested schema version is not supported.');
  if (current > target) throw new Error(`Database schema ${current} is newer than this Gateway supports (${target}).`);
  const path = [];
  let cursor = current;
  while (cursor !== target) {
    const next = registry.filter(item => item.from === cursor && item.to <= target);
    if (next.length !== 1 || next[0].to <= cursor) throw new Error('No unambiguous schema migration path exists.');
    path.push(next[0]); cursor = next[0].to;
  }
  for (const migration of path) {
    database.exec('BEGIN IMMEDIATE');
    try {
      if (database.prepare('PRAGMA user_version').get().user_version !== migration.from) throw new Error('Migration schema precondition failed.');
      database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, from_version INTEGER NOT NULL, to_version INTEGER NOT NULL, applied_at TEXT NOT NULL)');
      migration.apply(database);
      database.prepare('INSERT INTO schema_migrations VALUES(?,?,?,?)').run(migration.id, migration.from, migration.to, new Date().toISOString());
      database.exec(`PRAGMA user_version=${migration.to}`);
      database.exec('COMMIT');
      current = migration.to;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
  return { from: path[0]?.from ?? current, to: current, applied: path.map(item => item.id) };
}
