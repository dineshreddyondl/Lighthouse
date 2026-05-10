import express from 'express';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config';
import { logger } from '../utils/logger';
import { statsRepo } from '../db/repositories/stats';
import { escalationsRepo } from '../db/repositories/escalations';
import { outboundRepliesRepo } from '../db/repositories/outboundReplies';
import { groupsRepo } from '../db/repositories/groups';
import { sendToGroup, registerPendingDashboardSend, fetchGroupParticipants } from '../whatsapp/client';
import { teamMembersRepo } from '../db/repositories/teamMembers';
import { messagesRepo } from '../db/repositories/messages';

export function startWebServer() {
  const app = express();
  app.use(express.json({ limit: '32kb' }));

  // ---------- Today's escalations ----------
  app.get('/api/today', (_req, res) => {
    try {
      const since = todayStartIstIso();
      res.json({
        date: new Date().toISOString(),
        counters: statsRepo.todayCounters(),
        escalations: escalationsRepo.listToday(since),
      });
    } catch (err) {
      logger.error({ err }, '/api/today failed');
      res.status(500).json({ error: 'today_failed' });
    }
  });

  // ---------- History ----------
  app.get('/api/history', (req, res) => {
    try {
      const days = Math.min(parseInt(String(req.query.days ?? '90'), 10) || 90, 365);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      const groupId = req.query.groupId ? parseInt(String(req.query.groupId), 10) : null;
      const closedBy = req.query.closedBy ? String(req.query.closedBy) : null;
      const textQuery = req.query.q ? String(req.query.q) : null;
      const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 500);
      const offset = parseInt(String(req.query.offset ?? '0'), 10) || 0;

      const escalations = escalationsRepo.listHistory({
        sinceIso: since,
        groupId,
        closedBy,
        textQuery,
        limit,
        offset,
      });
      const total = escalationsRepo.historyCount({
        sinceIso: since,
        groupId,
        closedBy,
        textQuery,
      });
      const overall = statsRepo.historyOverallStats();
      res.json({
        escalations,
        total,
        offset,
        limit,
        overall_stats: overall,
      });
    } catch (err) {
      logger.error({ err }, '/api/history failed');
      res.status(500).json({ error: 'history_failed' });
    }
  });

  // ---------- Sidebar / groups ----------
  app.get('/api/sidebar', (_req, res) => {
    try {
      res.json({
        groups: statsRepo.groupsForSidebar(),
        new_this_week: statsRepo.newGroupsThisWeek(),
        health: statsRepo.healthCheck(),
      });
    } catch (err) {
      logger.error({ err }, '/api/sidebar failed');
      res.status(500).json({ error: 'sidebar_failed' });
    }
  });

  app.get('/api/groups/:id/conversation', (req, res) => {
    try {
      const groupId = parseInt(req.params.id, 10);
      if (!groupId) return res.status(400).json({ error: 'bad_group_id' });
      const group = statsRepo.findGroupById(groupId);
      if (!group) return res.status(404).json({ error: 'group_not_found' });
      const limit = Math.min(parseInt(String(req.query.limit ?? '200'), 10) || 200, 1000);

      // Filter to current group's open + recent escalations from today
      const since = todayStartIstIso();
      const todayEscalations = escalationsRepo
        .listToday(since)
        .filter((e) => e.group_id === groupId);

      res.json({
        group,
        messages: statsRepo.conversationForGroup(groupId, limit),
        escalations: todayEscalations,
      });
    } catch (err) {
      logger.error({ err }, '/api/groups/:id/conversation failed');
      res.status(500).json({ error: 'conversation_failed' });
    }
  });

  // ---------- Manual close ----------
  app.post('/api/escalations/:id/close', (req, res) => {
    try {
      const escalationId = parseInt(req.params.id, 10);
      if (!escalationId) return res.status(400).json({ error: 'bad_escalation_id' });

      const closedBy = (req.body?.closedBy as string) ?? 'unknown';
      const ok = escalationsRepo.markClosed(escalationId, closedBy);
      if (!ok) return res.status(404).json({ error: 'escalation_not_found_or_already_closed' });

      const escalation = escalationsRepo.findById(escalationId);
      logger.warn(
        { escalationId, closedBy, group: escalation?.group_name },
        '✓ ESCALATION MANUALLY CLOSED'
      );
      res.json({ ok: true, escalation });
    } catch (err) {
      logger.error({ err }, '/api/escalations/:id/close failed');
      res.status(500).json({ error: 'close_failed' });
    }
  });

  // ---------- Dashboard send ----------
  app.post('/api/groups/:id/reply', async (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    const { text, sentBy } = (req.body ?? {}) as { text?: string; sentBy?: string };

    if (!groupId) return res.status(400).json({ error: 'bad_group_id' });
    if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text_required' });
    const trimmed = text.trim();
    if (trimmed.length === 0) return res.status(400).json({ error: 'text_empty' });
    if (trimmed.length > 4000) return res.status(400).json({ error: 'text_too_long' });

    const group = groupsRepo.listActive().find((g) => g.id === groupId);
    if (!group) return res.status(404).json({ error: 'group_not_found_or_inactive' });

    if (!config.enableOutboundDms) {
      return res.status(403).json({
        error: 'outbound_disabled',
        message: 'Set ENABLE_OUTBOUND_DMS=true in .env and restart to enable replies.',
      });
    }

    const sendId = crypto.randomUUID();
    outboundRepliesRepo.createPending({
      send_id: sendId,
      group_id: groupId,
      text: trimmed,
      sent_by: sentBy ?? 'unknown',
      related_loop_id: null,
    });

    try {
      const waMsgId = await sendToGroup(group.whatsapp_id, trimmed);
      registerPendingDashboardSend(waMsgId, sendId);
      logger.info({ sendId, groupId, waMsgId, len: trimmed.length }, 'dashboard reply sent');
      return res.json({ ok: true, sendId, waMsgId });
    } catch (err: any) {
      outboundRepliesRepo.markFailed(sendId, String(err?.message ?? err));
      logger.error({ err, sendId, groupId }, 'dashboard reply failed');
      return res.status(500).json({ error: 'send_failed', message: String(err?.message ?? err) });
    }
  });

  // ---------- Group members modal ----------
  /**
   * Returns the unified member list for a group:
   *   - All Baileys-reported participants (live source of truth)
   *   - Marked as team if their phone is in team_members
   *   - Plus activity stats from messages table
   *
   * Some entries may have a phone in team_members but NOT be in the live
   * Baileys list (e.g., team member left the group). These appear at the
   * bottom flagged as 'left_group'.
   */
  app.get('/api/groups/:id/members', async (req, res) => {
    try {
      const groupId = parseInt(req.params.id, 10);
      if (!groupId) return res.status(400).json({ error: 'bad_group_id' });

      const group = groupsRepo.listActive().find((g) => g.id === groupId);
      if (!group) return res.status(404).json({ error: 'group_not_found' });

      // Load each data source independently so a Baileys failure
      // doesn't kill the whole modal.
      let participants: Array<{ phone: string; jid: string; isAdmin: boolean }> = [];
      let baileysWorking = true;
      try {
        const force = req.query.refresh === '1';
        const list = await fetchGroupParticipants(group.whatsapp_id, { force });
        participants = list.map((p) => ({
          phone: p.phone, jid: p.jid, isAdmin: p.isAdmin,
        }));
      } catch (err) {
        logger.warn({ err, groupId }, 'Baileys fetch failed for members modal');
        baileysWorking = false;
      }

      const activity = messagesRepo.activityByPhoneInGroup(groupId);
      const teamMap = teamMembersRepo.batchLookup(
        Array.from(new Set([
          ...participants.map((p) => p.phone),
          ...Array.from(activity.keys()),
        ]))
      );

      // Build the unified rows
      const seenPhones = new Set<string>();
      const members = participants.map((p) => {
        seenPhones.add(p.phone);
        const team = teamMap.get(p.phone);
        const act = activity.get(p.phone);
        return {
          phone: p.phone,
          jid: p.jid,
          is_admin_in_group: p.isAdmin,
          is_team: !!team,
          team_role: team?.role ?? null,
          display_name: team?.name ?? act?.sender_name ?? null,
          activity: act ?? null,
          left_group: false,
        };
      });

      // Team members who appear in messages but not in the participant list
      // (left the group, or messages historical). Show them flagged.
      for (const [phone, act] of activity) {
        if (seenPhones.has(phone)) continue;
        const team = teamMap.get(phone);
        if (!team) continue; // non-team senders who left aren't worth showing
        members.push({
          phone,
          jid: phone, // we don't have a real JID
          is_admin_in_group: false,
          is_team: true,
          team_role: team.role ?? null,
          display_name: team.name,
          activity: act,
          left_group: true,
        });
      }

      const counts = {
        total: members.length,
        team: members.filter((m) => m.is_team).length,
        customers: members.filter((m) => !m.is_team).length,
      };

      res.json({ group, members, counts, baileys_ok: baileysWorking });
    } catch (err) {
      logger.error({ err }, '/api/groups/:id/members failed');
      res.status(500).json({ error: 'members_failed' });
    }
  });

  app.post('/api/team-members', (req, res) => {
    const { phone, name, role } = (req.body ?? {}) as {
      phone?: string; name?: string; role?: string;
    };
    if (!phone || typeof phone !== 'string') return res.status(400).json({ error: 'phone_required' });
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name_required' });
    const cleanPhone = phone.trim();
    const cleanName = name.trim();
    if (cleanName.length < 1 || cleanName.length > 80) {
      return res.status(400).json({ error: 'name_invalid' });
    }
    try {
      const member = teamMembersRepo.upsert({
        phone: cleanPhone,
        name: cleanName,
        role: role?.trim() || 'team',
      });
      logger.info({ phone: cleanPhone, name: cleanName, role: member.role }, 'team member added/updated');
      res.json({ ok: true, member });
    } catch (err) {
      logger.error({ err, phone: cleanPhone }, '/api/team-members POST failed');
      res.status(500).json({ error: 'upsert_failed' });
    }
  });

  app.delete('/api/team-members/:phone', (req, res) => {
    const phone = decodeURIComponent(req.params.phone);
    if (!phone) return res.status(400).json({ error: 'phone_required' });
    try {
      const ok = teamMembersRepo.deactivate(phone);
      if (!ok) return res.status(404).json({ error: 'not_found' });
      logger.info({ phone }, 'team member deactivated');
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err, phone }, '/api/team-members DELETE failed');
      res.status(500).json({ error: 'deactivate_failed' });
    }
  });

  app.patch('/api/team-members/:phone', (req, res) => {
    const phone = decodeURIComponent(req.params.phone);
    const { name } = (req.body ?? {}) as { name?: string };
    if (!phone) return res.status(400).json({ error: 'phone_required' });
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name_required' });
    const cleanName = name.trim();
    if (cleanName.length < 1 || cleanName.length > 80) {
      return res.status(400).json({ error: 'name_invalid' });
    }
    try {
      const ok = teamMembersRepo.rename(phone, cleanName);
      if (!ok) return res.status(404).json({ error: 'not_found' });
      logger.info({ phone, name: cleanName }, 'team member renamed');
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err, phone }, '/api/team-members PATCH failed');
      res.status(500).json({ error: 'rename_failed' });
    }
  });

  // ---------- Static frontend ----------
  const publicDir = path.join(__dirname, 'public');
  app.use(express.static(publicDir));

  app.get('*', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.listen(config.webPort, () => {
    logger.info(`📊 Dashboard running at http://localhost:${config.webPort}`);
  });
}

function todayStartIstIso(): string {
  const now = Date.now();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now + istOffsetMs);
  istNow.setUTCHours(0, 0, 0, 0);
  return new Date(istNow.getTime() - istOffsetMs).toISOString();
}
