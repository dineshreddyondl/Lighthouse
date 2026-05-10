import {
  default as makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  WASocket,
  proto,
  GroupMetadata,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import { config } from '../config';
import { logger } from '../utils/logger';
import type { IncomingMessage } from '../types/domain';

type MessageHandler = (msg: IncomingMessage, raw: proto.IWebMessageInfo) => Promise<void>;
type GroupDiscoveryHandler = (group: { whatsappId: string; name: string }) => Promise<void>;

let sock: WASocket | null = null;
let messageHandler: MessageHandler | null = null;
let groupDiscoveryHandler: GroupDiscoveryHandler | null = null;

const baileysLogger = pino({ level: 'silent' });

const FALLBACK_WA_VERSION: [number, number, number] = [2, 3000, 1037641644];

// Cache of group metadata so we can attach group names to messages without
// hammering the WhatsApp servers on every message.
const groupMetadataCache = new Map<string, { name: string; cachedAt: number }>();
const GROUP_CACHE_TTL_MS = 30 * 60_000; // 30 minutes

// Cache of group participants for the members modal. Shorter TTL because
// the modal is interactive and users want fresh data.
export interface GroupParticipant {
  jid: string;            // raw JID, e.g. "12345@s.whatsapp.net" or "227...@lid"
  phone: string;          // E.164-ish: "+91..." or LID like "+227..."
  isAdmin: boolean;
  isSuperAdmin: boolean;
}
const groupParticipantsCache = new Map<string, { participants: GroupParticipant[]; cachedAt: number }>();
const PARTICIPANTS_CACHE_TTL_MS = 5 * 60_000; // 5 minutes

export function onMessage(handler: MessageHandler) {
  messageHandler = handler;
}

export function onGroupDiscovery(handler: GroupDiscoveryHandler) {
  groupDiscoveryHandler = handler;
}

/**
 * Fetch group name from cache or via Baileys.
 * Used both during message handling and for the bulk-discovery script.
 */
export async function getGroupName(whatsappId: string): Promise<string> {
  const cached = groupMetadataCache.get(whatsappId);
  if (cached && Date.now() - cached.cachedAt < GROUP_CACHE_TTL_MS) {
    return cached.name;
  }
  if (!sock) return whatsappId; // fallback if not connected
  try {
    const meta = await sock.groupMetadata(whatsappId);
    const name = meta?.subject || whatsappId;
    groupMetadataCache.set(whatsappId, { name, cachedAt: Date.now() });
    return name;
  } catch (err) {
    logger.debug({ err, whatsappId }, 'group metadata fetch failed');
    return whatsappId;
  }
}

/**
 * Fetch the participants of a group. Caches for 5 minutes.
 * Used by the members modal in the dashboard.
 *
 * Returns the live group membership from WhatsApp (NOT just senders we've seen messages from).
 * Includes silent members who haven't said anything yet — important for pre-onboarding.
 */
export async function fetchGroupParticipants(
  whatsappId: string,
  opts: { force?: boolean } = {}
): Promise<GroupParticipant[]> {
  if (!opts.force) {
    const cached = groupParticipantsCache.get(whatsappId);
    if (cached && Date.now() - cached.cachedAt < PARTICIPANTS_CACHE_TTL_MS) {
      return cached.participants;
    }
  }
  if (!sock) throw new Error('WhatsApp not connected');

  const meta = await sock.groupMetadata(whatsappId);
  const participants: GroupParticipant[] = (meta?.participants ?? []).map((p) => ({
    jid: p.id,
    phone: jidToPhone(p.id),
    isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
    isSuperAdmin: p.admin === 'superadmin',
  }));

  groupParticipantsCache.set(whatsappId, {
    participants,
    cachedAt: Date.now(),
  });

  // Pre-warm the group name cache too while we're at it
  if (meta?.subject) {
    groupMetadataCache.set(whatsappId, { name: meta.subject, cachedAt: Date.now() });
  }

  return participants;
}

/** Invalidate the participants cache for a group (e.g., when membership changes). */
export function invalidateParticipantsCache(whatsappId?: string) {
  if (whatsappId) groupParticipantsCache.delete(whatsappId);
  else groupParticipantsCache.clear();
}

/**
 * Bulk-discovery: fetch every group the bot is currently in.
 * Used by `npm run discover` for one-shot onboarding of existing 100 groups.
 */
export async function fetchAllParticipatingGroups(): Promise<Array<{
  whatsappId: string;
  name: string;
  participantCount: number;
}>> {
  if (!sock) throw new Error('WhatsApp not connected');
  const all = await sock.groupFetchAllParticipating();
  return Object.values(all).map((g: GroupMetadata) => {
    // Pre-warm cache while we're at it
    groupMetadataCache.set(g.id, { name: g.subject, cachedAt: Date.now() });
    return {
      whatsappId: g.id,
      name: g.subject,
      participantCount: g.participants?.length ?? 0,
    };
  });
}

export async function startWhatsApp() {
  fs.mkdirSync(config.waAuthDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(config.waAuthDir);

  let version: [number, number, number] = FALLBACK_WA_VERSION;
  try {
    const fetched = await fetchLatestBaileysVersion();
    if (fetched?.version) {
      version = fetched.version as [number, number, number];
      logger.info({ version, source: fetched.isLatest ? 'latest' : 'cached' }, 'WA version resolved');
    }
  } catch (err) {
    logger.warn({ err, version }, 'fetchLatestBaileysVersion failed, using hardcoded fallback');
  }

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: baileysLogger,
    browser: ['Lighthouse', 'Desktop', '1.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      logger.info('Scan this QR with the bot WhatsApp number:');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      logger.info('WhatsApp connected ✓');
    }
    if (connection === 'close') {
      const code = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      logger.warn({ code, shouldReconnect }, 'WhatsApp connection closed');
      if (shouldReconnect) {
        setTimeout(() => startWhatsApp().catch((e) => logger.error({ err: e }, 'reconnect failed')), 3000);
      } else {
        logger.error('Logged out — delete auth folder and re-scan QR to reconnect');
      }
    }
  });

  // Listen for groups the bot was just added to.
  // Fires when someone adds the bot's WhatsApp number to a new group.
  sock.ev.on('groups.upsert', async (groups) => {
    for (const g of groups) {
      groupMetadataCache.set(g.id, { name: g.subject, cachedAt: Date.now() });
      logger.info(
        { whatsappId: g.id, name: g.subject, participants: g.participants?.length },
        'bot was added to a new group'
      );
      if (groupDiscoveryHandler) {
        try {
          await groupDiscoveryHandler({ whatsappId: g.id, name: g.subject });
        } catch (err) {
          logger.error({ err, whatsappId: g.id }, 'group discovery handler failed');
        }
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      try {
        await handleRawMessage(m);
      } catch (err) {
        logger.error({ err }, 'failed to handle message');
      }
    }
  });

  return sock;
}

async function handleRawMessage(m: proto.IWebMessageInfo) {
  if (!m.message) return;

  const remoteJid = m.key.remoteJid;
  if (!remoteJid || !remoteJid.endsWith('@g.us')) return; // groups only

  const isOutbound = !!m.key.fromMe;
  const senderJid = m.key.participant ?? remoteJid;
  const senderPhone = jidToPhone(senderJid);

  const msg = m.message;
  let text: string | null = null;
  let hasMedia = false;
  let mediaType: string | null = null;

  if (msg.conversation) {
    text = msg.conversation;
  } else if (msg.extendedTextMessage?.text) {
    text = msg.extendedTextMessage.text;
  } else if (msg.imageMessage) {
    hasMedia = true;
    mediaType = 'image';
    text = msg.imageMessage.caption ?? null;
  } else if (msg.videoMessage) {
    hasMedia = true;
    mediaType = 'video';
    text = msg.videoMessage.caption ?? null;
  } else if (msg.audioMessage) {
    hasMedia = true;
    mediaType = 'audio';
  } else if (msg.documentMessage) {
    hasMedia = true;
    mediaType = 'document';
    text = msg.documentMessage.caption ?? null;
  } else if (msg.stickerMessage) {
    hasMedia = true;
    mediaType = 'sticker';
  }

  const dashboardSendId = isOutbound && m.key.id
    ? consumePendingSendIdForMsgId(m.key.id)
    : null;

  // v1: get the group name so the pipeline can auto-create groups it doesn't know yet
  const groupName = await getGroupName(remoteJid);

  const incoming: IncomingMessage = {
    whatsapp_msg_id: m.key.id ?? `${remoteJid}-${m.messageTimestamp}`,
    group_whatsapp_id: remoteJid,
    group_name: groupName,
    sender_phone: senderPhone,
    sender_name: m.pushName ?? (isOutbound ? 'Lighthouse / our team' : null),
    text,
    has_media: hasMedia,
    media_type: mediaType,
    timestamp: new Date(Number(m.messageTimestamp) * 1000).toISOString(),
    is_outbound: isOutbound,
    dashboard_send_id: dashboardSendId,
  };

  if (messageHandler) {
    await messageHandler(incoming, m);
  }
}

const pendingDashboardSends = new Map<string, { sendId: string; expiresAt: number }>();

export function registerPendingDashboardSend(waMsgId: string, sendId: string) {
  pendingDashboardSends.set(waMsgId, {
    sendId,
    expiresAt: Date.now() + 5 * 60_000,
  });
}

function consumePendingSendIdForMsgId(waMsgId: string): string | null {
  const entry = pendingDashboardSends.get(waMsgId);
  if (!entry) return null;
  pendingDashboardSends.delete(waMsgId);
  if (entry.expiresAt < Date.now()) return null;
  return entry.sendId;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingDashboardSends.entries()) {
    if (v.expiresAt < now) pendingDashboardSends.delete(k);
  }
}, 60_000).unref();

function jidToPhone(jid: string): string {
  const num = jid.split('@')[0].split(':')[0];
  return num.startsWith('+') ? num : `+${num}`;
}

export async function sendDm(phone: string, text: string): Promise<void> {
  if (!sock) throw new Error('WhatsApp not connected');
  if (!config.enableOutboundDms) {
    logger.info({ phone, text }, '[DM SUPPRESSED] outbound DMs disabled');
    return;
  }
  const jid = phone.replace(/^\+/, '') + '@s.whatsapp.net';
  await sock.sendMessage(jid, { text });
}

export async function sendToGroup(groupJid: string, text: string): Promise<string> {
  if (!sock) throw new Error('WhatsApp not connected');
  if (!config.enableOutboundDms) {
    throw new Error('Outbound disabled (set ENABLE_OUTBOUND_DMS=true to enable)');
  }
  if (!groupJid.endsWith('@g.us')) {
    throw new Error(`Refusing to send: not a group JID (${groupJid})`);
  }
  const result = await sock.sendMessage(groupJid, { text });
  const waMsgId = result?.key?.id;
  if (!waMsgId) throw new Error('Send succeeded but no message id returned');
  return waMsgId;
}

export function getSocket(): WASocket | null {
  return sock;
}
