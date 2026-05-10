import { startWhatsApp, onMessage, onGroupDiscovery } from './whatsapp/client';
import { groupsRepo } from './db/repositories/groups';
import { handleIncomingMessage } from './pipeline/onMessage';
import { getDb, closeDb } from './db/client';
import { startWebServer } from './web/server';
import { logger } from './utils/logger';
import { config } from './config';

async function main() {
  logger.info('🔦 Lighthouse starting...');
  logger.info(
    {
      provider: config.llmProvider,
      classifier: config.classifierModel,
      judge: config.judgeModel,
      outboundDms: config.enableOutboundDms,
      webPort: config.webPort,
    },
    'config loaded'
  );

  // Initialize DB (creates schema if missing)
  getDb();

  // Start the dashboard early — usable even before WA connects
  startWebServer();

  // Wire pipeline before connecting WA, so we don't drop early messages
  onMessage(async (msg) => {
    await handleIncomingMessage(msg);
  });

  // Auto-onboard new groups when the bot is added to one.
  onGroupDiscovery(async (group) => {
    groupsRepo.findOrAutoCreate({
      whatsappId: group.whatsappId,
      name: group.name,
    });
  });
  // Connect to WhatsApp (will print QR on first run)
  await startWhatsApp();

  logger.info('✓ Lighthouse running. Add the bot number to your pilot groups, then run `npm run seed`.');
  logger.info(`📊 Open the dashboard: http://localhost:${config.webPort}`);
}

process.on('SIGINT', () => {
  logger.info('shutting down...');
  closeDb();
  process.exit(0);
});

process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'unhandled rejection');
});

main().catch((err) => {
  logger.error({ err }, 'fatal');
  process.exit(1);
});
