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
  staffingItems: [], ptoItems: [], teamNamesLoaded: [],
  backlogItems: [],
  agentRecs: [],
  workloadOffset: 0, workloadData: null,
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

// ── Name formatter ────────────────────────────────────────────────────────────
// Names are stored "LastName FirstName" in DB → display as "FirstName LastName"

function formatName(name) {
  if (!name) return '';
  // Strip BCG office disambiguators like "(BKA)", "(GUK)", etc.
  const clean = name.trim().replace(/\s*\([A-Z]{2,}\)\s*$/, '');
  const parts = clean.split(/\s+/);
  if (parts.length < 2) return clean;
  return parts.slice(1).join(' ') + ' ' + parts[0];
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

function activateTab(tab) {
  document.querySelectorAll('.nav-tab[data-tab]').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector(`.nav-tab[data-tab="${tab}"]`);
  if (btn) btn.classList.add('active');
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  const panel = document.getElementById('tab-' + tab);
  if (panel) panel.classList.add('active');
  if (tab === 'staffing') loadStaffingTab();
  if (tab === 'pto')      loadPtoTab();
  if (tab === 'backlog')  loadBacklogTab();
  if (tab === 'workload') loadWorkloadTab();
}

document.querySelectorAll('.nav-tab[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    history.pushState({ tab }, '', '#' + tab);
    activateTab(tab);
  });
});

// Restore tab from hash on load or when back/forward is pressed
window.addEventListener('popstate', (e) => {
  const tab = (e.state && e.state.tab) || window.location.hash.replace('#', '') || 'requests';
  activateTab(tab);
});

// On initial load, honour the hash if present
(function initTabFromHash() {
  const hash = window.location.hash.replace('#', '');
  if (hash && document.getElementById('tab-' + hash)) {
    activateTab(hash);
  }
})();

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
  const blockedCount = Object.keys(s.blocked).length;
  let html = `<div class="stat-chip urgent"><div class="stat-dot dot-red"></div>${s.unassignedCount} requests unassigned</div>`;
  if (blockedCount > 0)
    html += `<div class="stat-chip staffed"><div class="stat-dot dot-purple"></div>${blockedCount} member${blockedCount > 1 ? 's' : ''} ≥75% blocked</div>`;
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
    ? `<span class="badge badge-person">${formatName(r.assigned_to)}</span>` : '';

  const blockBadge = !isUnassigned && state.blocked[r.assigned_to]
    ? `<span class="badge badge-blocked">🔴 Blocked</span>` : '';

  const unassignedBadge = isUnassigned ? `<span class="badge badge-unassigned">Unassigned</span>` : '';

  const opts = state.teamNames.map(name => {
    const isBlocked = state.blocked[name];
    const label = isBlocked ? `${formatName(name)} 🔴` : formatName(name);
    return `<option value="${name}" ${isBlocked ? 'disabled' : ''} ${!isUnassigned && r.assigned_to === name ? 'selected' : ''}>${label}</option>`;
  }).join('');

  const btnLabel = isUnassigned ? 'Assign →' : 'Reassign →';

  return `
  <div class="request-card ${isUnassigned ? 'unassigned-card' : ''}" id="card-${r.number}" onclick="openRequestDetail('${r.number}')" style="cursor:pointer;">
    <div class="card-top">
      <span class="card-number">${r.number}</span>
      ${statusBadgeHtml}
    </div>
    <div class="card-desc">${escHtml(r.short_description)}</div>
    <div class="card-meta">
      <span>👤 ${escHtml(formatName(r.requestor))}</span>
      ${r.created_date ? `<span>📅 ${r.created_date}</span>` : ''}
      ${r.deadline ? `<span>⏰ ${r.deadline}</span>` : ''}
    </div>
    <div class="badges">${unassignedBadge}${assigneeBadge}${blockBadge}</div>
    <div class="assign-row" onclick="event.stopPropagation()">
      <select id="sel-${r.number}">
        <option value="">— ${isUnassigned ? 'Assign to team member' : 'Reassign'} —</option>
        ${opts}
      </select>
      <button onclick="assign('${r.number}')">${btnLabel}</button>
    </div>
    <div class="success-msg" id="msg-${r.number}">✓ ${isUnassigned ? 'Assigned' : 'Reassigned'}!</div>
  </div>`;
}

