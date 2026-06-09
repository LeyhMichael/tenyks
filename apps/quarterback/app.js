// ── State ─────────────────────────────────────────────────────────────────────

const BASE = '/' + window.location.pathname.split('/').filter(Boolean)[0];
const API  = BASE + '/api';
const FLAGS = {
  DEU:'🇩🇪', GBR:'🇬🇧', CHE:'🇨🇭', FRA:'🇫🇷', USA:'🇺🇸', NOR:'🇳🇴',
  SGP:'🇸🇬', AUT:'🇦🇹', AUS:'🇦🇺', IND:'🇮🇳', NLD:'🇳🇱', BEL:'🇧🇪',
  SWE:'🇸🇪', DNK:'🇩🇰', ESP:'🇪🇸',
};

let state = {
  requests: [], team: [], teamNames: [], blocked: {}, blockReasons: {},
  unassignedCount: 0, weekLabels: [], todayLabel: '', maxRequests: 14,
  staffingMonth: monthKey(new Date()),
  ptoMonth: monthKey(new Date()),
  staffingData: {}, ptoData: {}, teamNamesLoaded: [],
  backlogItems: [],
  agentRecs: [],
};

// ── Utilities ─────────────────────────────────────────────────────────────────

function monthKey(d) {
  return d.toISOString().slice(0, 7);
}

function addMonths(key, n) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return monthKey(d);
}

function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

function daysInMonth(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function dayOfWeek(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').getUTCDay(); // 0=Sun
}

function isWeekend(dateStr) {
  const d = dayOfWeek(dateStr);
  return d === 0 || d === 6;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function statusBadge(status) {
  const map = { Working: 'badge-working', Backlog: 'badge-backlog-status', Complete: 'badge-complete',
                'On Hold': 'badge-on-hold', Deprioritized: 'badge-deprio' };
  return `<span class="badge ${map[status] || 'badge-backlog-status'}">${status}</span>`;
}

function priorityBadge(p) {
  const map = { High: 'badge-high', Medium: 'badge-medium', Low: 'badge-low', Unset: 'badge-unset' };
  return `<span class="badge ${map[p] || 'badge-unset'}">${p || 'Unset'}</span>`;
}

// ── API fetch helper ──────────────────────────────────────────────────────────

async function apiFetch(url, options) {
  const r = await fetch(url, options);
  if (!r.ok) {
    let msg;
    try {
      const data = await r.json();
      msg = data.error || JSON.stringify(data);
    } catch {
      msg = (await r.text().catch(() => '')) || r.statusText;
    }
    throw new Error(`[${r.status}] ${msg}`);
  }
  return r.json();
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 5000);
}

// ── Tab switching ─────────────────────────────────────────────────────────────

document.querySelectorAll('.nav-tab[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.nav-tab[data-tab]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.getElementById('tab-' + tab).classList.add('active');

    if (tab === 'staffing') loadStaffingTab();
    if (tab === 'pto')      loadPtoTab();
    if (tab === 'backlog')  loadBacklogTab();
  });
});

// ── Initial load ──────────────────────────────────────────────────────────────

async function loadRequests() {
  try {
    const data = await apiFetch(`${API}/requests`);
    Object.assign(state, {
      requests: data.requests, team: data.team, teamNames: data.team_names,
      blocked: data.blocked, blockReasons: data.block_reasons,
      unassignedCount: data.unassigned_count, weekLabels: data.week_labels,
      todayLabel: data.today_label, maxRequests: data.max_requests,
    });
    renderStats();
    renderRequestsPanel();
    renderCapacityPanel();
  } catch (err) {
    document.getElementById('requestsContent').innerHTML =
      `<div class="empty-state"><div class="icon">⚠️</div><p>Failed to load: ${err.message}</p></div>`;
  }
}

loadRequests();

// ── Stats bar ─────────────────────────────────────────────────────────────────

