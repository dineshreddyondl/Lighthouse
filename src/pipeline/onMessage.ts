import { groupsRepo } from '../db/repositories/groups';
import { messagesRepo } from '../db/repositories/messages';
import { openLoopsRepo } from '../db/repositories/openLoops';
import { outboundRepliesRepo } from '../db/repositories/outboundReplies';
import { teamMembersRepo } from '../db/repositories/teamMembers';
import { classify } from '../ai/classifier';
import { judgeAck } from '../ai/ackJudge';
import { logger } from '../utils/logger';
import type { IncomingMessage } from '../types/domain';

/**
 * v1 pipeline.
 *
 * Major changes from proto:
 *  - Groups are auto-created on first message (no manual seeding required)
 *  - Type detected from ONDL- prefix; unknown groups end up 'unclassified'
 *  - ONLY 'customer'-typed groups produce escalations.
 *    Other groups are still tracked + classified, but don't pollute counters.
 *  - 'responded' status is gated by ack-judge — filler replies don't count
 *  - Manual close is the v1 close path; resolution-judge is OFF in v1
 */
export async function handleIncomingMessage(msg: IncomingMessage): Promise<void> {
  // v1: auto-create the group if we haven't seen it before.
  // Type is auto-detected from name. Inactive groups still won't process.
  const group = groupsRepo.findOrAutoCreate({
    whatsappId: msg.group_whatsapp_id,
    name: msg.group_name,
  });
  if (!group.is_active) return;

  const fromTeamMember = teamMembersRepo.isTeamMember(msg.sender_phone);
  const isOutbound = msg.is_outbound || fromTeamMember;

  const messageId = messagesRepo.insert({
    whatsapp_msg_id: msg.whatsapp_msg_id,
    group_id: group.id,
    sender_phone: msg.sender_phone,
    sender_name: msg.sender_name,
    text: msg.text,
    has_media: msg.has_media,
    media_type: msg.media_type,
    timestamp: msg.timestamp,
    is_outbound: isOutbound,
    dashboard_send_id: msg.dashboard_send_id,
  });

  if (!messageId) return; // duplicate

  logger.info(
    {
      group: group.name,
      groupType: group.type,
      direction: isOutbound ? 'outbound' : 'inbound',
      via: msg.is_outbound ? 'fromMe' : (fromTeamMember ? 'team_member' : 'external'),
      sender: msg.sender_name ?? msg.sender_phone,
      preview: (msg.text ?? `[${msg.media_type ?? 'media'}]`).slice(0, 80),
    },
    'message ingested'
  );

  // ---------- OUTBOUND PATH ----------
  if (isOutbound) {
    if (msg.dashboard_send_id) {
      outboundRepliesRepo.markSent(msg.dashboard_send_id, msg.whatsapp_msg_id);
      logger.info({ sendId: msg.dashboard_send_id }, 'dashboard reply confirmed delivered');
    }

    const openLoop = openLoopsRepo.findOpenInGroup(group.id);
    if (!openLoop || openLoop.status !== 'open') {
      if (openLoop) openLoopsRepo.touchActivity(openLoop.id);
      return;
    }

    if (!msg.text || msg.text.trim().length < 2) {
      openLoopsRepo.touchActivity(openLoop.id);
      return;
    }

    const original = messagesRepo.findById(openLoop.opened_by_message_id);
    const originalText = original?.text ?? openLoop.summary ?? '(no original text)';

    const judgement = await judgeAck({
      groupName: group.name,
      originalText,
      replyText: msg.text,
    });

    logger.info(
      { loopId: openLoop.id, isAck: judgement.isAck, reasoning: judgement.reasoning },
      'ack judged'
    );

    if (judgement.isAck) {
      openLoopsRepo.markAcked(openLoop.id);
      logger.warn(
        { loopId: openLoop.id, group: group.name },
        '✓ ESCALATION RESPONDED — meaningful reply from team'
      );
    } else {
      openLoopsRepo.touchActivity(openLoop.id);
    }
    return;
  }

  // ---------- INBOUND PATH ----------

  // v1: only customer groups produce escalations. Others get classified for
  // future use but don't pollute the counter dashboard.
  const isCustomerGroup = group.type === 'customer';

  // Always classify (we want labels in the messages table for future analysis)
  const result = await classify({
    text: msg.text,
    hasMedia: msg.has_media,
    groupName: group.name,
    groupType: group.type === 'unclassified' ? 'internal' : group.type,
    senderName: msg.sender_name,
  });

  messagesRepo.setClassification(messageId, result);

  logger.info(
    {
      group: group.name,
      category: result.category,
      severity: result.severity,
      summary: result.summary,
      willCreateEscalation: isCustomerGroup &&
        ['escalation', 'request', 'update_needed'].includes(result.category),
    },
    'classified'
  );

  // Only customer groups get escalations.
  if (!isCustomerGroup) return;

  // Broad escalation definition: escalation + update_needed + request all count.
  if (
    result.category === 'escalation' ||
    result.category === 'request' ||
    result.category === 'update_needed'
  ) {
    const existing = openLoopsRepo.findOpenInGroup(group.id);
    if (existing) {
      openLoopsRepo.touchActivity(existing.id);
      logger.info(
        { loopId: existing.id, category: result.category },
        'related to existing escalation, not duplicating'
      );
      return;
    }

    const slaMs = group.sla_hours * 60 * 60 * 1000;
    const slaBreachAt = new Date(Date.now() + slaMs).toISOString();

    const loopId = openLoopsRepo.create({
      group_id: group.id,
      opened_by_message_id: messageId,
      opened_at: msg.timestamp,
      category: result.category,
      severity: result.severity,
      summary: result.summary,
      owner_phone: group.default_owner_phone,
      sla_breach_at: slaBreachAt,
    });

    logger.warn(
      {
        escalationId: loopId,
        group: group.name,
        category: result.category,
        severity: result.severity,
        summary: result.summary,
      },
      '🚨 ESCALATION OPENED'
    );
  }
}
