import { getDb } from '../client';
import type { ClassificationResult } from '../../types/domain';

export interface MessageRow {
  id: number;
  whatsapp_msg_id: string | null;
  group_id: number;
  sender_phone: string;
  sender_name: string | null;
  text: string | null;
  has_media: number;
  media_type: string | null;
  timestamp: string;
  is_outbound: number;
  dashboard_send_id: string | null;
  category: string | null;
  severity: string | null;
  classifier_raw: string | null;
  classified_at: string | null;
  created_at: string;
}

export const messagesRepo = {
  insert(params: {
    whatsapp_msg_id: string;
    group_id: number;
    sender_phone: string;
    sender_name: string | null;
    text: string | null;
    has_media: boolean;
    media_type: string | null;
    timestamp: string;
    is_outbound?: boolean;
    dashboard_send_id?: string | null;
  }): number {
    const result = getDb()
      .prepare(
        `INSERT INTO messages
         (whatsapp_msg_id, group_id, sender_phone, sender_name, text, has_media,
          media_type, timestamp, is_outbound, dashboard_send_id)
         VALUES (@whatsapp_msg_id, @group_id, @sender_phone, @sender_name, @text,
                 @has_media, @media_type, @timestamp, @is_outbound, @dashboard_send_id)
         ON CONFLICT(whatsapp_msg_id) DO NOTHING`
      )
      .run({
        whatsapp_msg_id: params.whatsapp_msg_id,
        group_id: params.group_id,
        sender_phone: params.sender_phone,
        sender_name: params.sender_name,
        text: params.text,
        has_media: params.has_media ? 1 : 0,
        media_type: params.media_type,
        timestamp: params.timestamp,
        is_outbound: params.is_outbound ? 1 : 0,
        dashboard_send_id: params.dashboard_send_id ?? null,
      });
    return result.lastInsertRowid as number;
  },

  setClassification(messageId: number, result: ClassificationResult) {
    getDb()
      .prepare(
        `UPDATE messages
         SET category = ?, severity = ?, classifier_raw = ?, classified_at = datetime('now')
         WHERE id = ?`
      )
      .run(result.category, result.severity, JSON.stringify(result), messageId);
  },

  findById(id: number): MessageRow | undefined {
    return getDb()
      .prepare('SELECT * FROM messages WHERE id = ?')
      .get(id) as MessageRow | undefined;
  },

  findByDashboardSendId(sendId: string): MessageRow | undefined {
    return getDb()
      .prepare('SELECT * FROM messages WHERE dashboard_send_id = ?')
      .get(sendId) as MessageRow | undefined;
  },

  recentInGroup(groupId: number, limit = 10): MessageRow[] {
    return getDb()
      .prepare('SELECT * FROM messages WHERE group_id = ? ORDER BY timestamp DESC LIMIT ?')
      .all(groupId, limit) as MessageRow[];
  },

  /**
   * Activity stats per sender within a group, used by the members modal.
   * Returns a map keyed by sender_phone with message counts, last_seen, and
   * top categories.
   */
  activityByPhoneInGroup(groupId: number): Map<string, {
    msg_count: number;
    last_seen: string;
    last_seen_text: string | null;
    last_category: string | null;
    sender_name: string | null;
  }> {
    const rows = getDb()
      .prepare(
        `SELECT
           sender_phone,
           sender_name,
           count(*) as msg_count,
           max(timestamp) as last_seen,
           (SELECT text FROM messages m2
            WHERE m2.group_id = ? AND m2.sender_phone = m.sender_phone
            ORDER BY m2.timestamp DESC LIMIT 1) as last_seen_text,
           (SELECT category FROM messages m2
            WHERE m2.group_id = ? AND m2.sender_phone = m.sender_phone
              AND category IS NOT NULL
            ORDER BY m2.timestamp DESC LIMIT 1) as last_category
         FROM messages m
         WHERE group_id = ?
         GROUP BY sender_phone`
      )
      .all(groupId, groupId, groupId) as any[];
    return new Map(
      rows.map((r) => [
        r.sender_phone,
        {
          msg_count: r.msg_count,
          last_seen: r.last_seen,
          last_seen_text: r.last_seen_text,
          last_category: r.last_category,
          sender_name: r.sender_name,
        },
      ])
    );
  },
};