function renderStats() {
  const s = state;
  const blockedCount = s.team.filter(m => m.is_blocked).length;
  let html = `
    <div class="stat-chip urgent"><div class="stat-dot dot-red"></div>${s.unassignedCount} Unassigned</div>
    <div class="stat-chip active"><div class="stat-dot dot-blue"></div>${s.requests.length} Active</div>
    <div class="stat-chip team"><div class="stat-dot dot-green"></div>${s.team.length} Active This Week</div>
  `;
  if (blockedCount > 0)
    html += `<div class="stat-chip blocked"><div class="stat-dot dot-red"></div>${blockedCount} Blocked</div>`;
  document.getElementById('statsBar').innerHTML = html;
  document.getElementById('capSublabel').textContent = `Max ${s.maxRequests} req/week`;
}

// ── Requests panel ────────────────────────────────────────────────────────────

function renderRequestsPanel() {
  const unassigned = state.requests.filter(r => r.is_unassigned);
  const assigned   = state.requests.filter(r => !r.is_unassigned);
  let html = '';

  if (unassigned.length) {
    html += `<div class="section-label unassigned">⚡ Needs Assignment (${unassigned.length})</div>`;
    html += unassigned.map(r => requestCard(r)).join('');
  }
  if (assigned.length) {
    html += `<div class="section-label assigned">Already Assigned (${assigned.length})</div>`;
    html += assigned.map(r => requestCard(r)).join('');
  }
  if (!html) html = `<div class="empty-state"><div class="icon">✅</div><p>No active requests</p></div>`;

  document.getElementById('requestsContent').innerHTML = html;
}

function requestCard(r) {
  const isUnassigned = r.is_unassigned;
  const statusBadgeHtml = {
    'New': '<span class="badge badge-new">New</span>',
    'Assigned': '<span class="badge badge-assigned">Assigned</span>',
    'Work in progress': '<span class="badge badge-wip">In Progress</span>',
  }[r.status] || `<span class="badge">${r.status}</span>`;

  const assigneeBadge = !isUnassigned
    ? `<span class="badge badge-person">${r.assigned_to}</span>` : '';

  const blockBadge = !isUnassigned && state.blocked[r.assigned_to]
    ? `<span class="badge badge-blocked">${blockLabel(state.blockReasons[r.assigned_to])}</span>` : '';

  const unassignedBadge = isUnassigned ? `<span class="badge badge-unassigned">Unassigned</span>` : '';

  const opts = state.teamNames.map(name => {
    const isBlocked = state.blocked[name];
    const label = isBlocked ? `${name} ${blockLabel(state.blockReasons[name])}` : name;
    return `<option value="${name}" ${isBlocked ? 'disabled' : ''} ${!isUnassigned && r.assigned_to === name ? 'selected' : ''}>${label}</option>`;
  }).join('');

  const btnLabel = isUnassigned ? 'Assign →' : 'Reassign →';

  return `
  <div class="request-card ${isUnassigned ? 'unassigned-card' : ''}" id="card-${r.number}">
    <div class="card-top">
      <span class="card-number">${r.number}</span>
      ${statusBadgeHtml}
    </div>
    <div class="card-desc">${escHtml(r.short_description)}</div>
    <div class="card-meta">
      <span>👤 ${escHtml(r.requestor)}</span>
      ${r.created_date ? `<span>📅 ${r.created_date}</span>` : ''}
      ${r.deadline ? `<span>⏰ ${r.deadline}</span>` : ''}
    </div>
    <div class="badges">${unassignedBadge}${assigneeBadge}${blockBadge}</div>
    <div class="assign-row">
      <select id="sel-${r.number}">
        <option value="">— ${isUnassigned ? 'Assign to team member' : 'Reassign'} —</option>
        ${opts}
      </select>
      <button onclick="assign('${r.number}')">${btnLabel}</button>
    </div>
    <div class="success-msg" id="msg-${r.number}">✓ ${isUnassigned ? 'Assigned' : 'Reassigned'}!</div>
  </div>`;
}

function blockLabel(reason) {
  if (!reason) return '🔴 (Staffed)';
  if (reason.includes('pto')) return '🏖️ (PTO)';
  if (reason.includes('training')) return '📚 (Training)';
  if (reason.includes('event')) return '🎉 (Event)';
  return '🔴 (Staffed)';
}

