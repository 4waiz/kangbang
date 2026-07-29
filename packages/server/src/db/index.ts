import { config } from '../config.js';
import { MemoryDatabase } from './memory.js';
import { PostgresDatabase } from './postgres.js';
import { SqliteDatabase } from './sqlite.js';
import type { Database } from './types.js';

export * from './types.js';
export { MemoryDatabase } from './memory.js';
export { SqliteDatabase } from './sqlite.js';
export { PostgresDatabase } from './postgres.js';

/**
 * Build the configured driver.  Falls back to SQLite (and ultimately memory) so
 * a misconfigured DATABASE_URL never takes the whole game server down in dev.
 */
export async function createDatabase(): Promise<Database> {
  const driver = config.db.driver;
  if (driver === 'memory') {
    const db = new MemoryDatabase();
    await db.init();
    return db;
  }
  if (driver === 'postgres') {
    if (!config.db.url) {
      throw new Error('DB_DRIVER=postgres requires DATABASE_URL');
    }
    const db = new PostgresDatabase(config.db.url);
    await db.init();
    return db;
  }
  try {
    const db = new SqliteDatabase(config.db.sqlitePath);
    await db.init();
    return db;
  } catch (err) {
    if (config.isProd) throw err;
    // eslint-disable-next-line no-console
    console.warn('[db] sqlite unavailable, falling back to in-memory storage:', (err as Error).message);
    const db = new MemoryDatabase();
    await db.init();
    return db;
  }
}
