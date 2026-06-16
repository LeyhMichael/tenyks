const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');

function errMsg(err) {
  if (err.errors?.length) {
    const msg = err.errors.map(e => [e.message, e.detail, e.hint].filter(Boolean).join(' — ')).join('; ');
    console.error('[quarterback] AggregateError:', msg);
    return msg;
  }
  const parts = [err.message, err.detail, err.hint].filter(Boolean);
  const msg = parts.join(' — ') || String(err);
  console.error('[quarterback]', err.code || '', msg);
  return msg;
}

const ACTIVE_STATUSES = ['New', 'Work in progress', 'Assigned'];
const MAX_REQUESTS = 14;

const pool = new Pool({
  host:     process.env.DB_HOST,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl:      { rejectUnauthorized: false },
  port:     parseInt(process.env.DB_PORT || '5432'),
});

// ── Caches ────────────────────────────────────────────────────────────────────

let _requestsCache = null;
let _requestsCacheTs = 0;
const REQUESTS_TTL = 30000;

let _membersCache = null;
let _membersCacheTs = 0;
const MEMBERS_TTL = 300000;

function invalidateRequests() { _requestsCache = null; }

async function loadRequests() {
  const now = Date.now();
  if (_requestsCache && now - _requestsCacheTs < REQUESTS_TTL) return _requestsCache;
  const { rows } = await pool.query(`
    SELECT number, short_description, country, project_code,
           requestor, status, assigned_to,
           created_date::text, deadline::text
    FROM requests ORDER BY created_date DESC
  `);
  _requestsCache = rows.map(r => ({
    number:            r.number,
    short_description: r.short_description || '',
    country:           r.country || 'Unknown',
    project_code:      r.project_code || '',
    requestor:         r.requestor || '',
    status:            r.status,
    assigned_to:       r.assigned_to || 'Unassigned',
    created_date:      (r.created_date || '').slice(0, 10),
    deadline:          (r.deadline || '').slice(0, 10),
  }));
  _requestsCacheTs = now;
  return _requestsCache;
}

async function loadTeamMembers() {
  const now = Date.now();
  if (_membersCache && now - _membersCacheTs < MEMBERS_TTL) return _membersCache;
  const { rows } = await pool.query('SELECT name, country FROM team_members ORDER BY name');
  _membersCache = Object.fromEntries(rows.map(r => [r.name, r.country]));
  _membersCacheTs = now;
  return _membersCache;
}

async function loadStaffing() {
  const { rows } = await pool.query('SELECT name, date::text AS date, percentage FROM staffing');
  const data = {};
  for (const r of rows) {
    if (!data[r.name]) data[r.name] = {};
    data[r.name][r.date.slice(0, 10)] = parseInt(r.percentage);
  }
  return data;
}

