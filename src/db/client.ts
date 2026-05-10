import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
    db = new Database(config.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
    logger.info({ path: config.dbPath }, 'database connected');
  }
  return db;
}

function initSchema(database: Database.Database) {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');
  database.exec(schema);

  // Lightweight migrations: add new columns to existing DBs that pre-date them.
  // SQLite has no IF NOT EXISTS for ALTER TABLE ADD COLUMN — wrap each in try/catch.
  const migrations: { sql: string; name: string }[] = [
    // From two-way build (proto → v0.2)
    { sql: `ALTER TABLE messages ADD COLUMN is_outbound INTEGER NOT NULL DEFAULT 0`, name: 'messages.is_outbound' },
    { sql: `ALTER TABLE messages ADD COLUMN dashboard_send_id TEXT`, name: 'messages.dashboard_send_id' },

    // From v1 (escalation tracker layer)
    { sql: `ALTER TABLE open_loops ADD COLUMN closed_by TEXT`, name: 'open_loops.closed_by' },
    { sql: `ALTER TABLE open_loops ADD COLUMN closed_at TEXT`, name: 'open_loops.closed_at' },

    // From v1 (group auto-discovery)
    { sql: `ALTER TABLE groups ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'`, name: 'groups.source' },
    { sql: `ALTER TABLE groups ADD COLUMN discovered_at TEXT`, name: 'groups.discovered_at' },
  ];
  for (const m of migrations) {
    try {
      database.exec(m.sql);
      logger.info({ migration: m.name }, 'migration applied');
    } catch (err: any) {
      // 'duplicate column' means already applied — that's fine
      if (!String(err.message).includes('duplicate column')) {
        logger.warn({ migration: m.name, err: err.message }, 'migration skipped');
      }
    }
  }
}

export function closeDb() {
  if (db) {
    db.close();
  }
}
