import { getDb } from '../client';

export interface TeamMember {
  id: number;
  phone: string;
  name: string;
  role: string | null;
  is_active: number;
  created_at: string;
}

let phoneSetCache: Set<string> | null = null;

function refreshCache() {
  const rows = getDb()
    .prepare('SELECT phone FROM team_members WHERE is_active = 1')
    .all() as Array<{ phone: string }>;
  phoneSetCache = new Set(rows.map((r) => normalizePhone(r.phone)));
}

function normalizePhone(p: string): string {
  return p.replace(/[^\d]/g, '');
}

export const teamMembersRepo = {
  isTeamMember(phone: string | null | undefined): boolean {
    if (!phone) return false;
    if (phoneSetCache === null) refreshCache();
    return phoneSetCache!.has(normalizePhone(phone));
  },

  /** Add or reactivate a team member. Used by both seed script and dashboard modal. */
  upsert(params: { phone: string; name: string; role?: string | null }): TeamMember {
    const db = getDb();
    db.prepare(
      `INSERT INTO team_members (phone, name, role)
       VALUES (@phone, @name, @role)
       ON CONFLICT(phone) DO UPDATE SET
         name = excluded.name,
         role = excluded.role,
         is_active = 1`
    ).run({
      phone: params.phone,
      name: params.name,
      role: params.role ?? null,
    });
    refreshCache();
    return db
      .prepare('SELECT * FROM team_members WHERE phone = ?')
      .get(params.phone) as TeamMember;
  },

  /** Soft-delete: set is_active=0. Preserves history but stops recognizing the phone. */
  deactivate(phone: string): boolean {
    const result = getDb()
      .prepare('UPDATE team_members SET is_active = 0 WHERE phone = ?')
      .run(phone);
    refreshCache();
    return result.changes > 0;
  },

  /** Rename a team member without changing other fields. */
  rename(phone: string, name: string): boolean {
    const result = getDb()
      .prepare('UPDATE team_members SET name = ? WHERE phone = ?')
      .run(name, phone);
    // No cache refresh needed — name doesn't affect matching
    return result.changes > 0;
  },

  findByPhone(phone: string): TeamMember | undefined {
    return getDb()
      .prepare('SELECT * FROM team_members WHERE phone = ?')
      .get(phone) as TeamMember | undefined;
  },

  listActive(): TeamMember[] {
    return getDb()
      .prepare('SELECT * FROM team_members WHERE is_active = 1 ORDER BY name')
      .all() as TeamMember[];
  },

  /** Get team status for a batch of phones. Returns a Map<phone, TeamMember>. */
  batchLookup(phones: string[]): Map<string, TeamMember> {
    if (phones.length === 0) return new Map();
    const placeholders = phones.map(() => '?').join(',');
    const rows = getDb()
      .prepare(`SELECT * FROM team_members WHERE phone IN (${placeholders}) AND is_active = 1`)
      .all(...phones) as TeamMember[];
    return new Map(rows.map((r) => [r.phone, r]));
  },

  invalidateCache() {
    phoneSetCache = null;
  },
};
