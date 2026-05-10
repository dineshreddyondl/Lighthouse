/**
 * Export captured messages to a CSV for the ops lead to review and label.
 * Use this on day 3 once you have ~200+ real messages captured.
 */

import fs from 'fs';
import path from 'path';
import { getDb } from '../src/db/client';
import { logger } from '../src/utils/logger';

const db = getDb();
const rows = db
  .prepare(
    `SELECT m.id, g.name as group_name, m.sender_name, m.text, m.category, m.severity, m.timestamp
     FROM messages m
     JOIN groups g ON m.group_id = g.id
     WHERE m.text IS NOT NULL
     ORDER BY m.timestamp DESC
     LIMIT 500`
  )
  .all() as any[];

const outDir = path.join(__dirname, '..', 'data', 'exports');
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = path.join(outDir, `messages-${stamp}.csv`);

const header = ['id', 'group_name', 'sender_name', 'text', 'predicted_category', 'predicted_severity', 'timestamp', 'human_label'];
const lines = [header.join(',')];

for (const r of rows) {
  const cols = [
    r.id,
    csvEscape(r.group_name),
    csvEscape(r.sender_name ?? ''),
    csvEscape(r.text ?? ''),
    r.category ?? '',
    r.severity ?? '',
    r.timestamp,
    '', // empty for human to fill
  ];
  lines.push(cols.join(','));
}

fs.writeFileSync(outPath, lines.join('\n'));
logger.info(`Exported ${rows.length} messages to ${outPath}`);
logger.info('Open this in Excel/Sheets, fill the "human_label" column, then convert to data/eval/labeled.json');

function csvEscape(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
