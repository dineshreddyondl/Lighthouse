import { getDb } from '../client';
import { escalationsRepo } from './escalations';

/**
 * Read-only queries for the v1 dashboard.
 */
export const statsRepo = {
  /** Today's counters at the top of the page. */
  todayCounters() {
    const since = todayStartIstIso();
    const counters = escalationsRepo.todayCounters(since);
    const totalCustomerGroups = (getDb()
      .prepare(`SELECT count(*) as c FROM groups WHERE is_active = 1 AND type = 'customer'`)
      .get() as any).c;
    return {
      ...counters,
      totalCustomerGroups,
    };
  },

  /**
   * Sidebar group list — every active group with today's open count.
   * Includes 'new' marker for recently auto-discovered groups.
   */
  groupsForSidebar() {
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const rows = getDb()
      .prepare(
        `SELECT
            g.id, g.whatsapp_id, g.name, g.type, g.sla_hours, g.source, g.discovered_at,
            (SELECT count(*) FROM open_loops l
             WHERE l.group_id = g.id AND l.status IN ('open','acked')
             AND l.opened_at >= ?) as open_count,
            (SELECT count(*) FROM open_loops l
             WHERE l.group_id = g.id AND l.status = 'open' AND l.opened_at >= ?) as open_no_response,
            (SELECT max(timestamp) FROM messages m WHERE m.group_id = g.id) as last_message_at
         FROM groups g
         WHERE g.is_active = 1
         ORDER BY
           CASE WHEN g.type = 'customer' THEN 0 ELSE 1 END,
           open_no_response DESC,
           open_count DESC,
           g.name ASC`
      )
      .all(todayStartIstIso(), todayStartIstIso()) as any[];

    return rows.map((r) => ({
      ...r,
      is_new: r.discovered_at && r.discovered_at >= oneWeekAgo,
    }));
  },

  /** Count of newly-discovered groups in last 7 days (for the sidebar banner). */
  newGroupsThisWeek(): number {
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    return (getDb()
      .prepare(
        `SELECT count(*) as c FROM groups
         WHERE is_active = 1 AND discovered_at >= ?`
      )
      .get(oneWeekAgo) as any).c;
  },

  /** Conversation thread for a single group (drilled-in view). */
  conversationForGroup(groupId: number, limit = 200) {
    const rows = getDb()
      .prepare(
        `SELECT
            m.id, m.text, m.sender_name, m.sender_phone, m.timestamp,
            m.category, m.severity, m.has_media, m.media_type, m.is_outbound,
            m.dashboard_send_id
         FROM messages m
         WHERE m.group_id = ?
         ORDER BY m.timestamp DESC
         LIMIT ?`
      )
      .all(groupId, limit) as any[];
    return rows.reverse(); // chronological
  },

  findGroupById(groupId: number) {
    return getDb()
      .prepare(`SELECT * FROM groups WHERE id = ?`)
      .get(groupId);
  },

  /** History stats — for the summary line on History page. */
  historyOverallStats() {
    const r = getDb()
      .prepare(
        `SELECT
           count(*) as total,
           avg(
             (julianday(closed_at) - julianday(opened_at)) * 24 * 60
           ) as avg_close_minutes,
           avg(
             CASE WHEN acked_at IS NOT NULL
             THEN (julianday(acked_at) - julianday(opened_at)) * 24 * 60
             ELSE NULL END
           ) as avg_first_response_minutes
         FROM open_loops
         WHERE status IN ('resolved', 'abandoned')
         AND closed_at IS NOT NULL`
      )
      .get() as any;
    return {
      total: r.total ?? 0,
      avg_close_minutes: r.avg_close_minutes,
      avg_first_response_minutes: r.avg_first_response_minutes,
    };
  },

  /** Health stats for the connection pill. */
  healthCheck() {
    const lastMsg = getDb()
      .prepare(`SELECT max(timestamp) as last FROM messages`)
      .get() as any;
    return {
      last_message_at: lastMsg.last as string | null,
    };
  },
};

/**
 * Returns ISO timestamp for midnight IST today (start of "today" window).
 * IST is UTC+5:30 — we calculate by shifting now() into IST, zeroing time, shifting back.
 */
function todayStartIstIso(): string {
  const now = Date.now();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now + istOffsetMs);
  // Zero out the time part in IST
  istNow.setUTCHours(0, 0, 0, 0);
  // Convert back to UTC
  return new Date(istNow.getTime() - istOffsetMs).toISOString();
}