async function assign(number) {
  const assignee = document.getElementById('sel-' + number)?.value;
  if (!assignee) return toast('Please select a team member first', 'warn');
  try {
    const data = await fetch(`${API}/assign`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number, assignee }),
    }).then(r => r.json());

    if (data.error) return toast('⛔ ' + data.error, 'error');
    const msg = document.getElementById('msg-' + number);
    if (msg) msg.style.display = 'block';
    setTimeout(loadRequests, 1200);
  } catch (err) {
    toast('Assignment failed: ' + err.message, 'error');
  }
}

// ── Capacity panel ────────────────────────────────────────────────────────────

function renderCapacityPanel() {
  if (!state.team.length) {
    document.getElementById('capacityContent').innerHTML =
      `<div class="empty-state"><div class="icon">✅</div><p>No active assignments this week</p></div>`;
    return;
  }
  document.getElementById('capacityContent').innerHTML =
    state.team.map(m => memberCard(m)).join('');
}

function memberCard(m) {
  const statusLabel = {
    blocked: blockLabel(m.block_reason),
    full: '🔴 Full', warn: '🟡 Limited', ok: '🟢 Available',
  }[m.status];

  const fillClass = { blocked: 'fill-red', full: 'fill-red', warn: 'fill-yellow', ok: 'fill-green' }[m.status];

  const metaHtml = m.is_blocked
    ? `${blockLabel(m.block_reason)} · Cannot take requests`
    : `${m.total} / ${state.maxRequests} requests · ${m.effective_cap} cap this week`;

  const spilloverHtml = m.spillover > 0
    ? `<span class="spillover-badge">↩ ${m.spillover} spillover</span>` : '';

  const barHtml = !m.is_blocked ? `
    <div class="week-bar-track"><div class="week-bar-fill ${fillClass}" style="width:${m.pct}%"></div></div>
    <div class="week-bar-label"><span>0</span><span>${state.maxRequests}</span></div>
    <div class="day-grid">
      ${state.weekLabels.map(day => {
        const count = m.daily[day] || 0;
        const cls = count === 0 ? 'count-0' : count <= 2 ? 'count-low' : count <= 4 ? 'count-mid' : 'count-high';
        return `<div class="day-cell ${day === state.todayLabel ? 'today' : ''}">
          <div class="day-name">${day}</div>
          <div class="day-count ${cls}">${count}</div>
          <div class="day-pill">req</div>
        </div>`;
      }).join('')}
    </div>` : '';

  return `
  <div class="member-card ${m.is_blocked ? 'blocked-card' : ''}">
    <div class="member-top">
      <div class="member-name">${escHtml(m.name)}</div>
      <span class="member-status status-${m.status}">${statusLabel}</span>
    </div>
    <div class="member-meta">${metaHtml} ${spilloverHtml}</div>
    ${barHtml}
  </div>`;
}

// ── Staffing tab ──────────────────────────────────────────────────────────────

async function loadStaffingTab() {
  document.getElementById('staffingMonthLabel').textContent = monthLabel(state.staffingMonth);
  try {
    const [staffingData, teamData] = await Promise.all([
      apiFetch(`${API}/staffing?month=${state.staffingMonth}`),
      apiFetch(`${API}/team`),
    ]);
    state.staffingData = staffingData;
    state.teamNamesLoaded = teamData.team_names;
    renderCalendar('staffing');
  } catch (err) {
    document.getElementById('staffingCal').innerHTML = `<p style="color:#f87171">Error: ${err.message}</p>`;
  }
}

async function loadPtoTab() {
  document.getElementById('ptoMonthLabel').textContent = monthLabel(state.ptoMonth);
  try {
    const [ptoData, teamData] = await Promise.all([
      apiFetch(`${API}/pto?month=${state.ptoMonth}`),
      apiFetch(`${API}/team`),
    ]);
    state.ptoData = ptoData;
    state.teamNamesLoaded = teamData.team_names;
    renderCalendar('pto');
  } catch (err) {
    document.getElementById('ptoCal').innerHTML = `<p style="color:#f87171">Error: ${err.message}</p>`;
  }
}