// reasons is string[] like ["Case (50%)", "PTO (100%)"]
function blockLabel(reasons) {
  if (!reasons || !reasons.length) return '🔴';
  return reasons.map(r => {
    const l = r.toLowerCase();
    if (l.startsWith('pto'))     return `🏖️ ${r}`;
    if (l.startsWith('backlog')) return `📌 ${r}`;
    return `🔴 ${r}`;
  }).join(' · ');
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

// ── Request detail modal ──────────────────────────────────────────────────────

function openRequestDetail(number) {
  const r = state.requests.find(req => req.number === number);
  if (!r) return;

  const flag = FLAGS[r.country] || '🌍';
  const isUnassigned = r.is_unassigned;

  const statusBadgeHtml = {
    'New': '<span class="badge badge-new">New</span>',
    'Assigned': '<span class="badge badge-assigned">Assigned</span>',
    'Work in progress': '<span class="badge badge-wip">In Progress</span>',
  }[r.status] || `<span class="badge">${escHtml(r.status)}</span>`;

  document.getElementById('rdTitle').innerHTML = `${escHtml(r.number)} ${statusBadgeHtml}`;
  document.getElementById('rdSubtitle').textContent = r.short_description;

  const fields = [
    { label: 'Requestor',     value: formatName(r.requestor) },
    { label: 'Country',       value: `${flag} ${r.country}` },
    { label: 'Project Code',  value: r.project_code || '—' },
    { label: 'Created',       value: r.created_date || '—' },
    { label: 'Deadline',      value: r.deadline || '—' },
    { label: 'Assigned To',   value: formatName(r.assigned_to) || 'Unassigned' },
  ];

  document.getElementById('rdBody').innerHTML = `
    <div class="rd-grid">
      ${fields.map(f => `
        <div class="rd-field">
          <div class="rd-label">${escHtml(f.label)}</div>
          <div class="rd-value">${escHtml(f.value)}</div>
        </div>`).join('')}
    </div>`;

  const opts = state.teamNames.map(name => {
    const isBlocked = state.blocked[name];
    const label = isBlocked ? `${formatName(name)} 🔴` : formatName(name);
    return `<option value="${name}" ${isBlocked ? 'disabled' : ''} ${!isUnassigned && r.assigned_to === name ? 'selected' : ''}>${label}</option>`;
  }).join('');

  const btnLabel = isUnassigned ? 'Assign →' : 'Reassign →';
  document.getElementById('rdAssignRow').innerHTML = `
    <select id="rd-sel-${r.number}">
      <option value="">— ${isUnassigned ? 'Assign to team member' : 'Reassign'} —</option>
      ${opts}
    </select>
    <button onclick="assignFromDetail('${r.number}')">  ${btnLabel}</button>`;

  document.getElementById('rdSuccessMsg').style.display = 'none';
  document.getElementById('requestOverlay').classList.add('show');
}

async function assignFromDetail(number) {
  const sel = document.getElementById('rd-sel-' + number);
  if (!sel || !sel.value) return toast('Please select a team member first', 'warn');
  const assignee = sel.value;
  try {
    const data = await fetch(`${API}/assign`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number, assignee }),
    }).then(r => r.json());
    if (data.error) return toast('⛔ ' + data.error, 'error');
    document.getElementById('rdSuccessMsg').style.display = 'block';
    setTimeout(() => { closeRequestDetail(); loadRequests(); }, 1200);
  } catch (err) {
    toast('Assignment failed: ' + err.message, 'error');
  }
}

