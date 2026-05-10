/**
 * Seed pilot groups into the DB.
 *
 * STEP 1: Add the bot to each WhatsApp group you want to pilot.
 * STEP 2: Run `npm run dev` once to capture group JIDs from incoming messages
 *         (you'll see them in the logs as "message from non-pilot group, ignoring").
 * STEP 3: Fill in data/groups.csv with one row per group:
 *         whatsapp_id,name,type,default_owner_phone,sla_hours
 * STEP 4: Run `npm run seed` to register them.
 *
 * Format of data/groups.csv:
 *   whatsapp_id,name,type,default_owner_phone,sla_hours
 *   123456789-987654321@g.us,Acme Ops Internal,internal,+919876543210,2
 *   ...
 */

import fs from 'fs';
import path from 'path';
import { groupsRepo } from '../src/db/repositories/groups';
import { logger } from '../src/utils/logger';
import type { GroupType } from '../src/types/domain';

const csvPath = path.join(__dirname, '..', 'data', 'groups.csv');

if (!fs.existsSync(csvPath)) {
  logger.error(`Missing ${csvPath}. Create it with format:`);
  logger.error('whatsapp_id,name,type,default_owner_phone,sla_hours');
  process.exit(1);
}

const raw = fs.readFileSync(csvPath, 'utf-8');
const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

// Skip header if present
const start = lines[0].toLowerCase().startsWith('whatsapp_id') ? 1 : 0;

let count = 0;
for (let i = start; i < lines.length; i++) {
  const cols = lines[i].split(',').map((c) => c.trim());
  const [whatsapp_id, name, type, default_owner_phone, sla_hours] = cols;

  if (!whatsapp_id || !name) {
    logger.warn({ line: lines[i] }, 'skipping malformed row');
    continue;
  }

  const group = groupsRepo.upsertSeed({
    whatsappId: whatsapp_id,
    name,
    type: (type as GroupType) || 'internal',
    defaultOwnerPhone: default_owner_phone || null,
    slaHours: sla_hours ? parseFloat(sla_hours) : 2.0,
  });

  logger.info({ id: group.id, name: group.name, type: group.type }, 'seeded group');
  count++;
}

logger.info(`Done. Seeded ${count} groups.`);
process.exit(0);