function changeMonth(type, delta) {
  if (type === 'staffing') {
    state.staffingMonth = addMonths(state.staffingMonth, delta);
    loadStaffingTab();
  } else {
    state.ptoMonth = addMonths(state.ptoMonth, delta);
    loadPtoTab();
  }
}

function renderCalendar(type) {
  const monthKey = type === 'staffing' ? state.staffingMonth : state.ptoMonth;
  const data     = type === 'staffing' ? state.staffingData  : state.ptoData;
  const names    = state.teamNamesLoaded;
  const today    = todayStr();
  const days     = daysInMonth(monthKey);
  const [y, m]   = monthKey.split('-').map(Number);

  const dateStrs = Array.from({ length: days }, (_, i) => {
    const d = String(i + 1).padStart(2, '0');
    return `${y}-${String(m).padStart(2, '0')}-${d}`;
  });

  let html = '<table class="cal-table"><thead><tr>';
  html += '<th style="min-width:140px;">Member</th>';
  for (const d of dateStrs) {
    const isToday   = d === today;
    const weekend   = isWeekend(d);
    const day       = d.slice(8);
    const dayAbbr   = ['Su','Mo','Tu','We','Th','Fr','Sa'][dayOfWeek(d)];
    const cls       = isToday ? 'today-col' : weekend ? 'weekend' : '';
    html += `<th class="${cls}">${day}<br><span style="font-weight:400;">${dayAbbr}</span></th>`;
  }
  html += '</tr></thead><tbody>';

  for (const name of names) {
    html += `<tr><td class="name-cell">${escHtml(name)}</td>`;
    for (const d of dateStrs) {
      const weekend = isWeekend(d);
      const isToday = d === today;
      let cellClass = 'day-cell-cal';
      let inner = '';

      if (weekend) {
        cellClass += ' weekend-cell';
        html += `<td class="${cellClass}"><div class="cal-cell-inner" style="color:#1e2433">·</div></td>`;
        continue;
      }

      if (isToday) cellClass += ' today-cell';

      if (type === 'staffing') {
        const pct = (data[name] || {})[d] ?? null;
        const pctClass = pct === null ? 'cal-pct-0' : `cal-pct-${pct}`;
        const label    = pct !== null ? `${pct}%` : '';
        inner = `<div class="cal-cell-inner ${pctClass}">${label}</div>`;
        html += `<td class="${cellClass}" onclick="openStaffingPopup('${name}','${d}',this)">${inner}</td>`;
      } else {
        const ptoType = (data[name] || {})[d] || null;
        const ptoClass = ptoType ? `cal-${ptoType.toLowerCase()}` : 'cal-pct-0';
        const emoji    = { PTO: '🏖️', Training: '📚', Event: '🎉' }[ptoType] || '';
        inner = `<div class="cal-cell-inner ${ptoClass}">${emoji}</div>`;
        html += `<td class="${cellClass}" onclick="openPtoPopup('${name}','${d}',this)">${inner}</td>`;
      }
    }
    html += '</tr>';
  }

  html += '</tbody></table>';
  document.getElementById(type + 'Cal').innerHTML = html;
}

// ── Calendar popup ────────────────────────────────────────────────────────────

let _popupTarget = null;

function openStaffingPopup(name, date, cell) {
  _popupTarget = { type: 'staffing', name, date, cell };
  const cur = (state.staffingData[name] || {})[date] ?? null;
  document.getElementById('calPopupTitle').textContent = `${name} · ${date}`;
  document.getElementById('calPopupBtns').innerHTML = [0, 25, 50, 75, 100].map(pct =>
    `<button class="cal-popup-btn ${cur === pct ? 'active' : ''}" onclick="setStaffing('${name}','${date}',${pct})">${pct}%${cur === pct ? ' ✓' : ''}</button>`
  ).join('');
  positionPopup(cell);
}

