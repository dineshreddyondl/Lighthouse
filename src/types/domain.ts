// 'unclassified' is the v1 default for auto-discovered groups —
// only 'customer' groups feed today's escalation counters.
export type GroupType = 'unclassified' | 'internal' | 'operator' | 'customer';

export interface Group {
  id: number;
  whatsapp_id: string;
  name: string;
  type: GroupType;
  default_owner_phone: string | null;
  sla_hours: number;
  is_active: number;
  source: string;            // 'manual' | 'auto_discovered' | 'bulk_import'
  discovered_at: string | null;
  created_at: string;
}

export type MessageCategory =
  | 'escalation'
  | 'request'
  | 'update_needed'
  | 'fyi'
  | 'resolution'
  | 'noise'
  | 'unknown';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface IncomingMessage {
  whatsapp_msg_id: string;
  group_whatsapp_id: string;
  group_name: string;            // v1: needed for auto-create on join
  sender_phone: string;
  sender_name: string | null;
  text: string | null;
  has_media: boolean;
  media_type: string | null;
  timestamp: string;
  is_outbound: boolean;
  dashboard_send_id: string | null;
}

export interface ClassificationResult {
  category: MessageCategory;
  severity: Severity;
  summary: string;
  reasoning: string;
}

// Underlying loop status (existing data model — preserved for backward compat).
export type LoopStatus = 'open' | 'acked' | 'resolved' | 'abandoned';

// v1 escalation status — what the dashboard shows.
// Maps from LoopStatus:
//   'open'     → 'open'      (no team response yet)
//   'acked'    → 'responded' (meaningful response, AI-judged)
//   'resolved' → 'closed'    (manually closed by team via dashboard)
//   'abandoned' → 'closed'   (legacy)
export type EscalationStatus = 'open' | 'responded' | 'closed';

export interface OpenLoop {
  id: number;
  group_id: number;
  opened_by_message_id: number;
  opened_at: string;
  category: MessageCategory;
  severity: Severity | null;
  summary: string | null;
  owner_phone: string | null;
  status: LoopStatus;
  last_activity_at: string;
  sla_breach_at: string;
  acked_at: string | null;
  resolved_at: string | null;
  resolution_message_id: number | null;
  closed_by: string | null;
  closed_at: string | null;
}

/**
 * What the dashboard sees. A view-model on top of OpenLoop.
 * Not a separate table — same data, simpler shape.
 */
export interface Escalation {
  id: number;
  group_id: number;
  group_name: string;
  category: MessageCategory;
  status: EscalationStatus;
  opening_text: string;             // the customer's message that opened this
  opening_sender_name: string;      // who escalated
  opened_at: string;
  responded_at: string | null;       // when team gave meaningful response (acked_at)
  responded_by_name: string | null;  // which team member (resolved via team_members lookup)
  closed_at: string | null;
  closed_by: string | null;          // Cognito user id (or 'unknown' for v1 mock auth)
}