async function loadPto() {
  const { rows } = await pool.query('SELECT name, date::text AS date, type FROM pto');
  const data = {};
  for (const r of rows) {
    if (!data[r.name]) data[r.name] = {};
    data[r.name][r.date.slice(0, 10)] = r.type;
  }
  return data;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function getMondayStr() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  const d = new Date(now);
  d.setUTCDate(now.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayName(dateStr) {
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(dateStr + 'T00:00:00Z').getUTCDay()];
}

// ── Capacity helpers ──────────────────────────────────────────────────────────

async function getBacklogAllocationToday(name) {
  const today = todayStr();
  try {
    const { rows } = await pool.query(`
      SELECT lead, team, lead_alloc, team1_alloc, team2_alloc, team3_alloc, allocation_pct
      FROM backlog
      WHERE status NOT IN ('Complete', 'Deprioritized')
        AND (lead = $1 OR team LIKE $2)
        AND start_date IS NOT NULL AND end_date IS NOT NULL
        AND start_date::text <= $3 AND end_date::text >= $3
    `, [name, `%${name}%`, today]);
    let total = 0;
    for (const r of rows) {
      if (r.lead === name) {
        total += parseInt(r.lead_alloc) || parseInt(r.allocation_pct) || 0;
      } else {
        const teamArr = (r.team || '').split(',').map(n => n.trim());
        const idx = teamArr.indexOf(name);
        if (idx === 0) total += parseInt(r.team1_alloc) || 0;
        if (idx === 1) total += parseInt(r.team2_alloc) || 0;
        if (idx === 2) total += parseInt(r.team3_alloc) || 0;
      }
    }
    return Math.min(total, 100);
  } catch {
    return 0;
  }
}

function getEffectiveCapacity(name, staffing, pto, backlogAlloc = 0) {
  const today = todayStr();
  const staffingPct = (staffing[name] || {})[today] || 0;
  if (staffingPct >= 50 || (pto[name] || {})[today]) return 0;
  const monday = getMondayStr();
  let absenceDays = 0;
  for (let i = 0; i < 5; i++) {
    if ((pto[name] || {})[addDays(monday, i)]) absenceDays++;
  }
  const effectivePct = Math.min(staffingPct + absenceDays * 20 + backlogAlloc, 100);
  return Math.max(0, Math.floor(MAX_REQUESTS * (1 - effectivePct / 100)));
}

function isBlocked(name, staffing, pto) {
  const today = todayStr();
  return ((staffing[name] || {})[today] || 0) >= 50 || !!((pto[name] || {})[today]);
}

function getBlockReason(name, staffing, pto) {
  const today = todayStr();
  const pct = (staffing[name] || {})[today] || 0;
  if (pct >= 50) return 'on case today';
  const absence = (pto[name] || {})[today];
  return absence ? absence.toLowerCase() : null;
}

function getActiveRequests(requests) {
  return requests.filter(r => ACTIVE_STATUSES.includes(r.status));
}

function getMemberActiveRequests(requests, name) {
  return requests.filter(r => ACTIVE_STATUSES.includes(r.status) && r.assigned_to === name);
}

async function buildCapacity(requests, staffing, pto) {
  const today     = todayStr();
  const monday    = getMondayStr();
  const weekDates = Array.from({ length: 5 }, (_, i) => addDays(monday, i));
  const lastThur  = addDays(monday, -4);
  const lastFri   = addDays(monday, -3);

  const names = [...new Set(
    requests.filter(r => r.assigned_to && r.assigned_to !== 'Unassigned').map(r => r.assigned_to)
  )];

  const result = [];
  for (const name of names) {
    const windowReqs = requests.filter(r =>
      ACTIVE_STATUSES.includes(r.status) &&
      r.assigned_to === name &&
      r.created_date >= lastThur &&
      r.created_date <= today
    );

    const daily = {};
    for (const d of weekDates) {
      const next = addDays(d, 1);
      daily[dayName(d)] = windowReqs.filter(r => r.created_date >= d && r.created_date < next).length;
    }

    const spillover = windowReqs.filter(r => r.created_date === lastThur || r.created_date === lastFri).length;
    const total     = Object.values(daily).reduce((a, b) => a + b, 0) + spillover;
    const blocked   = isBlocked(name, staffing, pto);
    const blockReason = getBlockReason(name, staffing, pto);
    const backlogAlloc  = await getBacklogAllocationToday(name);
    const effectiveCap  = getEffectiveCapacity(name, staffing, pto, backlogAlloc);
    const pct = Math.min(Math.round((total / MAX_REQUESTS) * 100), 100);
    const status = blocked ? 'blocked' : total >= effectiveCap ? 'full' : total >= effectiveCap * 0.7 ? 'warn' : 'ok';

    if (total > 0 || blocked) {
      result.push({ name, daily, spillover, total, pct, is_blocked: blocked, block_reason: blockReason,
                    effective_cap: effectiveCap, at_capacity: total >= effectiveCap || blocked, status });
    }
  }

  result.sort((a, b) => (b.is_blocked - a.is_blocked) || (b.total - a.total));
  return { team: result, week_labels: weekDates.map(d => dayName(d)) };
}

// ── Module export ─────────────────────────────────────────────────────────────

module.exports = function ({ register, readJson, sendJson, sendError }) {

  // Ensure backlog table exists + per-person allocation columns
  pool.query(`
    CREATE TABLE IF NOT EXISTS backlog (
      id              SERIAL PRIMARY KEY,
      group_name      TEXT DEFAULT '',
      name            TEXT DEFAULT '',
      lead            TEXT DEFAULT '',
      team            TEXT DEFAULT '',
      status          TEXT DEFAULT 'Backlog',
      start_date      DATE,
      end_date        DATE,
      priority        TEXT DEFAULT 'Unset',
      hours           NUMERIC DEFAULT 0,
      completion_date DATE,
      practice        TEXT DEFAULT '',
      stakeholders    TEXT DEFAULT '',
      allocation_pct  INTEGER DEFAULT 0
    )
  `).then(() => pool.query(`
    ALTER TABLE backlog ADD COLUMN IF NOT EXISTS lead_alloc  INTEGER DEFAULT 0;
    ALTER TABLE backlog ADD COLUMN IF NOT EXISTS team1_alloc INTEGER DEFAULT 0;
    ALTER TABLE backlog ADD COLUMN IF NOT EXISTS team2_alloc INTEGER DEFAULT 0;
    ALTER TABLE backlog ADD COLUMN IF NOT EXISTS team3_alloc INTEGER DEFAULT 0;
  `)).catch(err => console.error('[quarterback] backlog table init:', err.message));

  // ── GET requests ─────────────────────────────────────────────────────────────

  register('GET', 'requests', async (req, res) => {
    try {
      const [requests, teamMembers, staffing, pto] = await Promise.all([
        loadRequests(), loadTeamMembers(), loadStaffing(), loadPto(),
      ]);

      const blocked = {}, blockReasons = {};
      for (const name of Object.keys(teamMembers)) {
        if (isBlocked(name, staffing, pto)) {
          blocked[name] = true;
          blockReasons[name] = getBlockReason(name, staffing, pto) || 'on case today';
        }
      }

      const requestList = getActiveRequests(requests)
        .sort((a, b) => (b.assigned_to === 'Unassigned') - (a.assigned_to === 'Unassigned'))
        .map(r => ({
          ...r,
          preview: r.short_description.slice(0, 60) + (r.short_description.length > 60 ? '…' : ''),
          is_unassigned: r.assigned_to === 'Unassigned',
        }));

      const { team, week_labels } = await buildCapacity(requests, staffing, pto);
      const todayLabel = dayName(todayStr());

      sendJson(res, {
        requests: requestList,
        team,
        team_names: Object.keys(teamMembers).sort(),
        blocked,
        block_reasons: blockReasons,
        unassigned_count: requestList.filter(r => r.is_unassigned).length,
        week_labels,
        today_label: todayLabel,
        max_requests: MAX_REQUESTS,
      });
    } catch (err) {
      sendError(res, 500, errMsg(err));
    }
  });

  // ── POST assign ───────────────────────────────────────────────────────────────

  register('POST', 'assign', async (req, res) => {
    try {
      const { number, assignee } = await readJson(req);
      if (!number || !assignee) return sendError(res, 400, 'Missing number or assignee');

      const [requests, staffing, pto] = await Promise.all([loadRequests(), loadStaffing(), loadPto()]);
      const blockReason  = getBlockReason(assignee, staffing, pto);
      const backlogAlloc = await getBacklogAllocationToday(assignee);
      const effectiveCap = getEffectiveCapacity(assignee, staffing, pto, backlogAlloc);

      if (effectiveCap === 0)
        return sendError(res, 400, `${assignee} is blocked (${blockReason || 'blocked today'})`);

      const currentLoad = getMemberActiveRequests(requests, assignee).length;
      if (currentLoad >= effectiveCap)
        return sendError(res, 400, `${assignee} is at capacity (${currentLoad}/${effectiveCap} requests this week)`);

      await pool.query('UPDATE requests SET assigned_to=$1, status=$2 WHERE number=$3',
        [assignee, 'Assigned', number]);
      invalidateRequests();
      sendJson(res, { success: true });
    } catch (err) {
      sendError(res, 500, errMsg(err));
    }
  });

  // ── GET staffing?month=YYYY-MM ────────────────────────────────────────────────

  register('GET', 'staffing', async (req, res) => {
    try {
      const month = new URL(req.url, 'http://x').searchParams.get('month') || todayStr().slice(0, 7);
      const { rows } = await pool.query(
        `SELECT name, date::text AS date, percentage FROM staffing WHERE date::text LIKE $1`,
        [month + '%']
      );
      const result = {};
      for (const r of rows) {
        if (!result[r.name]) result[r.name] = {};
        result[r.name][r.date.slice(0, 10)] = parseInt(r.percentage);
      }
      sendJson(res, result);
    } catch (err) {
      sendError(res, 500, errMsg(err));
    }
  });

  // ── POST staffing { name, date, pct } ─────────────────────────────────────────

  register('POST', 'staffing', async (req, res) => {
    try {
      const { name, date, pct } = await readJson(req);
      if (!name || !date || pct === undefined) return sendError(res, 400, 'Missing fields');
      const pctInt = parseInt(pct);
      if (isNaN(pctInt) || pctInt < 0 || pctInt > 100) return sendError(res, 400, 'Invalid pct');

      await pool.query(
        `INSERT INTO staffing (name, date, percentage) VALUES ($1,$2,$3)
         ON CONFLICT (name, date) DO UPDATE SET percentage=$3`,
        [name, date, pctInt]
      );

      let reassigned = 0;
      if (date === todayStr()) {
        const [requests, staffing, pto] = await Promise.all([loadRequests(), loadStaffing(), loadPto()]);
        if (!staffing[name]) staffing[name] = {};
        staffing[name][date] = pctInt;
        const backlogAlloc = await getBacklogAllocationToday(name);
        const effectiveCap = getEffectiveCapacity(name, staffing, pto, backlogAlloc);
        const memberReqs   = getMemberActiveRequests(requests, name);
        const spillover    = Math.max(0, memberReqs.length - effectiveCap);
        if (spillover > 0) {
          const nums = memberReqs.sort((a,b) => b.created_date.localeCompare(a.created_date))
                                 .slice(0, spillover).map(r => r.number);
          await pool.query(`UPDATE requests SET assigned_to='Unassigned', status='New' WHERE number=ANY($1)`, [nums]);
          invalidateRequests();
          reassigned = spillover;
        }
      }

      sendJson(res, { success: true, is_blocked: pctInt >= 50, reassigned });
    } catch (err) {
      sendError(res, 500, errMsg(err));
    }
  });

  // ── GET pto?month=YYYY-MM ─────────────────────────────────────────────────────

  register('GET', 'pto', async (req, res) => {
    try {
      const month = new URL(req.url, 'http://x').searchParams.get('month') || todayStr().slice(0, 7);
      const { rows } = await pool.query(
        `SELECT name, date::text AS date, type FROM pto WHERE date::text LIKE $1`,
        [month + '%']
      );
      const result = {};
      for (const r of rows) {
        if (!result[r.name]) result[r.name] = {};
        result[r.name][r.date.slice(0, 10)] = r.type;
      }
      sendJson(res, result);
    } catch (err) {
      sendError(res, 500, errMsg(err));
    }
  });

  // ── POST pto { name, date, type } (type='' clears) ────────────────────────────

  register('POST', 'pto', async (req, res) => {
    try {
      const { name, date, type } = await readJson(req);
      if (!name || !date) return sendError(res, 400, 'Missing fields');

      if (type) {
        await pool.query(
          `INSERT INTO pto (name, date, type) VALUES ($1,$2,$3)
           ON CONFLICT (name, date) DO UPDATE SET type=$3`,
          [name, date, type]
        );
      } else {
        await pool.query('DELETE FROM pto WHERE name=$1 AND date=$2', [name, date]);
      }

      let reassigned = 0;
      if (date === todayStr()) {
        const [requests, staffing, pto] = await Promise.all([loadRequests(), loadStaffing(), loadPto()]);
        if (type) { if (!pto[name]) pto[name] = {}; pto[name][date] = type; }
        else if (pto[name]) delete pto[name][date];
        const backlogAlloc = await getBacklogAllocationToday(name);
        const effectiveCap = getEffectiveCapacity(name, staffing, pto, backlogAlloc);
        const memberReqs   = getMemberActiveRequests(requests, name);
        const spillover    = Math.max(0, memberReqs.length - effectiveCap);
        if (spillover > 0) {
          const nums = memberReqs.sort((a,b) => b.created_date.localeCompare(a.created_date))
                                 .slice(0, spillover).map(r => r.number);
          await pool.query(`UPDATE requests SET assigned_to='Unassigned', status='New' WHERE number=ANY($1)`, [nums]);
          invalidateRequests();
          reassigned = spillover;
        }
      }

      const [staffing2, pto2] = await Promise.all([loadStaffing(), loadPto()]);
      sendJson(res, { success: true, is_blocked: isBlocked(name, staffing2, pto2), reassigned });
    } catch (err) {
      sendError(res, 500, errMsg(err));
    }
  });

  // ── GET backlog ───────────────────────────────────────────────────────────────

  register('GET', 'backlog', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT id, group_name, name, lead, team, status,
               start_date::text, end_date::text, priority, hours,
               completion_date::text, practice, stakeholders, allocation_pct,
               lead_alloc, team1_alloc, team2_alloc, team3_alloc
        FROM backlog ORDER BY group_name, id
      `);
      sendJson(res, rows.map(r => ({
        id:              r.id,
        group:           r.group_name || '',
        name:            r.name || '',
        lead:            r.lead || '',
        team:            r.team || '',
        status:          r.status || 'Backlog',
        start_date:      (r.start_date || '').slice(0, 10),
        end_date:        (r.end_date || '').slice(0, 10),
        priority:        r.priority || 'Unset',
        hours:           parseFloat(r.hours) || 0,
        completion_date: (r.completion_date || '').slice(0, 10),
        practice:        r.practice || '',
        stakeholders:    r.stakeholders || '',
        allocation_pct:  parseInt(r.allocation_pct) || 0,
        lead_alloc:      parseInt(r.lead_alloc)  || 0,
        team1_alloc:     parseInt(r.team1_alloc) || 0,
        team2_alloc:     parseInt(r.team2_alloc) || 0,
        team3_alloc:     parseInt(r.team3_alloc) || 0,
      })));
    } catch (err) {
      sendError(res, 500, errMsg(err));
    }
  });

  // ── POST backlog/save ─────────────────────────────────────────────────────────

  register('POST', 'backlog/save', async (req, res) => {
    try {
      const d = await readJson(req);
      const p = [
        d.group || '', d.name || '', d.lead || '', d.team || '',
        d.status || 'Backlog',
        d.start_date || null, d.end_date || null,
        d.priority || 'Unset',
        parseFloat(d.hours) || 0,
        d.completion_date || null,
        d.practice || '', d.stakeholders || '',
        parseInt(d.allocation_pct) || 0,
        parseInt(d.lead_alloc)  || 0,
        parseInt(d.team1_alloc) || 0,
        parseInt(d.team2_alloc) || 0,
        parseInt(d.team3_alloc) || 0,
      ];
      if (d.id) {
        await pool.query(`
          UPDATE backlog SET group_name=$1,name=$2,lead=$3,team=$4,status=$5,
            start_date=$6,end_date=$7,priority=$8,hours=$9,completion_date=$10,
            practice=$11,stakeholders=$12,allocation_pct=$13,
            lead_alloc=$14,team1_alloc=$15,team2_alloc=$16,team3_alloc=$17 WHERE id=$18`,
          [...p, d.id]);
        sendJson(res, { success: true, id: d.id });
      } else {
        const { rows } = await pool.query(`
          INSERT INTO backlog (group_name,name,lead,team,status,start_date,end_date,
            priority,hours,completion_date,practice,stakeholders,allocation_pct,
            lead_alloc,team1_alloc,team2_alloc,team3_alloc)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`, p);
        sendJson(res, { success: true, id: rows[0].id });
      }
    } catch (err) {
      sendError(res, 500, errMsg(err));
    }
  });

  // ── POST backlog/delete ───────────────────────────────────────────────────────

  register('POST', 'backlog/delete', async (req, res) => {
    try {
      const { id } = await readJson(req);
      if (!id) return sendError(res, 400, 'Missing id');
      await pool.query('DELETE FROM backlog WHERE id=$1', [id]);
      sendJson(res, { success: true });
    } catch (err) {
      sendError(res, 500, errMsg(err));
    }
  });

  // ── POST agent/run ────────────────────────────────────────────────────────────

  register('POST', 'agent/run', async (req, res) => {
    try {
      if (!process.env.ANTHROPIC_API_KEY)
        return sendError(res, 500, 'ANTHROPIC_API_KEY not set');

      const [requests, teamMembers, staffing, pto] = await Promise.all([
        loadRequests(), loadTeamMembers(), loadStaffing(), loadPto(),
      ]);

      const today = todayStr();
      const capacity = [];
      for (const [name, country] of Object.entries(teamMembers)) {
        const load         = getMemberActiveRequests(requests, name).length;
        const blocked      = isBlocked(name, staffing, pto);
        const staffingPct  = (staffing[name] || {})[today] || 0;
        const absence      = (pto[name] || {})[today] || '';
        const backlogAlloc = await getBacklogAllocationToday(name);
        const effectiveCap = getEffectiveCapacity(name, staffing, pto, backlogAlloc);
        const entry = { name, country, current_requests: load, effective_capacity: effectiveCap,
                        remaining_capacity: Math.max(0, effectiveCap - load), staffing_pct: staffingPct, blocked };
        if (absence) entry.absence_today = absence;
        capacity.push(entry);
      }

      const unassigned = requests
        .filter(r => r.assigned_to === 'Unassigned' && ACTIVE_STATUSES.includes(r.status))
        .map(({ number, short_description, country, project_code, requestor, status }) =>
          ({ number, short_description, country, project_code, requestor, status }));

      const overcapacity = [];
      for (const m of capacity) {
        const excess = m.current_requests - m.effective_capacity;
        if (excess > 0) {
          const reqs = getMemberActiveRequests(requests, m.name)
            .map(({ number, short_description, country, project_code }) =>
              ({ number, short_description, country, project_code }));
          overcapacity.push({ ...m, excess_to_move: excess, requests: reqs });
        }
      }

      if (!unassigned.length && !overcapacity.length)
        return sendJson(res, { recommendations: [], summary: 'All requests are assigned and team capacity is within limits.' });

      const available = capacity.filter(m => !m.blocked && m.remaining_capacity > 0);
      let prompt, summaryPrefix;

      if (overcapacity.length && !unassigned.length) {
        const ocNames    = overcapacity.map(m => m.name).join(', ');
        const totalExcess = overcapacity.reduce((s, m) => s + m.excess_to_move, 0);
        prompt = `You are a quarterback agent for a BCG Vantage team.
All requests are currently assigned, but the following team members are OVER CAPACITY and their excess requests must be redistributed.

OVER-CAPACITY MEMBERS:
${JSON.stringify(overcapacity, null, 2)}

AVAILABLE TEAM MEMBERS (can receive redistributed requests):
${JSON.stringify(available, null, 2)}

Redistribution rules (in priority order):
1. Only move the EXCESS requests for each over-capacity member (the "excess_to_move" count — prioritise their most recently created requests).
2. Country match — prefer members in the same country as the request.
3. Never assign to a member with blocked=true or remaining_capacity=0.
4. Spread load as evenly as possible among available members.

Return ONLY a valid JSON array:
[{"number":"ACT0469094","assignee":"Alice Smith","reason":"Redistributed from ${overcapacity[0]?.name} · Country match (DEU)"}]

Only include requests that need to move. Do not include any text outside the JSON array.`;
        summaryPrefix = `⚠️ Capacity overrun — ${ocNames} ha${overcapacity.length > 1 ? 've' : 's'} ${totalExcess} excess request(s) that need redistribution.`;
      } else {
        prompt = `You are a quarterback agent for a BCG Vantage team. Your job is to assign ALL unassigned requests to team members.

Assignment rules (in priority order):
1. Country match — prefer team members in the same country as the request
2. Capacity — do not exceed each member's effective_capacity
3. Availability — members with blocked=true CANNOT take requests
4. Fallback — if no country match, assign to any available member with remaining_capacity > 0 (lowest load first)

UNASSIGNED REQUESTS:
${JSON.stringify(unassigned, null, 2)}

TEAM CAPACITY:
${JSON.stringify(capacity, null, 2)}

Assign EVERY request if possible. Return ONLY a valid JSON array:
[{"number":"ACT0469094","assignee":"Leyh Michael","reason":"Country match (DEU) · 8 slots remaining"}]

Use short, factual reasons. Only skip a request if ALL team members are at capacity or blocked.
Do not include any text outside the JSON array.`;
        summaryPrefix = null;
      }

      const client = new Anthropic();
      const message = await client.messages.create({
        model:      'claude-opus-4-7',
        max_tokens: 4096,
        messages:   [{ role: 'user', content: prompt }],
      });

      let raw = message.content[0].text.trim();
      if (raw.startsWith('```')) {
        raw = raw.split('\n').slice(1).join('\n');
        if (raw.endsWith('```')) raw = raw.slice(0, raw.lastIndexOf('```')).trim();
      }

      let recommendations;
      try { recommendations = JSON.parse(raw); }
      catch { return sendJson(res, { error: 'Agent returned invalid response', raw }); }

      for (const rec of recommendations) {
        const r = requests.find(x => x.number === rec.number);
        if (r) { rec.short_description = r.short_description; rec.country = r.country || ''; rec.requestor = r.requestor || ''; }
        rec.assignee_country = teamMembers[rec.assignee] || '';
      }

      const summary = summaryPrefix
        ? `${summaryPrefix} Agent made ${recommendations.length} redistribution recommendation(s).`
        : `Agent reviewed ${unassigned.length} unassigned request(s) and made ${recommendations.length} recommendation(s).`;

      sendJson(res, { recommendations, summary });
    } catch (err) {
      sendError(res, 500, errMsg(err));
    }
  });

  // ── POST agent/apply ──────────────────────────────────────────────────────────

  register('POST', 'agent/apply', async (req, res) => {
    try {
      const { recommendations } = await readJson(req);
      if (!recommendations?.length) return sendJson(res, { applied: 0, skipped: [], errors: [] });

      const [requests, staffing, pto] = await Promise.all([loadRequests(), loadStaffing(), loadPto()]);
      const loadTracker = {};
      const applied = [], skipped = [];

      for (const { number, assignee } of recommendations) {
        if (!number || !assignee) continue;
        if (loadTracker[assignee] === undefined)
          loadTracker[assignee] = getMemberActiveRequests(requests, assignee).length;
        const backlogAlloc = await getBacklogAllocationToday(assignee);
        const effectiveCap = getEffectiveCapacity(assignee, staffing, pto, backlogAlloc);
        if (loadTracker[assignee] >= effectiveCap) { skipped.push(number); continue; }
        await pool.query('UPDATE requests SET assigned_to=$1, status=$2 WHERE number=$3',
          [assignee, 'Assigned', number]);
        applied.push(number);
        loadTracker[assignee]++;
      }

      if (applied.length) invalidateRequests();
      sendJson(res, { applied: applied.length, skipped, errors: [] });
    } catch (err) {
      sendError(res, 500, errMsg(err));
    }
  });

  // ── GET workload?weeks=N&offset=N ────────────────────────────────────────────

  register('GET', 'workload', async (req, res) => {
    try {
      const url   = new URL(req.url, 'http://x');
      const weeks = Math.min(parseInt(url.searchParams.get('weeks')  || '6'), 12);
      const offset= parseInt(url.searchParams.get('offset') || '0');

      const [requests, teamMembers, staffing, pto] = await Promise.all([
        loadRequests(), loadTeamMembers(), loadStaffing(), loadPto(),
      ]);

      // Active request count per person (current week only)
      const activeReqs = {};
      for (const r of getActiveRequests(requests)) {
        if (r.assigned_to && r.assigned_to !== 'Unassigned')
          activeReqs[r.assigned_to] = (activeReqs[r.assigned_to] || 0) + 1;
      }

      // Backlog items that have dates + allocation
      const { rows: backlogRows } = await pool.query(`
        SELECT name, lead, team, start_date::text, end_date::text,
               allocation_pct, lead_alloc, team1_alloc, team2_alloc, team3_alloc
        FROM backlog
        WHERE start_date IS NOT NULL AND end_date IS NOT NULL
          AND status NOT IN ('Complete', 'Deprioritized')
          AND (allocation_pct > 0 OR lead_alloc > 0 OR team1_alloc > 0 OR team2_alloc > 0 OR team3_alloc > 0)
      `);

      // Build week ranges
      const baseMonday = addDays(getMondayStr(), offset * 7);
      const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const weekRanges = [];
      for (let w = 0; w < weeks; w++) {
        const from = addDays(baseMonday, w * 7);
        const to   = addDays(from, 4);
        const fd = new Date(from + 'T00:00:00Z');
        const td = new Date(to   + 'T00:00:00Z');
        const label = fd.getUTCMonth() === td.getUTCMonth()
          ? `${MONTHS[fd.getUTCMonth()]} ${fd.getUTCDate()}–${td.getUTCDate()}`
          : `${MONTHS[fd.getUTCMonth()]} ${fd.getUTCDate()} – ${MONTHS[td.getUTCMonth()]} ${td.getUTCDate()}`;
        weekRanges.push({ from, to, label });
      }

      const today   = todayStr();
      const members = Object.keys(teamMembers).sort();
      const data    = {};

      for (const name of members) {
        data[name] = {};
        for (const week of weekRanges) {
          // Case staffing: average % across Mon-Fri
          let staffingSum = 0;
          const staffingDays = {};
          for (let i = 0; i < 5; i++) {
            const d = addDays(week.from, i);
            const pct = (staffing[name] || {})[d] || 0;
            staffingSum += pct;
            if (pct > 0) staffingDays[d] = pct;
          }
          const staffingAvg = Math.round(staffingSum / 5);

          // PTO
          let ptoDayCount = 0;
          const ptoDays = {};
          for (let i = 0; i < 5; i++) {
            const d    = addDays(week.from, i);
            const type = (pto[name] || {})[d];
            if (type) { ptoDayCount++; ptoDays[d] = type; }
          }
          const ptoPct = Math.round((ptoDayCount / 5) * 100);

          // Backlog — per-person allocation
          let backlogPct = 0;
          const backlogItems = [];
          for (const item of backlogRows) {
            const s = (item.start_date || '').slice(0, 10);
            const e = (item.end_date   || '').slice(0, 10);
            if (s > week.to || e < week.from) continue;
            let pct = 0;
            if (item.lead === name) {
              pct = parseInt(item.lead_alloc) || parseInt(item.allocation_pct) || 0;
            } else {
              const teamArr = (item.team || '').split(',').map(n => n.trim());
              const idx = teamArr.indexOf(name);
              if (idx === 0) pct = parseInt(item.team1_alloc) || 0;
              else if (idx === 1) pct = parseInt(item.team2_alloc) || 0;
              else if (idx === 2) pct = parseInt(item.team3_alloc) || 0;
            }
            if (pct <= 0) continue;
            backlogPct += pct;
            backlogItems.push({ name: item.name, pct });
          }
          backlogPct = Math.min(backlogPct, 100);

          // Requests — only current week has live count
          const isCurrent = week.from <= today && week.to >= today;
          const reqCount  = isCurrent ? (activeReqs[name] || 0) : 0;
          const reqPct    = Math.round((reqCount / MAX_REQUESTS) * 100);

          const total = staffingAvg + ptoPct + backlogPct + reqPct; // allow >100 to show overload

          data[name][week.from] = {
            staffing_pct: staffingAvg, staffing_days: staffingDays,
            pto_pct: ptoPct,           pto_days: ptoDays,
            backlog_pct: backlogPct,   backlog_items: backlogItems,
            req_count: reqCount,       req_pct: reqPct,
            total, is_current: isCurrent,
          };
        }
      }

      sendJson(res, { members, weeks: weekRanges, data, today, max_requests: MAX_REQUESTS });
    } catch (err) {
      sendError(res, 500, errMsg(err));
    }
  });

  // ── GET team ──────────────────────────────────────────────────────────────────

  register('GET', 'team', async (req, res) => {
    try {
      const members = await loadTeamMembers();
      sendJson(res, { team_names: Object.keys(members).sort() });
    } catch (err) {
      sendError(res, 500, errMsg(err));
    }
  });
};