function openPtoPopup(name, date, cell) {
  _popupTarget = { type: 'pto', name, date, cell };
  const cur = (state.ptoData[name] || {})[date] || null;
  document.getElementById('calPopupTitle').textContent = `${name} · ${date}`;
  document.getElementById('calPopupBtns').innerHTML = [
    { label: '✕ Clear', value: '' },
    { label: '🏖️ PTO', value: 'PTO' },
    { label: '📚 Training', value: 'Training' },
    { label: '🎉 Event', value: 'Event' },
  ].map(({ label, value }) =>
    `<button class="cal-popup-btn ${cur === value || (!cur && !value) ? 'active' : ''}" onclick="setPto('${name}','${date}','${value}')">${label}${(cur === value || (!cur && !value)) ? ' ✓' : ''}</button>`
  ).join('');
  positionPopup(cell);
}

function positionPopup(cell) {
  const popup = document.getElementById('calPopup');
  popup.style.display = 'block';
  const rect = cell.getBoundingClientRect();
  const top  = Math.min(rect.bottom + 6, window.innerHeight - 200);
  const left = Math.min(rect.left, window.innerWidth - 200);
  popup.style.top  = top + 'px';
  popup.style.left = left + 'px';
}

function closeCalPopup() {
  document.getElementById('calPopup').style.display = 'none';
  _popupTarget = null;
}

document.addEventListener('click', e => {
  const popup = document.getElementById('calPopup');
  if (popup.style.display !== 'none' && !popup.contains(e.target) && !e.target.closest('.day-cell-cal'))
    closeCalPopup();
});

async function setStaffing(name, date, pct) {
  closeCalPopup();
  try {
    const data = await fetch(`${API}/staffing`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, date, pct }),
    }).then(r => r.json());

    if (!state.staffingData[name]) state.staffingData[name] = {};
    state.staffingData[name][date] = pct;
    renderCalendar('staffing');

    if (data.reassigned > 0)
      toast(`↩ ${data.reassigned} request(s) reassigned back to queue`, 'warn');
  } catch (err) {
    toast('Failed to update staffing: ' + err.message, 'error');
  }
}

async function setPto(name, date, type) {
  closeCalPopup();
  try {
    const data = await fetch(`${API}/pto`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, date, type }),
    }).then(r => r.json());

    if (!state.ptoData[name]) state.ptoData[name] = {};
    if (type) state.ptoData[name][date] = type;
    else delete state.ptoData[name][date];
    renderCalendar('pto');

    if (data.reassigned > 0)
      toast(`↩ ${data.reassigned} request(s) reassigned back to queue`, 'warn');
  } catch (err) {
    toast('Failed to update PTO: ' + err.message, 'error');
  }
}

// ── Backlog tab ───────────────────────────────────────────────────────────────

async function loadBacklogTab() {
  try {
    state.backlogItems = await apiFetch(`${API}/backlog`);
    populateGroupFilter();
    renderBacklog();
  } catch (err) {
    document.getElementById('backlogContent').innerHTML =
      `<div class="empty-state"><div class="icon">⚠️</div><p>Error: ${err.message}</p></div>`;
  }
}

function populateGroupFilter() {
  const groups = [...new Set(state.backlogItems.map(i => i.group).filter(Boolean))].sort();
  const sel = document.getElementById('blGroup');
  const cur = sel.value;
  sel.innerHTML = '<option value="">All Groups</option>' +
    groups.map(g => `<option ${g === cur ? 'selected' : ''}>${escHtml(g)}</option>`).join('');
}

