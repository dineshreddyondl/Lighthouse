import { getDb } from '../client';
import type { OpenLoop, MessageCategory, Severity } from '../../types/domain';

export const openLoopsRepo = {
  create(params: {
    group_id: number;
    opened_by_message_id: number;
    opened_at: string;
    category: MessageCategory;
    severity: Severity | null;
    summary: string | null;
    owner_phone: string | null;
    sla_breach_at: string;
  }): number {
    const result = getDb()
      .prepare(
        `INSERT INTO open_loops
         (group_id, opened_by_message_id, opened_at, category, severity, summary,
          owner_phone, last_activity_at, sla_breach_at)
         VALUES (@group_id, @opened_by_message_id, @opened_at, @category, @severity,
                 @summary, @owner_phone, @opened_at, @sla_breach_at)`
      )
      .run(params);
    return result.lastInsertRowid as number;
  },

  findOpenInGroup(groupId: number): OpenLoop | undefined {
    return getDb()
      .prepare(
        `SELECT * FROM open_loops
         WHERE group_id = ? AND status IN ('open', 'acked')
         ORDER BY opened_at DESC LIMIT 1`
      )
      .get(groupId) as OpenLoop | undefined;
  },

  listAllActive(): OpenLoop[] {
    return getDb()
      .prepare(
        `SELECT * FROM open_loops WHERE status IN ('open', 'acked')
         ORDER BY opened_at DESC`
      )
      .all() as OpenLoop[];
  },

  /** Mark a loop as acknowledged (someone responded meaningfully). */
  markAcked(loopId: number) {
    getDb()
      .prepare(
        `UPDATE open_loops
         SET status = 'acked', acked_at = datetime('now'), last_activity_at = datetime('now')
         WHERE id = ? AND status = 'open'`
      )
      .run(loopId);
  },

  /** Touch the last_activity_at timestamp without changing status. */
  touchActivity(loopId: number) {
    getDb()
      .prepare(`UPDATE open_loops SET last_activity_at = datetime('now') WHERE id = ?`)
      .run(loopId);
  },
};
