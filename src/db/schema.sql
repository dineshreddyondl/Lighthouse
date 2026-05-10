-- Lighthouse v1 schema
-- Customer escalation tracker built on existing proto data model.
-- Tables in dependency order: groups → people → messages → open_loops → alerts → outbound_replies → team_members

CREATE TABLE IF NOT EXISTS groups (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_id   TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  -- v1: 'unclassified' is the initial state when auto-discovered.
  -- Auto-detection from name prefix populates 'customer' | 'operator' | 'internal' on first save.
  type          TEXT NOT NULL DEFAULT 'unclassified',
  default_owner_phone TEXT,
  sla_hours     REAL NOT NULL DEFAULT 2.0,
  is_active     INTEGER NOT NULL DEFAULT 1,
  -- Auto-discovery: was this group manually seeded or auto-discovered?
  source        TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'auto_discovered' | 'bulk_import'
  -- For "X new groups joined this week" indicator
  discovered_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS people (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  phone         TEXT UNIQUE NOT NULL,
  name          TEXT,
  role          TEXT,
  is_team_member INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_msg_id TEXT UNIQUE,
  group_id      INTEGER NOT NULL REFERENCES groups(id),
  sender_phone  TEXT NOT NULL,
  sender_name   TEXT,
  text          TEXT,
  has_media     INTEGER NOT NULL DEFAULT 0,
  media_type    TEXT,
  timestamp     TEXT NOT NULL,
  is_outbound   INTEGER NOT NULL DEFAULT 0,
  dashboard_send_id TEXT,
  category      TEXT,
  severity      TEXT,
  classifier_raw TEXT,
  classified_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_group_ts ON messages(group_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_category ON messages(category);
CREATE INDEX IF NOT EXISTS idx_messages_outbound ON messages(group_id, is_outbound, timestamp);

-- open_loops is the underlying table; the v1 'escalations' concept layers on top.
-- Status mapping:
--   open_loops.status='open'     → escalation status='open'      (no team response yet)
--   open_loops.status='acked'    → escalation status='responded' (team gave meaningful response, AI-judged)
--   open_loops.status='resolved' → escalation status='closed'    (manually closed by team via dashboard)
-- 'abandoned' from old proto is treated as 'closed' for v1 purposes.
CREATE TABLE IF NOT EXISTS open_loops (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id      INTEGER NOT NULL REFERENCES groups(id),
  opened_by_message_id INTEGER NOT NULL REFERENCES messages(id),
  opened_at     TEXT NOT NULL,
  category      TEXT NOT NULL,
  severity      TEXT,
  summary       TEXT,
  owner_phone   TEXT,
  status        TEXT NOT NULL DEFAULT 'open',
  last_activity_at TEXT NOT NULL,
  sla_breach_at TEXT NOT NULL,
  acked_at      TEXT,
  resolved_at   TEXT,
  resolution_message_id INTEGER REFERENCES messages(id),
  -- v1: which Cognito user (or 'system') closed this manually.
  closed_by     TEXT,
  closed_at     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_loops_status ON open_loops(status);
CREATE INDEX IF NOT EXISTS idx_loops_group_status ON open_loops(group_id, status);
CREATE INDEX IF NOT EXISTS idx_loops_opened_at ON open_loops(opened_at);

CREATE TABLE IF NOT EXISTS alerts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  open_loop_id  INTEGER NOT NULL REFERENCES open_loops(id),
  alert_type    TEXT NOT NULL,
  sent_to_phone TEXT NOT NULL,
  channel       TEXT NOT NULL DEFAULT 'whatsapp_dm',
  sent_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_alerts_loop ON alerts(open_loop_id);

CREATE TABLE IF NOT EXISTS outbound_replies (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  send_id         TEXT UNIQUE NOT NULL,
  group_id        INTEGER NOT NULL REFERENCES groups(id),
  text            TEXT NOT NULL,
  sent_by         TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  error_message   TEXT,
  related_loop_id INTEGER REFERENCES open_loops(id),
  whatsapp_msg_id TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbound_send_id ON outbound_replies(send_id);

-- Team members — phones we recognize as "ours" regardless of which device they used.
-- Includes WhatsApp LIDs (pseudonymous IDs starting with +227...) for team members
-- replying from their own personal phones.
CREATE TABLE IF NOT EXISTS team_members (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  phone         TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_team_members_phone ON team_members(phone);
