// Lighthouse v1 dashboard
// Three views: today / history / group-detail
// Sidebar: group search + group list

(function () {
  // ---------- helpers ----------
  const fmtAgo = (iso) => {
    if (!iso) return '—';
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 0) return 'now';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  };
  const fmtDuration = (mins) => {
    if (!mins || isNaN(mins)) return '—';
    if (mins < 60) return Math.round(mins) + 'm';
    const h = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    return h + 'h ' + m + 'm';
  };
  const fmtClock = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const escapeHtml = (s) => {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  };
  const truncate = (s, n) => !s ? '' : (s.length > n ? s.slice(0, n) + '…' : s);

  async function api(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error || ('HTTP ' + r.status));
    }
    return r.json();
  }

  // ---------- state ----------
  let currentView = { type: 'today' };
  let allGroups = [];          // sidebar cache
  let currentGroupData = null; // drilled-in cache
  let activeFilter = 'all';    // for today's escalations

  // ---------- sidebar ----------
  function renderSidebar(data) {
    allGroups = data.groups || [];
    document.getElementById('group-count').textContent = allGroups.length;

    // New groups banner
    const banner = document.getElementById('new-groups-banner');
    const newCount = data.new_this_week || 0;
    if (newCount > 0) {
      banner.classList.remove('hidden');
      document.getElementById('new-groups-text').textContent =
        newCount + ' new group' + (newCount === 1 ? '' : 's') + ' this week';
    } else {
      banner.classList.add('hidden');
    }

    // Connection health
    const dot = document.getElementById('conn-dot');
    const txt = document.getElementById('conn-text');
    const lastMsg = data.health?.last_message_at;
    if (lastMsg && Date.now() - new Date(lastMsg).getTime() < 30 * 60_000) {
      dot.classList.remove('bad');
      txt.textContent = allGroups.length + ' groups · live';
    } else {
      dot.classList.add('bad');
      txt.textContent = lastMsg ? 'No recent activity' : 'No messages yet';
    }

    renderGroupsList();
  }

  function renderGroupsList() {
    const list = document.getElementById('groups-list');
    const q = (document.getElementById('search-box').value || '').toLowerCase().trim();
    const customerGroups = allGroups.filter((g) => g.type === 'customer');
    const filtered = q ? customerGroups.filter((g) => g.name.toLowerCase().includes(q)) : customerGroups;
    const empty = document.getElementById('empty-search');

    if (filtered.length === 0 && q) {
      list.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    if (customerGroups.length === 0) {
      list.innerHTML = `<div class="side-empty">No customer groups yet.<br>Run <code>npm run discover</code> or wait for the bot to be added.</div>`;
      return;
    }

    list.innerHTML = filtered.map((g) => {
      const isActive = currentView.type === 'group' && currentView.id === g.id;
      let badge = '';
      if (g.open_no_response > 0) badge = `<span class="side-badge crit">${g.open_no_response}</span>`;
      else if (g.open_count > 0) badge = `<span class="side-badge warn">${g.open_count}</span>`;
      else if (g.is_new) badge = `<span class="side-badge new">new</span>`;
      else badge = `<span class="side-badge">0</span>`;
      return `
        <div class="side-item ${isActive ? 'active' : ''}" data-group-id="${g.id}">
          <span class="ic">👥</span><span class="name" title="${escapeHtml(g.name)}">${escapeHtml(g.name)}</span>${badge}
        </div>`;
    }).join('');

    list.querySelectorAll('[data-group-id]').forEach((el) => {
      el.addEventListener('click', () => {
        const id = parseInt(el.getAttribute('data-group-id'), 10);
        switchView({ type: 'group', id });
      });
    });
  }

  // ---------- view switching ----------
  function switchView(view) {
    currentView = view;
    document.querySelectorAll('[data-view]').forEach((el) => {
      el.classList.toggle('active', el.dataset.view === view.type);
    });
    if (view.type !== 'group') {
      document.querySelectorAll('[data-group-id]').forEach((el) => el.classList.remove('active'));
    }
    refresh();
  }

  document.querySelectorAll('[data-view]').forEach((el) => {
    el.addEventListener('click', () => switchView({ type: el.dataset.view }));
  });

  // ---------- TODAY view ----------
  async function renderToday() {
    const main = document.getElementById('main');
    const data = await api('/api/today');
    const c = data.counters;
    document.getElementById('nav-today-badge').textContent = c.open;
    document.getElementById('nav-today-badge').classList.toggle('hidden', c.open === 0);

    const filtered = data.escalations.filter((e) => {
      if (activeFilter === 'all') return true;
      if (activeFilter === 'open') return e.status === 'open';
      if (activeFilter === 'responded') return e.status === 'responded';
      return true;
    });

    main.innerHTML = `
      <div class="head">
        <p class="kicker">Today · ${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })} · IST</p>
        <h1 class="h1">Customer escalations</h1>
        <p class="sub">Live · auto-refreshes every 5s · resets at midnight IST</p>
      </div>
      <div class="cards">
        <div class="card">
          <div class="card-label">👥 Groups with escalations</div>
          <div class="card-num">${c.groups}</div>
          <div class="card-sub">of ${c.totalCustomerGroups} customer groups</div>
        </div>
        <div class="card">
          <div class="card-label">🚨 Total escalations</div>
          <div class="card-num amber">${c.total}</div>
          <div class="card-sub">requests + chasers + escalations</div>
        </div>
        <div class="card">
          <div class="card-label">✓ Team responded</div>
          <div class="card-num green">${c.responded}</div>
          <div class="card-sub">meaningful response, AI-judged</div>
        </div>
        <div class="card">
          <div class="card-label">🔴 Still open</div>
          <div class="card-num red">${c.open}</div>
          <div class="card-sub">${c.open === 0 ? 'all handled' : 'need attention'}</div>
        </div>
      </div>

      <div class="list-head">
        <h2 class="list-title">Today's escalations</h2>
        <div class="filter">
          <button class="chip ${activeFilter === 'all' ? 'active' : ''}" data-filter="all">All · ${data.escalations.length}</button>
          <button class="chip ${activeFilter === 'open' ? 'active' : ''}" data-filter="open">Open · ${c.open}</button>
          <button class="chip ${activeFilter === 'responded' ? 'active' : ''}" data-filter="responded">Responded · ${c.responded}</button>
        </div>
      </div>
      <div id="esc-list">${renderEscalationList(filtered)}</div>
      <p class="footer-note">Counters reset at 12:00 AM IST · Closed escalations move to <a href="#" data-view="history" style="color: var(--accent);">History</a></p>
    `;

    main.querySelectorAll('[data-filter]').forEach((b) => {
      b.addEventListener('click', () => { activeFilter = b.dataset.filter; renderToday(); });
    });
    main.querySelectorAll('[data-view="history"]').forEach((b) => {
      b.addEventListener('click', (e) => { e.preventDefault(); switchView({ type: 'history' }); });
    });
    wireEscalationRows();
  }

  function renderEscalationList(escalations) {
    if (escalations.length === 0) {
      return `<div class="empty-state"><div class="ic">✓</div><div>No escalations match.</div></div>`;
    }
    return escalations.map((e) => renderEscalationRow(e)).join('');
  }

  function renderEscalationRow(e) {
    const cls = e.status; // open / responded / closed
    const statusHtml = e.status === 'open'
      ? '<span class="esc-status open">● No response yet</span>'
      : e.status === 'responded'
        ? `<span class="esc-status responded">✓ ${escapeHtml(e.responded_by_name || 'Team')} responded · ${fmtAgo(e.responded_at)}</span>`
        : `<span class="esc-status closed">✓ Closed by ${escapeHtml(e.closed_by || 'unknown')} · ${fmtAgo(e.closed_at)}</span>`;
    const actionHtml = e.status === 'closed'
      ? `<button class="btn-sm" data-view-thread="${e.id}" data-group-id="${e.group_id}">View thread</button>`
      : `<button class="btn-sm primary" data-close="${e.id}">Mark closed</button>`;
    return `
      <div class="esc-row ${cls}" data-row-id="${e.id}" data-group-id="${e.group_id}">
        <div>
          <div class="esc-line-1">
            <span class="esc-group">${escapeHtml(e.group_name)}</span>
            <span class="esc-cat cat-${e.category}">${escapeHtml(e.category.replace('_', ' '))}</span>
            <span class="esc-time">${fmtClock(e.opened_at)} · ${fmtAgo(e.opened_at)}</span>
          </div>
          <div class="esc-msg">"${escapeHtml(truncate(e.opening_text, 200))}"</div>
          <div class="esc-line-3">
            <span>From: ${escapeHtml(e.opening_sender_name)}</span>
            ${statusHtml}
          </div>
        </div>
        <div class="esc-actions">${actionHtml}</div>
      </div>`;
  }

  function wireEscalationRows() {
    document.querySelectorAll('[data-row-id]').forEach((row) => {
      row.addEventListener('click', (ev) => {
        if (ev.target.closest('[data-close]') || ev.target.closest('[data-view-thread]')) return;
        const groupId = parseInt(row.dataset.groupId, 10);
        switchView({ type: 'group', id: groupId });
      });
    });
    document.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const id = parseInt(btn.dataset.close, 10);
        if (!confirm('Mark this escalation as closed?')) return;
        try {
          await api(`/api/escalations/${id}/close`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ closedBy: 'dinesh' }), // TODO: from Cognito
          });
          refresh();
        } catch (err) {
          alert('Close failed: ' + err.message);
        }
      });
    });
    document.querySelectorAll('[data-view-thread]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const groupId = parseInt(btn.dataset.groupId, 10);
        switchView({ type: 'group', id: groupId });
      });
    });
  }

  // ---------- HISTORY view ----------
  async function renderHistory() {
    const main = document.getElementById('main');

    if (!main.querySelector('#hist-list')) {
      main.innerHTML = `
        <div class="head">
          <p class="kicker">Audit trail</p>
          <h1 class="h1">History</h1>
          <p class="sub">Closed escalations · searchable across groups, dates, and closers</p>
        </div>
        <div class="history-controls">
          <div class="ctrl">
            <label>Date range</label>
            <select id="hist-days">
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90" selected>Last 90 days</option>
              <option value="365">All time</option>
            </select>
          </div>
          <div class="ctrl">
            <label>Group</label>
            <select id="hist-group"><option value="">All groups</option></select>
          </div>
          <div class="ctrl" style="flex: 1; min-width: 240px;">
            <label>Search message text</label>
            <input id="hist-q" type="text" placeholder="invoice, refund, delivery..." style="min-width: 100%;">
          </div>
        </div>
        <div class="history-summary" id="hist-summary"></div>
        <div id="hist-list"><div class="loading">Loading...</div></div>
        <p class="footer-note" id="hist-footer"></p>
      `;
      // Wire controls
      const groupSel = document.getElementById('hist-group');
      groupSel.innerHTML = '<option value="">All groups</option>' +
        allGroups.filter((g) => g.type === 'customer').map((g) =>
          `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('');
      ['hist-days', 'hist-group', 'hist-q'].forEach((id) => {
        const el = document.getElementById(id);
        el.addEventListener('change', loadHistoryRows);
        if (id === 'hist-q') {
          let t;
          el.addEventListener('input', () => { clearTimeout(t); t = setTimeout(loadHistoryRows, 300); });
        }
      });
    }
    loadHistoryRows();
  }

  async function loadHistoryRows() {
    const days = document.getElementById('hist-days').value;
    const groupId = document.getElementById('hist-group').value;
    const q = document.getElementById('hist-q').value.trim();
    const params = new URLSearchParams({ days });
    if (groupId) params.set('groupId', groupId);
    if (q) params.set('q', q);

    document.getElementById('hist-list').innerHTML = '<div class="loading">Loading...</div>';
    const data = await api('/api/history?' + params.toString());
    const stats = data.overall_stats || {};
    document.getElementById('hist-summary').innerHTML = `
      <span><strong>${data.total}</strong> closed</span>
      <span class="sep">·</span>
      <span>Avg time to close: <strong>${fmtDuration(stats.avg_close_minutes)}</strong></span>
      <span class="sep">·</span>
      <span>Avg first response: <strong>${fmtDuration(stats.avg_first_response_minutes)}</strong></span>
    `;
    document.getElementById('hist-list').innerHTML = data.escalations.length
      ? data.escalations.map((e) => renderHistoryRow(e)).join('')
      : `<div class="empty-state"><div class="ic">📜</div><div>No closed escalations match these filters.</div></div>`;
    document.getElementById('hist-footer').innerHTML = data.total > data.escalations.length
      ? `Showing ${data.escalations.length} of ${data.total}`
      : `All ${data.total} shown`;

    document.querySelectorAll('[data-view-thread]').forEach((btn) => {
      btn.addEventListener('click', () => switchView({ type: 'group', id: parseInt(btn.dataset.groupId, 10) }));
    });
  }

  function renderHistoryRow(e) {
    return `
      <div class="esc-row closed">
        <div>
          <div class="esc-line-1">
            <span class="esc-group">${escapeHtml(e.group_name)}</span>
            <span class="esc-cat cat-${e.category}">${escapeHtml(e.category.replace('_', ' '))}</span>
            <span class="esc-time">${fmtDate(e.closed_at)} · ${fmtAgo(e.closed_at)}</span>
          </div>
          <div class="esc-msg">"${escapeHtml(truncate(e.opening_text, 200))}"</div>
          <div class="esc-line-3">
            <span>From: ${escapeHtml(e.opening_sender_name)}</span>
            <span class="esc-status closed">✓ Closed by ${escapeHtml(e.closed_by || 'unknown')}</span>
          </div>
        </div>
        <div class="esc-actions">
          <button class="btn-sm" data-view-thread data-group-id="${e.group_id}">View thread</button>
        </div>
      </div>`;
  }

  // ---------- GROUP view (drilled-in) ----------
  async function renderGroup(groupId) {
    const data = await api(`/api/groups/${groupId}/conversation`);
    currentGroupData = data;
    const main = document.getElementById('main');

    const draft = document.getElementById('reply-input')?.value || '';

    const openEscalation = data.escalations.find((e) => e.status === 'open');
    const escalationBanner = openEscalation ? `
      <div class="escalation-banner">
        <div class="label">🔴 Open escalation · ${fmtAgo(openEscalation.opened_at)}, no response yet</div>
        <div class="text">"${escapeHtml(openEscalation.opening_text)}"</div>
        <div class="meta">
          <span>From: ${escapeHtml(openEscalation.opening_sender_name)}</span>
          <span>·</span>
          <span>${fmtClock(openEscalation.opened_at)} today</span>
          <span>·</span>
          <span>Category: ${escapeHtml(openEscalation.category)}</span>
        </div>
        <div class="actions">
          <button class="btn-sm primary" data-close="${openEscalation.id}">Mark closed</button>
        </div>
      </div>` : '';

    const openCount = data.escalations.filter((e) => e.status === 'open').length;
    const closedCount = data.escalations.filter((e) => e.status === 'closed').length;
    const respondedCount = data.escalations.filter((e) => e.status === 'responded').length;
    let pills = '';
    if (openCount > 0) pills += `<span class="pill crit">${openCount} open</span>`;
    if (respondedCount > 0) pills += `<span class="pill warn">${respondedCount} responded</span>`;
    if (closedCount > 0) pills += `<span class="pill ok">${closedCount} closed today</span>`;
    if (!pills) pills = '<span class="pill ok">No escalations today</span>';

    main.style.display = 'flex';
    main.style.flexDirection = 'column';
    main.innerHTML = `
      <div class="group-pane">
        <div class="group-header">
          <div>
            <button class="group-back" id="back-btn">← Back to today's escalations</button>
            <div class="group-title-row">
              <h2 class="group-title">${escapeHtml(data.group.name)}</h2>
              <span class="group-type-badge">${escapeHtml(data.group.type)}</span>
            </div>
            <p class="group-sub">${data.messages.length} messages · last activity ${
              data.messages.length ? fmtAgo(data.messages[data.messages.length - 1].timestamp) : 'never'
            }</p>
          </div>
          <div style="display: flex; flex-direction: column; gap: 8px; align-items: flex-end;">
            <button class="members-btn" id="members-btn">
              <span>👥</span><span>Members</span>
            </button>
            <div class="group-pills">${pills}</div>
          </div>
        </div>
        ${escalationBanner}
        <div class="thread" id="thread">${renderThread(data.messages)}</div>
        <div class="reply-zone">
          <div id="reply-banner-slot"></div>
          <div class="reply-meta-top">
            <span>Replying to <strong>${escapeHtml(data.group.name)}</strong> as the support number</span>
            <span>Logged as: Dinesh</span>
          </div>
          <div class="reply-input-row">
            <textarea id="reply-input" class="reply-textarea" placeholder="Reply in this group..."></textarea>
            <button id="reply-send" class="send-btn">Send</button>
          </div>
          <div class="reply-meta-bottom">
            <span><span class="ok">✓</span> Will mark this escalation as 'responded' once sent</span>
            <span id="reply-status">Press Enter to send · Shift+Enter for new line</span>
          </div>
        </div>
      </div>`;

    document.getElementById('back-btn').onclick = () => switchView({ type: 'today' });
    document.getElementById('members-btn').onclick = () => openMembersModal(data.group);
    document.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = parseInt(btn.dataset.close, 10);
        if (!confirm('Mark this escalation as closed?')) return;
        try {
          await api(`/api/escalations/${id}/close`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ closedBy: 'dinesh' }),
          });
          refresh();
        } catch (err) { alert('Close failed: ' + err.message); }
      });
    });

    // Restore draft + scroll to bottom
    if (draft) document.getElementById('reply-input').value = draft;
    const thread = document.getElementById('thread');
    thread.scrollTop = thread.scrollHeight;

    wireReplyBox(groupId);
  }

  function renderThread(messages) {
    if (!messages.length) {
      return `<div class="empty-state"><div class="ic">📭</div><div>No messages yet in this group.</div></div>`;
    }
    let html = '';
    let lastDay = '';
    for (const m of messages) {
      const day = new Date(m.timestamp).toDateString();
      if (day !== lastDay) {
        const isToday = day === new Date().toDateString();
        html += `<div class="day">${isToday ? 'Today' : fmtDate(m.timestamp)}</div>`;
        lastDay = day;
      }
      html += renderMessageBubble(m);
    }
    return html;
  }

  function renderMessageBubble(m) {
    const isUs = m.is_outbound === 1 || m.is_outbound === true;
    const cat = m.category || (isUs ? '' : 'unknown');
    const side = isUs ? 'us' : 'them';
    let body;
    if (m.text) body = escapeHtml(m.text);
    else if (m.has_media) body = `<em style="color: var(--text-3);">[${escapeHtml(m.media_type || 'media')}]</em>`;
    else body = '<em style="color: var(--text-3);">(empty)</em>';
    const sender = m.sender_name || m.sender_phone || (isUs ? 'us' : 'unknown');
    const catBadge = !isUs && cat
      ? `<span class="msg-cat cat-${cat}" style="background: rgba(255,255,255,0.04); color: var(--text-3);">${escapeHtml(cat.replace('_', ' '))}</span>`
      : '';
    return `
      <div class="msg ${side}">
        <div class="msg-sender">${escapeHtml(sender)}${catBadge}</div>
        ${body}
        <div class="msg-time">${fmtClock(m.timestamp)}</div>
      </div>`;
  }

  function wireReplyBox(groupId) {
    const input = document.getElementById('reply-input');
    const btn = document.getElementById('reply-send');
    const banner = document.getElementById('reply-banner-slot');
    const status = document.getElementById('reply-status');
    let sending = false;

    async function send() {
      const text = input.value.trim();
      if (!text || sending) return;
      sending = true;
      btn.disabled = true; input.disabled = true;
      status.textContent = 'Sending...';
      try {
        await api(`/api/groups/${groupId}/reply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, sentBy: 'dinesh' }),
        });
        input.value = '';
        status.innerHTML = '<span class="ok">✓</span> Sent';
        setTimeout(refresh, 1500);
      } catch (err) {
        const msg = String(err.message || err);
        if (msg === 'outbound_disabled') {
          banner.innerHTML = `<div class="reply-disabled-banner">⚠ Outbound disabled. Set <code>ENABLE_OUTBOUND_DMS=true</code> in <code>.env</code> and restart.</div>`;
        } else {
          status.innerHTML = `<span style="color: var(--red);">Send failed: ${escapeHtml(msg)}</span>`;
        }
      } finally {
        sending = false;
        btn.disabled = false; input.disabled = false;
      }
    }

    btn.addEventListener('click', send);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
  }

  // ---------- main refresh loop ----------
  async function refresh() {
    try {
      const sidebarData = await api('/api/sidebar');
      renderSidebar(sidebarData);

      if (currentView.type === 'today') {
        await renderToday();
      } else if (currentView.type === 'history') {
        await renderHistory();
      } else if (currentView.type === 'group') {
        const exists = allGroups.some((g) => g.id === currentView.id);
        if (!exists) { switchView({ type: 'today' }); return; }
        await renderGroup(currentView.id);
      }
    } catch (err) {
      console.error('refresh failed', err);
      document.getElementById('conn-dot').classList.add('bad');
      document.getElementById('conn-text').textContent = 'API unreachable';
    }
  }

  // ---------- MEMBERS MODAL ----------
  let modalState = { groupId: null, group: null, members: [], search: '', refreshing: false };

  function openMembersModal(group) {
    modalState.group = group;
    modalState.groupId = group.id;
    modalState.search = '';
    document.getElementById('mm-title').textContent = '👥 Members of ' + group.name;
    document.getElementById('mm-sub').textContent = 'Loading...';
    document.getElementById('mm-search').value = '';
    document.getElementById('mm-error').classList.add('hidden');
    document.getElementById('mm-body').innerHTML = '<div class="loading">Loading members...</div>';
    document.getElementById('members-modal').classList.remove('hidden');
    loadMembersData();
  }

  function closeMembersModal() {
    document.getElementById('members-modal').classList.add('hidden');
    modalState = { groupId: null, group: null, members: [], search: '', refreshing: false };
    // Refresh underlying view so any team-status changes reflect immediately
    refresh();
  }

  async function loadMembersData() {
    if (!modalState.groupId) return;
    try {
      const data = await api(`/api/groups/${modalState.groupId}/members`);
      modalState.members = data.members;
      const sub = document.getElementById('mm-sub');
      sub.textContent = `${data.counts.total} participants · ${data.counts.team} team · ${data.counts.customers} customer${data.counts.customers === 1 ? '' : 's'}`;
      if (!data.baileys_ok) {
        const err = document.getElementById('mm-error');
        err.classList.remove('hidden');
        err.textContent = 'Could not fetch live participants from WhatsApp. Showing cached data only.';
      }
      renderMembersList();
    } catch (err) {
      document.getElementById('mm-body').innerHTML = `<div class="empty-state"><div class="ic">⚠</div><div>Failed to load members: ${escapeHtml(err.message)}</div></div>`;
    }
  }

  function renderMembersList() {
    const body = document.getElementById('mm-body');
    const q = modalState.search.toLowerCase().trim();

    let filtered = modalState.members;
    if (q) {
      filtered = filtered.filter((m) => {
        const teamName = (m.is_team && m.display_name) ? m.display_name : '';
        const waName = m.activity?.sender_name || '';
        const preview = m.activity?.last_seen_text || '';
        return teamName.toLowerCase().includes(q) ||
               waName.toLowerCase().includes(q) ||
               preview.toLowerCase().includes(q) ||
               m.phone.toLowerCase().includes(q);
      });
    }

    // Sort: team first (current team always visible), then alphabetical, then unknown last
    filtered.sort((a, b) => {
      if (a.is_team !== b.is_team) return a.is_team ? -1 : 1;
      if (a.left_group !== b.left_group) return a.left_group ? 1 : -1;
      const aName = (a.is_team ? a.display_name : null) || a.activity?.sender_name || '';
      const bName = (b.is_team ? b.display_name : null) || b.activity?.sender_name || '';
      if (!aName && bName) return 1;
      if (aName && !bName) return -1;
      return aName.localeCompare(bName);
    });

    if (filtered.length === 0) {
      body.innerHTML = '<div class="empty-state">No members match.</div>';
      updateMemberCounts();
      return;
    }

    body.innerHTML = filtered.map((m) => renderMemberRow(m)).join('');
    wireMemberRows();
    updateMemberCounts();
  }

  function renderMemberRow(m) {
    const isLid = m.phone.startsWith('+227') || m.phone.length > 14;
    const avaColor = avaColorForPhone(m.phone);

    // Resolve the best name we have, in priority order:
    //   1. team_members.name (manual override, if marked as team)
    //   2. WhatsApp display name from any message they sent (pushName)
    //   3. (nothing) — only happens for silent participants
    const teamName = m.is_team ? m.display_name : null;
    const waName = m.activity?.sender_name || null;
    const bestName = teamName || waName;
    const showOverride = teamName && waName && teamName !== waName;

    const initial = (bestName || '?').charAt(0).toUpperCase();

    let nameTags = '';
    if (m.left_group) nameTags += '<span class="name-tag left">left group</span>';
    if (m.is_admin_in_group && !m.left_group) nameTags += '<span class="name-tag admin">admin</span>';
    if (m.team_role === 'bot') nameTags += '<span class="name-tag bot">bot</span>';

    let displayName;
    if (bestName) {
      displayName = `<span class="editable-name" data-rename-phone="${escapeHtml(m.phone)}">${escapeHtml(bestName)}</span>`;
      // If we're showing the team-override and the WhatsApp name differs, show it as a hint
      if (showOverride) {
        displayName += ` <span class="name-tag" style="background: rgba(255,255,255,0.04); color: var(--text-3); font-weight: 500;">aka "${escapeHtml(waName)}"</span>`;
      }
    } else {
      displayName = `<span style="color: var(--text-3); font-style: italic;">No name yet</span>`;
    }

    // Message preview — the killer feature for identifying LIDs by content
    let previewHtml = '';
    if (m.activity?.last_seen_text) {
      const preview = m.activity.last_seen_text.length > 90
        ? m.activity.last_seen_text.slice(0, 90) + '…'
        : m.activity.last_seen_text;
      previewHtml = `<div class="member-preview">"${escapeHtml(preview)}"</div>`;
    }

    let activityHtml = '';
    if (m.activity) {
      const cat = m.activity.last_category;
      const catText = cat ? ` · ${escapeHtml(cat.replace('_', ' '))}` : '';
      activityHtml = `<div class="member-activity">${m.activity.msg_count} message${m.activity.msg_count === 1 ? '' : 's'} · last ${fmtAgo(m.activity.last_seen)}${catText}</div>`;
    } else {
      activityHtml = '<div class="member-activity">No messages yet</div>';
    }

    const isBot = m.team_role === 'bot';
    // For toggle data-name: prefer best name we have so the prompt is pre-filled
    const seedName = bestName || '';
    let toggleHtml;
    if (isBot) {
      toggleHtml = `<button class="toggle-team is-team locked" title="Bot is permanently team">✓ Team (bot)</button>`;
    } else if (m.left_group) {
      toggleHtml = m.is_team
        ? `<button class="toggle-team is-team" data-toggle-phone="${escapeHtml(m.phone)}" data-currently-team="1" data-name="${escapeHtml(seedName)}">✓ Team</button>`
        : `<button class="toggle-team locked" title="Member left the group">— Left</button>`;
    } else {
      toggleHtml = m.is_team
        ? `<button class="toggle-team is-team" data-toggle-phone="${escapeHtml(m.phone)}" data-currently-team="1" data-name="${escapeHtml(seedName)}">✓ Team</button>`
        : `<button class="toggle-team" data-toggle-phone="${escapeHtml(m.phone)}" data-currently-team="0" data-name="${escapeHtml(seedName)}">+ Mark as team</button>`;
    }

    return `
      <div class="member-row ${m.is_team ? 'is-team' : ''} ${m.left_group ? 'left-group' : ''}">
        <div class="member-ava" style="background: ${avaColor};">${initial}</div>
        <div class="member-info">
          <div class="member-name">${displayName}${nameTags}</div>
          <div class="member-meta">${escapeHtml(m.phone)}${isLid ? ' <span class="meta-tag">lid</span>' : ''}</div>
          ${activityHtml}
          ${previewHtml}
        </div>
        <div>${toggleHtml}</div>
      </div>`;
  }

  function avaColorForPhone(phone) {
    const colors = [
      'linear-gradient(135deg, #6c5ce7 0%, #a29bfe 100%)',
      'linear-gradient(135deg, #fd9644 0%, #ffb88c 100%)',
      'linear-gradient(135deg, #4ec38a 0%, #88e3b6 100%)',
      'linear-gradient(135deg, #5eaaff 0%, #87c1ff 100%)',
      'linear-gradient(135deg, #e0a93f 0%, #f0c97a 100%)',
      'linear-gradient(135deg, #ef6b6b 0%, #f9a4a4 100%)',
      'linear-gradient(135deg, #94a3b8 0%, #cbd5e1 100%)',
    ];
    let hash = 0;
    for (const c of phone) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff;
    return colors[Math.abs(hash) % colors.length];
  }

  function updateMemberCounts() {
    const team = modalState.members.filter((m) => m.is_team).length;
    const customers = modalState.members.filter((m) => !m.is_team).length;
    document.getElementById('mm-counts').innerHTML = `
      <span><strong>${team}</strong> team</span>
      <span><strong>${customers}</strong> customers</span>
    `;
  }

  function wireMemberRows() {
    document.querySelectorAll('[data-toggle-phone]').forEach((btn) => {
      btn.addEventListener('click', () => toggleTeam(btn));
    });
    document.querySelectorAll('[data-rename-phone]').forEach((el) => {
      el.addEventListener('dblclick', () => startRename(el));
    });
  }

  async function toggleTeam(btn) {
    const phone = btn.getAttribute('data-toggle-phone');
    const currentlyTeam = btn.getAttribute('data-currently-team') === '1';
    const name = btn.getAttribute('data-name') || '';
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = 'Saving...';

    try {
      if (currentlyTeam) {
        await api(`/api/team-members/${encodeURIComponent(phone)}`, { method: 'DELETE' });
      } else {
        const inputName = name || prompt('Name for this team member?', '');
        if (!inputName || !inputName.trim()) {
          btn.disabled = false;
          btn.textContent = originalText;
          return;
        }
        await api('/api/team-members', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, name: inputName.trim() }),
        });
      }
      // Update local state
      const m = modalState.members.find((mm) => mm.phone === phone);
      if (m) {
        m.is_team = !currentlyTeam;
        if (!currentlyTeam && !m.display_name) {
          m.display_name = btn.dataset.name = name || '';
        }
      }
      renderMembersList();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = originalText;
      const errEl = document.getElementById('mm-error');
      errEl.classList.remove('hidden');
      errEl.textContent = `Failed: ${err.message}`;
      setTimeout(() => errEl.classList.add('hidden'), 4000);
    }
  }

  function startRename(el) {
    const phone = el.getAttribute('data-rename-phone');
    const m = modalState.members.find((mm) => mm.phone === phone);
    if (!m || !m.is_team) {
      // Only team members can be renamed (need a row in team_members table)
      return;
    }
    const original = el.textContent;
    const input = document.createElement('input');
    input.className = 'name-edit';
    input.value = original;
    el.replaceWith(input);
    input.focus();
    input.select();

    let resolved = false;
    const finish = async (commit) => {
      if (resolved) return;
      resolved = true;
      const newName = input.value.trim();
      if (!commit || !newName || newName === original) {
        const restored = makeRenameSpan(phone, original);
        input.replaceWith(restored);
        restored.addEventListener('dblclick', () => startRename(restored));
        return;
      }
      try {
        await api(`/api/team-members/${encodeURIComponent(phone)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName }),
        });
        m.display_name = newName;
        const restored = makeRenameSpan(phone, newName);
        input.replaceWith(restored);
        restored.addEventListener('dblclick', () => startRename(restored));
      } catch (err) {
        const restored = makeRenameSpan(phone, original);
        input.replaceWith(restored);
        restored.addEventListener('dblclick', () => startRename(restored));
        const errEl = document.getElementById('mm-error');
        errEl.classList.remove('hidden');
        errEl.textContent = `Rename failed: ${err.message}`;
        setTimeout(() => errEl.classList.add('hidden'), 4000);
      }
    };
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
  }

  function makeRenameSpan(phone, name) {
    const span = document.createElement('span');
    span.className = 'editable-name';
    span.dataset.renamePhone = phone;
    span.textContent = name;
    return span;
  }

  // Modal close handlers
  document.getElementById('mm-close').onclick = closeMembersModal;
  document.getElementById('mm-done').onclick = closeMembersModal;
  document.getElementById('members-modal').addEventListener('click', (e) => {
    if (e.target.id === 'members-modal') closeMembersModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('members-modal').classList.contains('hidden')) {
      closeMembersModal();
    }
  });
  document.getElementById('mm-search').addEventListener('input', (e) => {
    modalState.search = e.target.value;
    renderMembersList();
  });

  // search input
  document.getElementById('search-box').addEventListener('input', renderGroupsList);

  // initial + every 5s
  refresh();
  setInterval(refresh, 5000);
})();