function closeRequestDetail() {
  document.getElementById('requestOverlay').classList.remove('show');
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
  const fillClass = { blocked: 'fill-red', full: 'fill-red', warn: 'fill-yellow', ok: 'fill-green' }[m.status];
  const statusLabel = { full: '🔴 Full', warn: '🟡 Limited', ok: '🟢 Available' }[m.status] || '';

  const reasonChips = (m.block_reasons || []).map(r => {
    const l = r.toLowerCase();
    const icon = l.startsWith('pto') ? '🏖️' : l.startsWith('backlog') ? '📌' : '💼';
    return `<span class="block-reason-tag">${icon} ${escHtml(r)}</span>`;
  }).join('');

  const metaHtml = m.is_blocked
    ? `<div class="block-reasons-row">${reasonChips || '🔴 Blocked'}</div>`
    : `<div class="member-meta-line">${m.total} / ${state.maxRequests} requests · ${m.effective_cap} cap this week</div>`;

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
      <div class="member-name">${escHtml(formatName(m.name))}</div>
      ${m.is_blocked ? '<span class="member-status status-blocked">🔴 Blocked ≥75%</span>' : `<span class="member-status status-${m.status}">${statusLabel}</span>`}
    </div>
    ${metaHtml} ${spilloverHtml}
    ${barHtml}
  </div>`;
}

// ── Staffing tab ──────────────────────────────────────────────────────────────

async function loadStaffingTab() {
  document.getElementById('staffingContent').innerHTML =
    '<div class="empty-state"><div class="icon">⏳</div><p>Loading…</p></div>';
  try {
    const [items, teamData] = await Promise.all([
      apiFetch(`${API}/staffing`),
      apiFetch(`${API}/team`),
    ]);
    state.staffingItems   = items;
    state.teamNamesLoaded = teamData.team_names;
    populateStaffingTeamSelect();
    renderStaffing();
  } catch (err) {
    document.getElementById('staffingContent').innerHTML =
      `<div class="empty-state"><div class="icon">⚠️</div><p>Error: ${err.message}</p></div>`;
  }
}

function renderStaffing() {
  const items = state.staffingItems;
  if (!items.length) {
    document.getElementById('staffingContent').innerHTML =
      '<div class="empty-state"><div class="icon">💼</div><p>No staffing entries yet. Click <strong>+ New Entry</strong> to add one.</p></div>';
    return;
  }
  const today = todayStr();
  let html = `<div class="list-table-wrap"><table class="list-table"><thead><tr>
    <th>Case Name</th><th>Case Code</th><th>Case Type</th>
    <th>Industry</th><th>Region</th><th>Project Value</th>
    <th>Team Member</th><th>Capacity</th><th>Start Date</th><th>End Date</th>
  </tr></thead><tbody>`;
  for (const i of items) {
    const isActive = i.start_date && i.end_date && i.start_date <= today && i.end_date >= today;
    html += `<tr class="${isActive ? 'row-active' : ''}" onclick="openStaffingModal(${JSON.stringify(i).replace(/"/g,'&quot;')})">
      <td>${escHtml(i.case_name)}</td><td>${escHtml(i.case_code)}</td><td>${escHtml(i.case_type)}</td>
      <td>${escHtml(i.industry)}</td><td>${escHtml(i.region)}</td><td>${escHtml(i.project_value)}</td>
      <td>${escHtml(formatName(i.team_member))}</td>
      <td><span class="capacity-pill">${i.capacity_pct}%</span></td>
      <td>${i.start_date || '—'}</td><td>${i.end_date || '—'}</td>
    </tr>`;
  }
  html += '</tbody></table></div>';
  document.getElementById('staffingContent').innerHTML = html;
}

function populateStaffingTeamSelect() {
  const names = getTeamNames();
  const sel = document.getElementById('sfTeamMember');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">— Select —</option>';
  names.forEach(n => { const o = document.createElement('option'); o.value = n; o.textContent = formatName(n); if (n === cur) o.selected = true; sel.appendChild(o); });
}

function openStaffingModal(item) {
  const isNew = !item;
  document.getElementById('staffingModalTitle').textContent = isNew ? 'New Staffing Entry' : 'Edit Staffing Entry';
  document.getElementById('sfDeleteBtn').style.display = isNew ? 'none' : 'inline-flex';
  document.getElementById('sfId').value           = item?.id || '';
  document.getElementById('sfCaseName').value     = item?.case_name     || '';
  document.getElementById('sfCaseCode').value     = item?.case_code     || '';
  document.getElementById('sfCaseType').value     = item?.case_type     || '';
  document.getElementById('sfIndustry').value     = item?.industry      || '';
  document.getElementById('sfRegion').value       = item?.region        || '';
  document.getElementById('sfProjectValue').value = item?.project_value || '';
  document.getElementById('sfTeamMember').value   = item?.team_member   || '';
  document.getElementById('sfCapacity').value     = String(item?.capacity_pct || 50);
  document.getElementById('sfStartDate').value    = item?.start_date    || '';
  document.getElementById('sfEndDate').value      = item?.end_date      || '';
  document.getElementById('staffingOverlay').classList.add('show');
}

function closeStaffingModal() {
  document.getElementById('staffingOverlay').classList.remove('show');
}

async function saveStaffingEntry() {
  const payload = {
    id:            document.getElementById('sfId').value ? parseInt(document.getElementById('sfId').value) : null,
    case_name:     document.getElementById('sfCaseName').value,
    case_code:     document.getElementById('sfCaseCode').value,
    case_type:     document.getElementById('sfCaseType').value,
    industry:      document.getElementById('sfIndustry').value,
    region:        document.getElementById('sfRegion').value,
    project_value: document.getElementById('sfProjectValue').value,
    team_member:   document.getElementById('sfTeamMember').value,
    capacity_pct:  parseInt(document.getElementById('sfCapacity').value) || 50,
    start_date:    document.getElementById('sfStartDate').value,
    end_date:      document.getElementById('sfEndDate').value,
  };
  if (!payload.team_member) return toast('Please select a team member', 'warn');
  if (!payload.start_date || !payload.end_date) return toast('Start and end date are required', 'warn');
  try {
    const data = await fetch(`${API}/staffing/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(r => r.json());
    if (data.error) return toast(data.error, 'error');
    if (data.reassigned > 0) toast(`↩ ${data.reassigned} request(s) moved back to queue`, 'warn');
    closeStaffingModal();
    await loadStaffingTab();
    loadRequests();
  } catch (err) {
    toast('Failed to save: ' + err.message, 'error');
  }
}

