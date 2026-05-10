/**
 * Seed team members from data/team_members.csv
 *
 * Format:
 *   phone,name,role
 *   +918019461100,Dinesh,ops_lead
 *   +22750576042214,Dinesh LID,ops_lead
 *
 * Note: WhatsApp uses LIDs (pseudonymous IDs starting with +227...) in some
 * groups. Team members replying from their personal phone may show as a LID,
 * not their real phone. Add the LID as another row to recognize them.
 *
 * Run: npm run seed:team
 */
import fs from 'fs';
import path from 'path';
import { teamMembersRepo } from '../src/db/repositories/teamMembers';
import { logger } from '../src/utils/logger';

const csvPath = path.join(__dirname, '..', 'data', 'team_members.csv');

if (!fs.existsSync(csvPath)) {
  logger.error(`Missing ${csvPath}`);
  process.exit(1);
}

const raw = fs.readFileSync(csvPath, 'utf-8');
const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const start = lines[0].toLowerCase().startsWith('phone') ? 1 : 0;

let count = 0;
for (let i = start; i < lines.length; i++) {
  const cols = lines[i].split(',').map((c) => c.trim());
  const [phone, name, role] = cols;
  if (!phone || !name) continue;
  if (!phone.startsWith('+')) {
    logger.warn({ phone }, 'phone should be E.164 (start with +) — skipping');
    continue;
  }
  const m = teamMembersRepo.upsert({ phone, name, role: role || null });
  logger.info({ id: m.id, name: m.name, phone: m.phone, role: m.role }, 'seeded team member');
  count++;
}

logger.info(`Done. Seeded ${count} team member(s).`);
process.exit(0);
