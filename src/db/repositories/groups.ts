import { getDb } from '../client';
import type { Group, GroupType } from '../../types/domain';
import { logger } from '../../utils/logger';

/**
 * Detect group type from name using ONDL naming convention:
 *   ONDL-Internal*           → internal
 *   ONDL-{Name}-{City}       → operator   (3+ dash-separated parts after ONDL)
 *   ONDL-{Name}              → customer   (2 dash-separated parts)
 *   anything else            → unclassified
 *
 * Conservative — anything that doesn't match the convention exactly stays
 * unclassified so it doesn't pollute the customer-escalation counters.
 */
export function detectGroupType(name: string): GroupType {
  if (!name) return 'unclassified';
  const trimmed = name.trim();

  if (!trimmed.toUpperCase().startsWith('ONDL-')) {
    return 'unclassified';
  }

  // Strip the ONDL- prefix
  const rest = trimmed.slice(5);
  if (!rest) return 'unclassified';

  // ONDL-Internal*
  if (rest.toLowerCase().startsWith('internal')) {
    return 'internal';
  }

  // Count dash-separated parts after ONDL-
  // ONDL-Acme       → 1 part  → customer
  // ONDL-Acme-Mumbai → 2 parts → operator
  const parts = rest.split('-').filter(Boolean);
  if (parts.length === 1) return 'customer';
  if (parts.length >= 2) return 'operator';

  return 'unclassified';
}

export const groupsRepo = {
  findByWhatsappId(whatsappId: string): Group | undefined {
    return getDb()
      .prepare('SELECT * FROM groups WHERE whatsapp_id = ?')
      .get(whatsappId) as Group | undefined;
  },

  /**
   * Find or auto-create a group from an incoming message's group JID.
   * - If the group exists, return it as-is.
   * - If it doesn't, create with auto-detected type.
   *
   * This is what makes "ops adds bot to a group → it's tracked" work without manual steps.
   */
  findOrAutoCreate(params: {
    whatsappId: string;
    name: string;
  }): Group {
    const existing = this.findByWhatsappId(params.whatsappId);
    if (existing) return existing;

    const type = detectGroupType(params.name);
    const result = getDb()
      .prepare(
        `INSERT INTO groups
         (whatsapp_id, name, type, source, discovered_at, is_active)
         VALUES (?, ?, ?, 'auto_discovered', datetime('now'), 1)`
      )
      .run(params.whatsappId, params.name, type);

    logger.warn(
      {
        groupId: result.lastInsertRowid,
        name: params.name,
        type,
        whatsappId: params.whatsappId,
      },
      '✨ NEW GROUP AUTO-DISCOVERED'
    );

    return getDb()
      .prepare('SELECT * FROM groups WHERE id = ?')
      .get(result.lastInsertRowid) as Group;
  },

  upsertSeed(params: {
    whatsappId: string;
    name: string;
    type: GroupType;
    defaultOwnerPhone: string | null;
    slaHours: number;
  }): Group {
    const db = getDb();
    db.prepare(
      `INSERT INTO groups
       (whatsapp_id, name, type, default_owner_phone, sla_hours, source, is_active)
       VALUES (@whatsappId, @name, @type, @defaultOwnerPhone, @slaHours, 'manual', 1)
       ON CONFLICT(whatsapp_id) DO UPDATE SET
         name = excluded.name,
         type = excluded.type,
         default_owner_phone = excluded.default_owner_phone,
         sla_hours = excluded.sla_hours,
         is_active = 1`
    ).run(params);
    return this.findByWhatsappId(params.whatsappId)!;
  },

  listActive(): Group[] {
    return getDb()
      .prepare('SELECT * FROM groups WHERE is_active = 1 ORDER BY name')
      .all() as Group[];
  },

  listCustomerGroups(): Group[] {
    return getDb()
      .prepare(`SELECT * FROM groups WHERE is_active = 1 AND type = 'customer' ORDER BY name`)
      .all() as Group[];
  },

  /** For "X new groups joined this week" indicator. */
  listRecentlyDiscovered(sinceIso: string): Group[] {
    return getDb()
      .prepare(
        `SELECT * FROM groups
         WHERE source IN ('auto_discovered', 'bulk_import')
         AND discovered_at >= ?
         ORDER BY discovered_at DESC`
      )
      .all(sinceIso) as Group[];
  },

  /** Manually update a group's type (e.g., from an admin action). */
  setType(groupId: number, type: GroupType) {
    getDb()
      .prepare('UPDATE groups SET type = ? WHERE id = ?')
      .run(type, groupId);
  },
};