async function deleteStaffingEntry() {
  const id = document.getElementById('sfId').value;
  if (!id || !confirm('Delete this staffing entry?')) return;
  try {
    await fetch(`${API}/staffing/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: parseInt(id) }) });
    closeStaffingModal();
    await loadStaffingTab();
    loadRequests();
  } catch (err) { toast('Failed to delete: ' + err.message, 'error'); }
}

async function loadPtoTab() {
  document.getElementById('ptoContent').innerHTML =
    '<div class="empty-state"><div class="icon">⏳</div><p>Loading…</p></div>';
  try {
    const [items, teamData] = await Promise.all([
      apiFetch(`${API}/pto`),
      apiFetch(`${API}/team`),
    ]);
    state.ptoItems        = items;
    state.teamNamesLoaded = teamData.team_names;
    populatePtoTeamSelect();
    renderPto();
  } catch (err) {
    document.getElementById('ptoContent').innerHTML =
      `<div class="empty-state"><div class="icon">⚠️</div><p>Error: ${err.message}</p></div>`;
  }
}

const PTO_EMOJI = { PTO: '🏖️', Training: '📚', Event: '🎉' };

function renderPto() {
  const items = state.ptoItems;
  if (!items.length) {
    document.getElementById('ptoContent').innerHTML =
      '<div class="empty-state"><div class="icon">🏖️</div><p>No absences recorded. Click <strong>+ New Entry</strong> to add one.</p></div>';
    return;
  }
  const today = todayStr();
  let html = `<div class="list-table-wrap"><table class="list-table"><thead><tr>
    <th>Team Member</th><th>Absence Type</th><th>Start Date</th><th>End Date</th><th>Capacity</th>
  </tr></thead><tbody>`;
  for (const i of items) {
    const isActive = i.start_date && i.end_date && i.start_date <= today && i.end_date >= today;
    const emoji    = PTO_EMOJI[i.absence_type] || '📅';
    html += `<tr class="${isActive ? 'row-active' : ''}" onclick="openPtoModal(${JSON.stringify(i).replace(/"/g,'&quot;')})">
      <td>${escHtml(formatName(i.team_member))}</td>
      <td>${emoji} ${escHtml(i.absence_type)}</td>
      <td>${i.start_date || '—'}</td><td>${i.end_date || '—'}</td>
      <td><span class="capacity-pill">${i.capacity_pct}%</span></td>
    </tr>`;
  }
  html += '</tbody></table></div>';
  document.getElementById('ptoContent').innerHTML = html;
}

function populatePtoTeamSelect() {
  const names = getTeamNames();
  const sel = document.getElementById('ptTeamMember');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">— Select —</option>';
  names.forEach(n => { const o = document.createElement('option'); o.value = n; o.textContent = formatName(n); if (n === cur) o.selected = true; sel.appendChild(o); });
}

function openPtoModal(item) {
  const isNew = !item;
  document.getElementById('ptoModalTitle').textContent = isNew ? 'New Absence Entry' : 'Edit Absence Entry';
  document.getElementById('ptDeleteBtn').style.display = isNew ? 'none' : 'inline-flex';
  document.getElementById('ptId').value          = item?.id || '';
  document.getElementById('ptTeamMember').value  = item?.team_member  || '';
  document.getElementById('ptAbsenceType').value = item?.absence_type || 'PTO';
  document.getElementById('ptStartDate').value   = item?.start_date   || '';
  document.getElementById('ptEndDate').value     = item?.end_date     || '';
  document.getElementById('ptCapacity').value    = String(item?.capacity_pct || 100);
  document.getElementById('ptoOverlay').classList.add('show');
}

function closePtoModal() {
  document.getElementById('ptoOverlay').classList.remove('show');
}

async function savePtoEntry() {
  const payload = {
    id:           document.getElementById('ptId').value ? parseInt(document.getElementById('ptId').value) : null,
    team_member:  document.getElementById('ptTeamMember').value,
    absence_type: document.getElementById('ptAbsenceType').value,
    start_date:   document.getElementById('ptStartDate').value,
    end_date:     document.getElementById('ptEndDate').value,
    capacity_pct: parseInt(document.getElementById('ptCapacity').value) || 100,
  };
  if (!payload.team_member) return toast('Please select a team member', 'warn');
  if (!payload.start_date || !payload.end_date) return toast('Start and end date are required', 'warn');
  try {
    const data = await fetch(`${API}/pto/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(r => r.json());
    if (data.error) return toast(data.error, 'error');
    if (data.reassigned > 0) toast(`↩ ${data.reassigned} request(s) moved back to queue`, 'warn');
    closePtoModal();
    await loadPtoTab();
    loadRequests();
  } catch (err) { toast('Failed to save: ' + err.message, 'error'); }
}