function renderBacklog() {
  const search   = document.getElementById('blSearch').value.toLowerCase();
  const group    = document.getElementById('blGroup').value;
  const status   = document.getElementById('blStatus').value;
  const priority = document.getElementById('blPriority').value;

  let items = state.backlogItems.filter(i =>
    (!search   || i.name.toLowerCase().includes(search) || i.lead.toLowerCase().includes(search)) &&
    (!group    || i.group === group) &&
    (!status   || i.status === status) &&
    (!priority || i.priority === priority)
  );

  const grouped = {};
  for (const i of items) {
    const g = i.group || 'Ungrouped';
    if (!grouped[g]) grouped[g] = [];
    grouped[g].push(i);
  }

  if (!items.length) {
    document.getElementById('backlogContent').innerHTML =
      `<div class="empty-state"><div class="icon">📋</div><p>No items match your filters</p></div>`;
    return;
  }

  let html = '';
  for (const [groupName, rows] of Object.entries(grouped)) {
    const id = 'bg-' + groupName.replace(/\W/g, '_');
    html += `
    <div class="group-section">
      <div class="group-header" onclick="toggleGroup('${id}')">
        <span class="group-toggle open" id="toggle-${id}">▶</span>
        <span class="group-title">${escHtml(groupName)}</span>
        <span class="group-count">${rows.length} item${rows.length !== 1 ? 's' : ''}</span>
      </div>
      <div id="${id}">
        <div class="backlog-table-wrap">
          <table class="backlog-table">
            <thead>
              <tr>
                <th>Name</th><th>Lead</th><th>Status</th><th>Priority</th>
                <th>Timeline</th><th>Hours</th><th>Alloc %</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(i => `
              <tr onclick="openBacklogModal(${JSON.stringify(i).replace(/"/g,'&quot;')})">
                <td>${escHtml(i.name)}</td>
                <td>${escHtml(i.lead)}</td>
                <td>${statusBadge(i.status)}</td>
                <td>${priorityBadge(i.priority)}</td>
                <td style="font-size:11px;color:#6b7280;">${i.start_date && i.end_date ? `${i.start_date} → ${i.end_date}` : i.start_date || '—'}</td>
                <td>${i.hours || '—'}</td>
                <td>${i.allocation_pct ? i.allocation_pct + '%' : '—'}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
  }
  document.getElementById('backlogContent').innerHTML = html;
}

function toggleGroup(id) {
  const el = document.getElementById(id);
  const tog = document.getElementById('toggle-' + id);
  const hidden = el.style.display === 'none';
  el.style.display = hidden ? '' : 'none';
  tog.classList.toggle('open', hidden);
}

// ── Backlog modal ─────────────────────────────────────────────────────────────

function openBacklogModal(item) {
  const isNew = !item;
  document.getElementById('backlogModalTitle').textContent = isNew ? 'New Project' : 'Edit Project';
  document.getElementById('blDeleteBtn').style.display = isNew ? 'none' : 'inline-flex';
  document.getElementById('blId').value = item?.id || '';
  document.getElementById('blName').value = item?.name || '';
  document.getElementById('blGroupField').value = item?.group || 'IP & Product';
  document.getElementById('blStatusField').value = item?.status || 'Backlog';
  document.getElementById('blPriorityField').value = item?.priority || 'Unset';
  document.getElementById('blAllocation').value = item?.allocation_pct || '';
  document.getElementById('blLead').value = item?.lead || '';
  document.getElementById('blTeam').value = item?.team || '';
  document.getElementById('blStartDate').value = item?.start_date || '';
  document.getElementById('blEndDate').value = item?.end_date || '';
  document.getElementById('blHours').value = item?.hours || '';
  document.getElementById('blPractice').value = item?.practice || '';
  document.getElementById('blStakeholders').value = item?.stakeholders || '';
  document.getElementById('backlogOverlay').classList.add('show');
}

function closeBacklogModal() {
  document.getElementById('backlogOverlay').classList.remove('show');
}

async function saveBacklogItem() {
  const id = document.getElementById('blId').value;
  const payload = {
    id: id ? parseInt(id) : null,
    name:          document.getElementById('blName').value,
    group:         document.getElementById('blGroupField').value,
    status:        document.getElementById('blStatusField').value,
    priority:      document.getElementById('blPriorityField').value,
    allocation_pct:document.getElementById('blAllocation').value,
    lead:          document.getElementById('blLead').value,
    team:          document.getElementById('blTeam').value,
    start_date:    document.getElementById('blStartDate').value,
    end_date:      document.getElementById('blEndDate').value,
    hours:         document.getElementById('blHours').value,
    practice:      document.getElementById('blPractice').value,
    stakeholders:  document.getElementById('blStakeholders').value,
  };
  try {
    const data = await fetch(`${API}/backlog/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(r => r.json());
    if (data.error) return toast(data.error, 'error');
    closeBacklogModal();
    await loadBacklogTab();
  } catch (err) {
    toast('Failed to save: ' + err.message, 'error');
  }
}

async function deleteBacklogItem() {
  const id = document.getElementById('blId').value;
  if (!id || !confirm('Delete this item?')) return;
  try {
    await fetch(`${API}/backlog/delete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: parseInt(id) }),
    });
    closeBacklogModal();
    await loadBacklogTab();
  } catch (err) {
    toast('Failed to delete: ' + err.message, 'error');
  }
}

