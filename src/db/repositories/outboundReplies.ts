import { getDb } from '../client';

export interface OutboundReplyRow {
  id: number;
  send_id: string;
  group_id: number;
  text: string;
  sent_by: string | null;
  status: 'pending' | 'sent' | 'failed';
  error_message: string | null;
  related_loop_id: number | null;
  whatsapp_msg_id: string | null;
  created_at: string;
  sent_at: string | null;
}

export const outboundRepliesRepo = {
  /** Reserve a send slot before actually sending. Returns the row id. */
  createPending(params: {
    send_id: string;
    group_id: number;
    text: string;
    sent_by: string | null;
    related_loop_id: number | null;
  }): number {
    const r = getDb()
      .prepare(
        `INSERT INTO outbound_replies (send_id, group_id, text, sent_by, related_loop_id)
         VALUES (@send_id, @group_id, @text, @sent_by, @related_loop_id)`
      )
      .run(params);
    return r.lastInsertRowid as number;
  },

  markSent(send_id: string, whatsapp_msg_id: string) {
    getDb()
      .prepare(
        `UPDATE outbound_replies
         SET status = 'sent', whatsapp_msg_id = ?, sent_at = datetime('now')
         WHERE send_id = ?`
      )
      .run(whatsapp_msg_id, send_id);
  },

  markFailed(send_id: string, error: string) {
    getDb()
      .prepare(
        `UPDATE outbound_replies
         SET status = 'failed', error_message = ?
         WHERE send_id = ?`
      )
      .run(error, send_id);
  },

  findBySendId(send_id: string): OutboundReplyRow | undefined {
    return getDb()
      .prepare('SELECT * FROM outbound_replies WHERE send_id = ?')
      .get(send_id) as OutboundReplyRow | undefined;
  },
};