async function deletePtoEntry() {
  const id = document.getElementById('ptId').value;
  if (!id || !confirm('Delete this absence entry?')) return;
  try {
    await fetch(`${API}/pto/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: parseInt(id) }) });
    closePtoModal();
    await loadPtoTab();
    loadRequests();
  } catch (err) { toast('Failed to delete: ' + err.message, 'error'); }
}

// ── Backlog tab ───────────────────────────────────────────────────────────────

function getTeamNames() {
  return state.teamNames.length ? state.teamNames : state.teamNamesLoaded;
}

function populateBacklogTeamSelects() {
  const names = getTeamNames();
  ['blLead', 'blTeam1', 'blTeam2', 'blTeam3'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const firstOpt = sel.options[0];
    sel.innerHTML = '';
    sel.appendChild(firstOpt);
    names.forEach(n => {
      const o = document.createElement('option');
      o.value = n; o.textContent = formatName(n);
      sel.appendChild(o);
    });
  });
}

async function loadBacklogTab() {
  try {
    // Fetch team names if not yet loaded
    if (!getTeamNames().length) {
      const teamData = await apiFetch(`${API}/team`);
      state.teamNamesLoaded = teamData.team_names || [];
    }
    populateBacklogTeamSelects();
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
                <th>Name</th><th>Lead</th><th>Lead Cap</th><th>Team Members</th>
                <th>Status</th><th>Priority</th><th>Timeline</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(i => {
                const teamArr = (i.team || '').split(',').map(n => n.trim()).filter(Boolean);
                const teamAllocs = [i.team1_alloc, i.team2_alloc, i.team3_alloc];
                const teamHtml = teamArr.length
                  ? teamArr.map((n, idx) => `<span class="team-member-chip">${escHtml(formatName(n))}${teamAllocs[idx] ? ` <span class="capacity-pill-sm">${teamAllocs[idx]}%</span>` : ''}</span>`).join('')
                  : '—';
                return `
              <tr onclick="openBacklogModal(${JSON.stringify(i).replace(/"/g,'&quot;')})">
                <td>${escHtml(i.name)}</td>
                <td>${escHtml(formatName(i.lead))}</td>
                <td>${i.lead_alloc ? `<span class="capacity-pill">${i.lead_alloc}%</span>` : '—'}</td>
                <td class="team-cell">${teamHtml}</td>
                <td>${statusBadge(i.status)}</td>
                <td>${priorityBadge(i.priority)}</td>
                <td style="font-size:11px;color:#6b7280;">${i.start_date && i.end_date ? `${i.start_date} → ${i.end_date}` : i.start_date || '—'}</td>
              </tr>`;
              }).join('')}
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
  document.getElementById('blStartDate').value = item?.start_date || '';
  document.getElementById('blEndDate').value = item?.end_date || '';
  document.getElementById('blPractice').value = item?.practice || '';
  document.getElementById('blLead').value = item?.lead || '';
  document.getElementById('blLeadAlloc').value  = String(item?.lead_alloc  || item?.allocation_pct || 0);
  const teamArr = (item?.team || '').split(',').map(n => n.trim()).filter(Boolean);
  document.getElementById('blTeam1').value = teamArr[0] || '';
  document.getElementById('blTeam2').value = teamArr[1] || '';
  document.getElementById('blTeam3').value = teamArr[2] || '';
  document.getElementById('blTeam1Alloc').value = String(item?.team1_alloc || 0);
  document.getElementById('blTeam2Alloc').value = String(item?.team2_alloc || 0);
  document.getElementById('blTeam3Alloc').value = String(item?.team3_alloc || 0);
  document.getElementById('blStakeholders').value = item?.stakeholders || '';
  document.getElementById('backlogOverlay').classList.add('show');
}

function closeBacklogModal() {
  document.getElementById('backlogOverlay').classList.remove('show');
}

async function saveBacklogItem() {
  const id = document.getElementById('blId').value;
  const team = [
    document.getElementById('blTeam1').value,
    document.getElementById('blTeam2').value,
    document.getElementById('blTeam3').value,
  ].filter(Boolean).join(', ');
  const payload = {
    id: id ? parseInt(id) : null,
    name:          document.getElementById('blName').value,
    group:         document.getElementById('blGroupField').value,
    status:        document.getElementById('blStatusField').value,
    priority:      document.getElementById('blPriorityField').value,
    lead:          document.getElementById('blLead').value,
    lead_alloc:    parseInt(document.getElementById('blLeadAlloc').value)  || 0,
    team,
    team1_alloc:   parseInt(document.getElementById('blTeam1Alloc').value) || 0,
    team2_alloc:   parseInt(document.getElementById('blTeam2Alloc').value) || 0,
    team3_alloc:   parseInt(document.getElementById('blTeam3Alloc').value) || 0,
    allocation_pct:parseInt(document.getElementById('blLeadAlloc').value)  || 0,
    start_date:    document.getElementById('blStartDate').value,
    end_date:      document.getElementById('blEndDate').value,
    hours:         0,
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

// ── Workload tab ──────────────────────────────────────────────────────────────

async function loadWorkloadTab() {
  document.getElementById('workloadContent').innerHTML =
    '<div class="empty-state"><div class="icon">⏳</div><p>Loading…</p></div>';
  try {
    const data = await apiFetch(`${API}/workload?weeks=6&offset=${state.workloadOffset}`);
    state.workloadData = data;
    renderWorkload();
  } catch (err) {
    document.getElementById('workloadContent').innerHTML =
      `<div class="empty-state"><div class="icon">⚠️</div><p>Error: ${err.message}</p></div>`;
  }
}

function changeWorkloadOffset(delta, reset = false) {
  state.workloadOffset = reset ? 0 : state.workloadOffset + delta;
  loadWorkloadTab();
}

function renderWorkload() {
  const { members, weeks, data } = state.workloadData;

  // Range label
  document.getElementById('workloadRangeLabel').textContent =
    `${weeks[0].label} — ${weeks[weeks.length - 1].label}`;

  const allocSel = (label, pct, color) =>
    pct > 0 ? `<div class="wl-seg" style="width:${pct}%;background:${color};" title="${label}: ${pct}%"></div>` : '';

  let html = `<table class="wl-table">
    <thead><tr>
      <th class="wl-name-col">Member</th>
      ${weeks.map(w => `<th class="wl-week-col">${w.label}</th>`).join('')}
    </tr></thead><tbody>`;

  for (const member of members) {
    const parts     = member.trim().split(/\s+/);
    const firstName = parts.slice(1).join(' ');
    const lastName  = parts[0];
    html += `<tr>
      <td class="wl-name-cell"><span class="wl-first">${firstName}</span> <span class="wl-last">${lastName}</span></td>`;

    for (const week of weeks) {
      const c = (data[member] || {})[week.from] || {};
      const s  = Math.min(c.staffing_pct || 0, 100);
      const p  = Math.min(c.pto_pct      || 0, Math.max(0, 100 - s));
      const b  = Math.min(c.backlog_pct  || 0, Math.max(0, 100 - s - p));
      const r  = Math.min(c.req_pct      || 0, Math.max(0, 100 - s - p - b));
      const total = (c.total || 0);
      const over  = total > 100;
      const clr   = total === 0 ? '#374151' : over ? '#f87171' : total >= 85 ? '#fbbf24' : total >= 60 ? '#60a5fa' : '#34d399';

      // Tooltip
      const tips = [];
      if (s > 0) tips.push(`🟣 Case: ${c.staffing_pct}%`);
      if (p > 0) tips.push(`🟠 PTO: ${c.pto_pct}% (${Object.keys(c.pto_days || {}).length}d)`);
      if (b > 0) {
        tips.push(`🟡 Backlog: ${c.backlog_pct}%`);
        (c.backlog_items || []).forEach(i => tips.push(`   · ${i.name} (${i.pct}%)`));
      }
      if (r > 0) tips.push(`🔵 Requests: ${c.req_count} (${c.req_pct}%)`);
      if (!tips.length) tips.push('No load this week');

      html += `<td class="wl-cell${c.is_current ? ' wl-current' : ''}" title="${tips.join('\n')}">
        <div class="wl-bar">
          ${allocSel('Case', s, '#8b5cf6')}
          ${allocSel('PTO',  p, '#f59e0b')}
          ${allocSel('Backlog', b, '#14b8a6')}
          ${allocSel('Requests', r, '#3b82f6')}
        </div>
        <div class="wl-pct" style="color:${clr}">${total > 0 ? total + '%' : '—'}${over ? ' ⚠' : ''}</div>
      </td>`;
    }
    html += '</tr>';
  }

  html += `</tbody></table>
    <div class="wl-legend">
      <span class="wl-leg" style="--c:#8b5cf6">Case Staffing</span>
      <span class="wl-leg" style="--c:#f59e0b">PTO</span>
      <span class="wl-leg" style="--c:#14b8a6">Backlog</span>
      <span class="wl-leg" style="--c:#3b82f6">Requests (current week)</span>
    </div>`;

  document.getElementById('workloadContent').innerHTML = html;
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
          <div class="match-dest-name">${FLAGS[assigneeCountry] || '🌍'} ${escHtml(formatName(r.assignee))}</div>
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