// ── Agent modal ───────────────────────────────────────────────────────────────

function openAgent() {
  const btn = document.getElementById('agentBtn');
  btn.disabled = true;
  btn.textContent = '⏳ Running…';
  document.getElementById('agentOverlay').classList.add('show');
  document.getElementById('agentLoading').style.display = 'flex';
  document.getElementById('agentResults').style.display = 'none';
  document.getElementById('agentSubtitle').textContent = 'Claude is analysing your team…';

  apiFetch(`${API}/agent/run`, { method: 'POST' })
    .then(data => {
      btn.textContent = '🤖 Run Agent';
      btn.disabled = false;
      document.getElementById('agentLoading').style.display = 'none';
      document.getElementById('agentResults').style.display = 'block';

      const recs = (data.recommendations || []).map(r => ({ ...r, _status: 'pending' }));
      state.agentRecs = recs;
      document.getElementById('agentSubtitle').textContent = data.summary || '';
      document.getElementById('agentSummaryBar').textContent = data.summary || '';
      renderAgentRecs();
    })
    .catch(err => {
      btn.textContent = '🤖 Run Agent';
      btn.disabled = false;
      document.getElementById('agentLoading').style.display = 'none';
      document.getElementById('agentResults').style.display = 'block';
      document.getElementById('agentRecs').innerHTML =
        `<div style="color:#f87171;padding:20px;text-align:center;">⚠️ ${escHtml(err.message)}</div>`;
    });
}

function closeAgent() {
  document.getElementById('agentOverlay').classList.remove('show');
}

function renderAgentRecs() {
  const recs = state.agentRecs;
  updateAgentCount();

  if (!recs.length) {
    document.getElementById('agentRecs').innerHTML =
      `<div style="color:#6b7280;text-align:center;padding:40px;">
        <div style="font-size:32px;margin-bottom:12px;">✅</div>
        <div>All requests are already assigned — nothing to do!</div>
      </div>`;
    return;
  }

  document.getElementById('agentRecs').innerHTML = recs.map((r, i) => {
    const reqCountry      = r.country || '';
    const assigneeCountry = r.assignee_country || '';
    const isMatch         = reqCountry && assigneeCountry && reqCountry === assigneeCountry;
    const remaining       = parseInt((r.reason || '').match(/(\d+)\s*(?:slot|remaining)/)?.[1]) ?? '?';
    const capPct          = remaining === '?' ? 50 : Math.round(((state.maxRequests - remaining) / state.maxRequests) * 100);
    const capColor        = remaining === '?' ? '#f59e0b' : capPct >= 100 ? '#ef4444' : capPct >= 60 ? '#f59e0b' : '#10b981';

    return `
    <div class="agent-rec-card ${r._status === 'applied' ? 'rec-applied' : r._status === 'skipped' ? 'rec-skipped' : ''}" id="rec-${i}">
      <div class="rec-card-header">
        <span class="rec-number-tag">${r.number}</span>
        <span class="rec-status-badge badge-${r._status}" id="rec-badge-${i}">${r._status === 'applied' ? '✅ Applied' : r._status === 'skipped' ? 'Skipped' : 'Pending'}</span>
      </div>
      <div class="rec-description">${escHtml(r.short_description || r.number)}</div>
      <div class="rec-match-flow">
        <div class="match-origin">
          <div class="match-flag">${FLAGS[reqCountry] || '🌍'}</div>
          <div class="match-country-code">${reqCountry || '—'}</div>
        </div>
        <div class="match-arrow-zone">
          <div class="match-arrow-line"></div>
          <span class="match-label-tag ${isMatch ? 'match-exact' : 'match-fallback'}">
            ${isMatch ? '🎯 Country Match' : '⚡ Best Available'}
          </span>
        </div>
        <div class="match-dest">
          <div class="match-dest-name">${FLAGS[assigneeCountry] || '🌍'} ${escHtml(r.assignee)}</div>
          <div class="match-dest-cap">
            <div class="cap-bar-mini"><div class="cap-bar-fill" style="width:${capPct}%;background:${capColor}"></div></div>
            <span class="cap-text">${remaining} free</span>
          </div>
        </div>
      </div>
      <div class="rec-reason">${escHtml(r.reason || '')}</div>
      <div class="rec-card-actions">
        <button class="rec-apply-btn" id="apply-${i}" onclick="applySingle(${i})" ${r._status !== 'pending' ? 'disabled' : ''}>Apply →</button>
        <button class="rec-skip-btn"  id="skip-${i}"  onclick="skipSingle(${i})"  ${r._status !== 'pending' ? 'disabled' : ''}>Skip</button>
      </div>
    </div>`;
  }).join('');
}

