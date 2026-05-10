import { getDb } from '../client';
import type { Escalation } from '../../types/domain';

/**
 * The escalations repo is a thin view-model over the existing open_loops table.
 * It exposes the v1 product semantics (open / responded / closed) without
 * disturbing the underlying data model.
 *
 * Status mapping (LoopStatus → EscalationStatus):
 *   open      → open
 *   acked     → responded
 *   resolved  → closed   (the historical "resolved" path)
 *   abandoned → closed   (legacy)
 *
 * For v1, manual close is the primary close mechanism. AI auto-resolution
 * still works in the background on the open_loops side, and any 'resolved'
 * loops show as 'closed' here.
 */

const STATUS_MAP_SQL = `
  CASE l.status
    WHEN 'open' THEN 'open'
    WHEN 'acked' THEN 'responded'
    WHEN 'resolved' THEN 'closed'
    WHEN 'abandoned' THEN 'closed'
    ELSE l.status
  END
`;

function mapRow(r: any): Escalation {
  return {
    id: r.id,
    group_id: r.group_id,
    group_name: r.group_name,
    category: r.category,
    status: r.escalation_status,
    opening_text: r.opening_text ?? '',
    opening_sender_name: r.opening_sender ?? 'unknown',
    opened_at: r.opened_at,
    responded_at: r.acked_at,
    responded_by_name: r.responded_by_name,
    closed_at: r.closed_at,
    closed_by: r.closed_by,
  };
}

export const escalationsRepo = {
  /**
   * Today's escalations across all customer groups (calendar day, midnight IST).
   * Used by the main counter dashboard.
   *
   * `since` is the ISO timestamp of midnight IST today.
   */
  listToday(sinceIso: string): Escalation[] {
    const sql = `
      SELECT
        l.id, l.group_id, l.category, l.opened_at, l.acked_at,
        l.closed_at, l.closed_by,
        ${STATUS_MAP_SQL} as escalation_status,
        g.name as group_name,
        m.text as opening_text,
        m.sender_name as opening_sender,
        (SELECT t.name FROM team_members t
         JOIN messages tm ON tm.sender_phone = t.phone
         WHERE tm.group_id = l.group_id
           AND tm.is_outbound = 1
           AND tm.timestamp >= l.opened_at
           AND tm.timestamp <= COALESCE(l.acked_at, datetime('now'))
         ORDER BY tm.timestamp ASC LIMIT 1) as responded_by_name
      FROM open_loops l
      JOIN groups g ON l.group_id = g.id
      JOIN messages m ON l.opened_by_message_id = m.id
      WHERE g.type = 'customer'
        AND g.is_active = 1
        AND l.opened_at >= ?
      ORDER BY l.opened_at DESC
    `;
    const rows = getDb().prepare(sql).all(sinceIso) as any[];
    return rows.map(mapRow);
  },

  /**
   * Today's escalations counters — used by the 4 stat cards at the top.
   */
  todayCounters(sinceIso: string) {
    const all = this.listToday(sinceIso);
    const groups = new Set(all.map((e) => e.group_id)).size;
    const total = all.length;
    const responded = all.filter((e) => e.status === 'responded' || e.status === 'closed').length;
    const open = all.filter((e) => e.status === 'open').length;
    return { groups, total, responded, open };
  },

  /**
   * Closed escalations for the History view.
   * Filterable by date range, group, closer.
   */
  listHistory(params: {
    sinceIso: string;
    groupId?: number | null;
    closedBy?: string | null;
    textQuery?: string | null;
    limit?: number;
    offset?: number;
  }): Escalation[] {
    const where: string[] = [`l.status IN ('resolved', 'abandoned')`, `l.closed_at >= ?`];
    const args: any[] = [params.sinceIso];
    if (params.groupId) {
      where.push(`l.group_id = ?`);
      args.push(params.groupId);
    }
    if (params.closedBy) {
      where.push(`l.closed_by = ?`);
      args.push(params.closedBy);
    }
    if (params.textQuery) {
      where.push(`m.text LIKE ?`);
      args.push(`%${params.textQuery}%`);
    }
    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;

    const sql = `
      SELECT
        l.id, l.group_id, l.category, l.opened_at, l.acked_at,
        l.closed_at, l.closed_by,
        ${STATUS_MAP_SQL} as escalation_status,
        g.name as group_name,
        m.text as opening_text,
        m.sender_name as opening_sender,
        NULL as responded_by_name
      FROM open_loops l
      JOIN groups g ON l.group_id = g.id
      JOIN messages m ON l.opened_by_message_id = m.id
      WHERE ${where.join(' AND ')}
      ORDER BY l.closed_at DESC
      LIMIT ? OFFSET ?
    `;
    const rows = getDb().prepare(sql).all(...args, limit, offset) as any[];
    return rows.map(mapRow);
  },

  /** Count of total closed escalations matching the same filters as listHistory. */
  historyCount(params: {
    sinceIso: string;
    groupId?: number | null;
    closedBy?: string | null;
    textQuery?: string | null;
  }): number {
    const where: string[] = [`l.status IN ('resolved', 'abandoned')`, `l.closed_at >= ?`];
    const args: any[] = [params.sinceIso];
    if (params.groupId) {
      where.push(`l.group_id = ?`);
      args.push(params.groupId);
    }
    if (params.closedBy) {
      where.push(`l.closed_by = ?`);
      args.push(params.closedBy);
    }
    if (params.textQuery) {
      where.push(`m.text LIKE ?`);
      args.push(`%${params.textQuery}%`);
    }
    const sql = `
      SELECT count(*) as c
      FROM open_loops l
      JOIN groups g ON l.group_id = g.id
      JOIN messages m ON l.opened_by_message_id = m.id
      WHERE ${where.join(' AND ')}
    `;
    return (getDb().prepare(sql).get(...args) as any).c;
  },

  /**
   * Manual close — the v1 primary mechanism for marking an escalation done.
   * Sets the underlying open_loop status to 'resolved' and records who closed it.
   */
  markClosed(escalationId: number, closedBy: string): boolean {
    const r = getDb()
      .prepare(
        `UPDATE open_loops
         SET status = 'resolved',
             closed_at = datetime('now'),
             closed_by = ?,
             resolved_at = COALESCE(resolved_at, datetime('now')),
             last_activity_at = datetime('now')
         WHERE id = ? AND status IN ('open', 'acked')`
      )
      .run(closedBy, escalationId);
    return r.changes > 0;
  },

  /** Find an escalation by id with full context. */
  findById(escalationId: number): Escalation | null {
    const sql = `
      SELECT
        l.id, l.group_id, l.category, l.opened_at, l.acked_at,
        l.closed_at, l.closed_by,
        ${STATUS_MAP_SQL} as escalation_status,
        g.name as group_name,
        m.text as opening_text,
        m.sender_name as opening_sender,
        NULL as responded_by_name
      FROM open_loops l
      JOIN groups g ON l.group_id = g.id
      JOIN messages m ON l.opened_by_message_id = m.id
      WHERE l.id = ?
    `;
    const r = getDb().prepare(sql).get(escalationId) as any;
    return r ? mapRow(r) : null;
  },
};
