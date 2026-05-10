/**
 * One-shot bulk import: fetches every group the bot is currently a member of
 * and inserts/updates them in the groups table.
 *
 * - Auto-detects type from name (ONDL prefix convention)
 * - Marks source='bulk_import' and sets discovered_at=now
 * - Existing groups are not touched (no overwrite)
 *
 * Usage:
 *   npm run discover
 *
 * Run this once after onboarding the bot to a new account, or any time you
 * want to sync the dashboard with a freshly-joined batch of groups.
 *
 * The bot must be running and connected (or running under tsx watch) before
 * running this — it needs an active WhatsApp session.
 */
import { startWhatsApp, fetchAllParticipatingGroups } from '../src/whatsapp/client';
import { groupsRepo, detectGroupType } from '../src/db/repositories/groups';
import { getDb } from '../src/db/client';
import { logger } from '../src/utils/logger';

async function main() {
  logger.info('starting bulk group discovery...');

  // Establish WhatsApp connection
  await startWhatsApp();

  // Wait for connection to be open (Baileys takes a moment after startWhatsApp returns)
  await new Promise((r) => setTimeout(r, 5000));

  logger.info('fetching all participating groups...');
  const groups = await fetchAllParticipatingGroups();
  logger.info(`found ${groups.length} groups`);

  let added = 0;
  let skipped = 0;
  let unclassified = 0;

  const db = getDb();
  for (const g of groups) {
    const existing = groupsRepo.findByWhatsappId(g.whatsappId);
    if (existing) {
      skipped++;
      continue;
    }
    const type = detectGroupType(g.name);
    if (type === 'unclassified') unclassified++;

    db.prepare(
      `INSERT INTO groups
       (whatsapp_id, name, type, source, discovered_at, is_active)
       VALUES (?, ?, ?, 'bulk_import', datetime('now'), 1)`
    ).run(g.whatsappId, g.name, type);
    added++;
    logger.info({ name: g.name, type, members: g.participantCount }, 'imported');
  }

  logger.info(
    {
      total: groups.length,
      added,
      skipped_existing: skipped,
      unclassified,
    },
    'bulk discovery complete'
  );

  if (unclassified > 0) {
    logger.warn(
      `${unclassified} groups did not match the ONDL- naming convention and were left as 'unclassified'. ` +
      `Review them in the database or rename in WhatsApp.`
    );
  }

  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, 'discover failed');
  process.exit(1);
});