function updateAgentCount() {
  const recs    = state.agentRecs;
  const pending = recs.filter(r => r._status === 'pending').length;
  const applied = recs.filter(r => r._status === 'applied').length;
  document.getElementById('agentPendingCount').textContent = `${applied} applied · ${pending} pending`;
  document.getElementById('applyAllBtn').disabled = pending === 0;
}

async function applySingle(i) {
  const rec = state.agentRecs[i];
  if (!rec || rec._status !== 'pending') return;
  document.getElementById(`apply-${i}`).disabled = true;
  document.getElementById(`apply-${i}`).textContent = '…';
  try {
    const data = await fetch(`${API}/assign`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: rec.number, assignee: rec.assignee }),
    }).then(r => r.json());
    if (data.error) { toast('⛔ ' + data.error, 'error'); document.getElementById(`apply-${i}`).textContent = 'Apply →'; document.getElementById(`apply-${i}`).disabled = false; return; }
    rec._status = 'applied';
    markRecApplied(i);
    updateAgentCount();
  } catch (err) {
    toast('Error: ' + err.message, 'error');
  }
}

function skipSingle(i) {
  const rec = state.agentRecs[i];
  if (!rec || rec._status !== 'pending') return;
  rec._status = 'skipped';
  const card = document.getElementById(`rec-${i}`);
  if (card) card.classList.add('rec-skipped');
  const badge = document.getElementById(`rec-badge-${i}`);
  if (badge) { badge.textContent = 'Skipped'; badge.className = 'rec-status-badge badge-skipped'; }
  document.getElementById(`apply-${i}`).disabled = true;
  document.getElementById(`skip-${i}`).disabled  = true;
  updateAgentCount();
}

function markRecApplied(i) {
  const card  = document.getElementById(`rec-${i}`);
  const badge = document.getElementById(`rec-badge-${i}`);
  const applyBtn = document.getElementById(`apply-${i}`);
  const skipBtn  = document.getElementById(`skip-${i}`);
  if (card)  { card.classList.remove('rec-skipped'); card.classList.add('rec-applied'); }
  if (badge) { badge.textContent = '✅ Applied'; badge.className = 'rec-status-badge badge-applied'; }
  if (applyBtn) { applyBtn.textContent = '✓ Applied'; applyBtn.style.cssText = 'background:rgba(16,185,129,0.15);border-color:rgba(16,185,129,0.4);color:#34d399'; }
  if (skipBtn) skipBtn.disabled = true;
}

async function applyAllRecs() {
  const pending = state.agentRecs.filter(r => r._status === 'pending');
  if (!pending.length) return;
  const btn = document.getElementById('applyAllBtn');
  btn.disabled = true; btn.textContent = '⏳ Applying…';
  try {
    const data = await fetch(`${API}/agent/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recommendations: pending }),
    }).then(r => r.json());

    pending.forEach(rec => {
      rec._status = 'applied';
      markRecApplied(state.agentRecs.indexOf(rec));
    });
    updateAgentCount();
    setTimeout(() => { closeAgent(); loadRequests(); }, 1000);
  } catch (err) {
    btn.disabled = false; btn.textContent = '✅ Apply All';
    toast('Error: ' + err.message, 'error');
  }
}

// ── XSS helper ────────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
