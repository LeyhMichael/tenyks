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

const ACTIVE_STATUSES   = ['New', 'Work in progress', 'Assigned'];
const MAX_REQUESTS      = 14;
const BLOCK_THRESHOLD   = 75;   // % at which a member is blocked from new requests

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

// ── Date helpers ──────────────────────────────────────────────────────────────

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function getMondayStr() {
  const now = new Date();
  const day = now.getUTCDay();
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

// Returns { staffingMap, ptoMap, backlogMap } each keyed by team_member name
// with summed capacity_pct for records covering `date`.
async function getCapacityBatchForDate(date) {
  const [{ rows: sRows }, { rows: pRows }, { rows: bRows }] = await Promise.all([
    pool.query(
      `SELECT team_member, SUM(capacity_pct)::int AS total
       FROM staffing WHERE start_date <= $1 AND end_date >= $1
       GROUP BY team_member`, [date]
    ),
    pool.query(
      `SELECT team_member, SUM(capacity_pct)::int AS total
       FROM pto WHERE start_date <= $1 AND end_date >= $1
       GROUP BY team_member`, [date]
    ),
    pool.query(
      `SELECT lead, team, lead_alloc, team1_alloc, team2_alloc, team3_alloc, allocation_pct
       FROM backlog
       WHERE status NOT IN ('Complete','Deprioritized')
         AND start_date IS NOT NULL AND end_date IS NOT NULL
         AND start_date <= $1 AND end_date >= $1`, [date]
    ),
  ]);

  const staffingMap = {};
  for (const r of sRows) staffingMap[r.team_member] = Math.min(r.total, 100);

  const ptoMap = {};
  for (const r of pRows) ptoMap[r.team_member] = Math.min(r.total, 100);

  const backlogMap = {};
  for (const r of bRows) {
    if (r.lead) {
      const pct = parseInt(r.lead_alloc) || parseInt(r.allocation_pct) || 0;
      if (pct) backlogMap[r.lead] = (backlogMap[r.lead] || 0) + pct;
    }
    const teamArr = (r.team || '').split(',').map(n => n.trim()).filter(Boolean);
    const allocs  = [parseInt(r.team1_alloc)||0, parseInt(r.team2_alloc)||0, parseInt(r.team3_alloc)||0];
    teamArr.forEach((n, i) => { if (n && allocs[i]) backlogMap[n] = (backlogMap[n] || 0) + allocs[i]; });
  }
  for (const n of Object.keys(backlogMap)) backlogMap[n] = Math.min(backlogMap[n], 100);

  return { staffingMap, ptoMap, backlogMap };
}

// Pure function — computes how blocked a person is today
function computeBreakdown(name, staffingMap, ptoMap, backlogMap) {
  const staffing_pct = staffingMap[name] || 0;
  const pto_pct      = ptoMap[name]      || 0;
  const backlog_pct  = backlogMap[name]  || 0;
  const total        = Math.min(staffing_pct + pto_pct + backlog_pct, 100);
  const reasons      = [];
  if (staffing_pct > 0) reasons.push(`Case (${staffing_pct}%)`);
  if (pto_pct      > 0) reasons.push(`PTO (${pto_pct}%)`);
  if (backlog_pct  > 0) reasons.push(`Backlog (${backlog_pct}%)`);
  return { total, staffing_pct, pto_pct, backlog_pct, reasons, is_blocked: total >= BLOCK_THRESHOLD };
}

function effectiveCapFromBreakdown(breakdown) {
  if (breakdown.is_blocked) return 0;
  return Math.max(0, Math.floor(MAX_REQUESTS * (1 - breakdown.total / 100)));
}

function getActiveRequests(requests) {
  return requests.filter(r => ACTIVE_STATUSES.includes(r.status));
}

function getMemberActiveRequests(requests, name) {
  return requests.filter(r => ACTIVE_STATUSES.includes(r.status) && r.assigned_to === name);
}

async function buildCapacity(requests) {
  const today     = todayStr();
  const monday    = getMondayStr();
  const weekDates = Array.from({ length: 5 }, (_, i) => addDays(monday, i));
  const lastThur  = addDays(monday, -4);
  const lastFri   = addDays(monday, -3);

  const maps = await getCapacityBatchForDate(today);

  // Include anyone with assigned requests OR any capacity commitment today
  const names = [...new Set([
    ...requests.filter(r => r.assigned_to && r.assigned_to !== 'Unassigned').map(r => r.assigned_to),
    ...Object.keys(maps.staffingMap),
    ...Object.keys(maps.ptoMap),
    ...Object.keys(maps.backlogMap),
  ])];

  const result = [];
  for (const name of names) {
    const windowReqs = requests.filter(r =>
      ACTIVE_STATUSES.includes(r.status) && r.assigned_to === name &&
      r.created_date >= lastThur && r.created_date <= today
    );
    const daily = {};
    for (const d of weekDates) {
      const next = addDays(d, 1);
      daily[dayName(d)] = windowReqs.filter(r => r.created_date >= d && r.created_date < next).length;
    }
    const spillover  = windowReqs.filter(r => r.created_date === lastThur || r.created_date === lastFri).length;
    const total      = Object.values(daily).reduce((a, b) => a + b, 0) + spillover;
    const breakdown  = computeBreakdown(name, maps.staffingMap, maps.ptoMap, maps.backlogMap);
    const cap        = effectiveCapFromBreakdown(breakdown);
    const pct        = Math.min(Math.round((total / MAX_REQUESTS) * 100), 100);
    const status     = breakdown.is_blocked ? 'blocked'
                     : total >= cap         ? 'full'
                     : total >= cap * 0.7   ? 'warn' : 'ok';

    if (total > 0 || breakdown.total > 0) {
      result.push({
        name, daily, spillover, total, pct,
        is_blocked:    breakdown.is_blocked,
        block_reasons: breakdown.reasons,
        effective_cap: cap,
        at_capacity:   total >= cap || breakdown.is_blocked,
        status,
      });
    }
  }
  result.sort((a, b) => (b.is_blocked - a.is_blocked) || (b.total - a.total));
  return { team: result, week_labels: weekDates.map(d => dayName(d)) };
}

// Spillover: if saving a record that covers today pushes someone over threshold,
// return excess requests back to the queue.
async function spilloverCheck(name, maps) {
  const requests   = await loadRequests();
  const breakdown  = computeBreakdown(name, maps.staffingMap, maps.ptoMap, maps.backlogMap);
  const cap        = effectiveCapFromBreakdown(breakdown);
  const memberReqs = getMemberActiveRequests(requests, name);
  const overflow   = Math.max(0, memberReqs.length - cap);
  if (overflow > 0) {
    const nums = memberReqs
      .sort((a, b) => b.created_date.localeCompare(a.created_date))
      .slice(0, overflow).map(r => r.number);
    await pool.query(
      `UPDATE requests SET assigned_to='Unassigned', status='New' WHERE number=ANY($1)`, [nums]
    );
    invalidateRequests();
  }
  return overflow;
}

// ── Module export ─────────────────────────────────────────────────────────────

module.exports = function ({ register, readJson, sendJson, sendError }) {

  // ── Schema init ───────────────────────────────────────────────────────────────

  // Backlog table + per-person allocation columns
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

  // Migrate staffing: drop old day-based table, create range-based one
  pool.query(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='staffing' AND column_name='date'
      ) THEN DROP TABLE staffing; END IF;
    END $$;
    CREATE TABLE IF NOT EXISTS staffing (
      id            SERIAL PRIMARY KEY,
      case_name     TEXT DEFAULT '',
      case_code     TEXT DEFAULT '',
      case_type     TEXT DEFAULT '',
      industry      TEXT DEFAULT '',
      region        TEXT DEFAULT '',
      project_value TEXT DEFAULT '',
      team_member   TEXT NOT NULL,
      capacity_pct  INTEGER DEFAULT 50,
      start_date    DATE NOT NULL,
      end_date      DATE NOT NULL
    );
  `).catch(err => console.error('[quarterback] staffing table init:', err.message));

  // Migrate PTO: drop old day-based table, create range-based one
  pool.query(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='pto' AND column_name='date'
      ) THEN DROP TABLE pto; END IF;
    END $$;
    CREATE TABLE IF NOT EXISTS pto (
      id           SERIAL PRIMARY KEY,
      team_member  TEXT NOT NULL,
      absence_type TEXT DEFAULT 'PTO',
      start_date   DATE NOT NULL,
      end_date     DATE NOT NULL,
      capacity_pct INTEGER DEFAULT 100
    );
  `).catch(err => console.error('[quarterback] pto table init:', err.message));

  // ── GET requests ─────────────────────────────────────────────────────────────

  register('GET', 'requests', async (req, res) => {
    try {
      const [requests, teamMembers] = await Promise.all([loadRequests(), loadTeamMembers()]);
      const today = todayStr();
      const maps  = await getCapacityBatchForDate(today);

      // Build per-member blocking info for all team members
      const blocked = {}, blockReasons = {};
      for (const name of Object.keys(teamMembers)) {
        const bd = computeBreakdown(name, maps.staffingMap, maps.ptoMap, maps.backlogMap);
        if (bd.is_blocked) {
          blocked[name]      = true;
          blockReasons[name] = bd.reasons;
        }
      }

      const requestList = getActiveRequests(requests)
        .sort((a, b) => (b.assigned_to === 'Unassigned') - (a.assigned_to === 'Unassigned'))
        .map(r => ({
          ...r,
          preview:       r.short_description.slice(0, 60) + (r.short_description.length > 60 ? '…' : ''),
          is_unassigned: r.assigned_to === 'Unassigned',
        }));

      const { team, week_labels } = await buildCapacity(requests);

      sendJson(res, {
        requests:        requestList,
        team,
        team_names:      Object.keys(teamMembers).sort(),
        blocked,
        block_reasons:   blockReasons,
        unassigned_count: requestList.filter(r => r.is_unassigned).length,
        week_labels,
        today_label:     dayName(today),
        max_requests:    MAX_REQUESTS,
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

      const today = todayStr();
      const maps  = await getCapacityBatchForDate(today);
      const bd    = computeBreakdown(assignee, maps.staffingMap, maps.ptoMap, maps.backlogMap);
      const cap   = effectiveCapFromBreakdown(bd);

      if (bd.is_blocked)
        return sendError(res, 400, `${assignee} is blocked today (${bd.reasons.join(', ')})`);

      const requests = await loadRequests();
      const currentLoad = getMemberActiveRequests(requests, assignee).length;
      if (currentLoad >= cap)
        return sendError(res, 400, `${assignee} is at capacity (${currentLoad}/${cap} requests this week)`);

      await pool.query('UPDATE requests SET assigned_to=$1, status=$2 WHERE number=$3',
        [assignee, 'Assigned', number]);
      invalidateRequests();
      sendJson(res, { success: true });
    } catch (err) {
      sendError(res, 500, errMsg(err));
    }
  });

  // ── GET staffing ─────────────────────────────────────────────────────────────
  // Returns list of all staffing records ordered by start_date DESC

  register('GET', 'staffing', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT id, case_name, case_code, case_type, industry, region,
               project_value, team_member, capacity_pct,
               start_date::text, end_date::text
        FROM staffing ORDER BY start_date DESC, team_member
      `);
      sendJson(res, rows.map(r => ({
        id:            r.id,
        case_name:     r.case_name     || '',
        case_code:     r.case_code     || '',
        case_type:     r.case_type     || '',
        industry:      r.industry      || '',
        region:        r.region        || '',
        project_value: r.project_value || '',
        team_member:   r.team_member   || '',
        capacity_pct:  parseInt(r.capacity_pct) || 50,
        start_date:    (r.start_date   || '').slice(0, 10),
        end_date:      (r.end_date     || '').slice(0, 10),
      })));
    } catch (err) {
      sendError(res, 500, errMsg(err));
    }
  });

  // ── POST staffing/save ────────────────────────────────────────────────────────

  register('POST', 'staffing/save', async (req, res) => {
    try {
      const d = await readJson(req);
      if (!d.team_member || !d.start_date || !d.end_date)
        return sendError(res, 400, 'team_member, start_date and end_date are required');
      const cap = Math.max(0, Math.min(100, parseInt(d.capacity_pct) || 50));
      const p = [
        d.case_name || '', d.case_code || '', d.case_type || '',
        d.industry  || '', d.region    || '', d.project_value || '',
        d.team_member, cap, d.start_date, d.end_date,
      ];

      let id;
      if (d.id) {
        await pool.query(`
          UPDATE staffing SET case_name=$1,case_code=$2,case_type=$3,industry=$4,
            region=$5,project_value=$6,team_member=$7,capacity_pct=$8,
            start_date=$9,end_date=$10 WHERE id=$11`,
          [...p, d.id]);
        id = d.id;
      } else {
        const { rows } = await pool.query(`
          INSERT INTO staffing (case_name,case_code,case_type,industry,region,
            project_value,team_member,capacity_pct,start_date,end_date)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, p);
        id = rows[0].id;
      }

      // Spillover check: if this record covers today, re-evaluate the member's capacity
      let reassigned = 0;
      const today = todayStr();
      if (d.start_date <= today && d.end_date >= today) {
        const maps = await getCapacityBatchForDate(today);
        reassigned = await spilloverCheck(d.team_member, maps);
      }

      sendJson(res, { success: true, id, reassigned });
    } catch (err) {
      sendError(res, 500, errMsg(err));
    }
  });

  // ── POST staffing/delete ──────────────────────────────────────────────────────

  register('POST', 'staffing/delete', async (req, res) => {
    try {
      const { id } = await readJson(req);
      if (!id) return sendError(res, 400, 'Missing id');
      await pool.query('DELETE FROM staffing WHERE id=$1', [id]);
      sendJson(res, { success: true });
    } catch (err) {
      sendError(res, 500, errMsg(err));
    }
  });

  // ── GET pto ──────────────────────────────────────────────────────────────────
  // Returns list of all PTO records ordered by start_date DESC

  register('GET', 'pto', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT id, team_member, absence_type, capacity_pct,
               start_date::text, end_date::text
        FROM pto ORDER BY start_date DESC, team_member
      `);
      sendJson(res, rows.map(r => ({
        id:           r.id,
        team_member:  r.team_member  || '',
        absence_type: r.absence_type || 'PTO',
        capacity_pct: parseInt(r.capacity_pct) || 100,
        start_date:   (r.start_date  || '').slice(0, 10),
        end_date:     (r.end_date    || '').slice(0, 10),
      })));
    } catch (err) {
      sendError(res, 500, errMsg(err));
    }
  });

  // ── POST pto/save ─────────────────────────────────────────────────────────────

  register('POST', 'pto/save', async (req, res) => {
    try {
      const d = await readJson(req);
      if (!d.team_member || !d.start_date || !d.end_date)
        return sendError(res, 400, 'team_member, start_date and end_date are required');
      const cap  = Math.max(0, Math.min(100, parseInt(d.capacity_pct) || 100));
      const type = d.absence_type || 'PTO';
      const p    = [d.team_member, type, d.start_date, d.end_date, cap];

      let id;
      if (d.id) {
        await pool.query(`
          UPDATE pto SET team_member=$1,absence_type=$2,start_date=$3,end_date=$4,
            capacity_pct=$5 WHERE id=$6`, [...p, d.id]);
        id = d.id;
      } else {
        const { rows } = await pool.query(`
          INSERT INTO pto (team_member,absence_type,start_date,end_date,capacity_pct)
          VALUES ($1,$2,$3,$4,$5) RETURNING id`, p);
        id = rows[0].id;
      }

      let reassigned = 0;
      const today = todayStr();
      if (d.start_date <= today && d.end_date >= today) {
        const maps = await getCapacityBatchForDate(today);
        reassigned = await spilloverCheck(d.team_member, maps);
      }

      sendJson(res, { success: true, id, reassigned });
    } catch (err) {
      sendError(res, 500, errMsg(err));
    }
  });

  // ── POST pto/delete ───────────────────────────────────────────────────────────

  register('POST', 'pto/delete', async (req, res) => {
    try {
      const { id } = await readJson(req);
      if (!id) return sendError(res, 400, 'Missing id');
      await pool.query('DELETE FROM pto WHERE id=$1', [id]);
      sendJson(res, { success: true });
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
        end_date:        (r.end_date   || '').slice(0, 10),
        priority:        r.priority || 'Unset',
        hours:           parseFloat(r.hours) || 0,
        completion_date: (r.completion_date || '').slice(0, 10),
        practice:        r.practice    || '',
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
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
          RETURNING id`, p);
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

      const [requests, teamMembers] = await Promise.all([loadRequests(), loadTeamMembers()]);
      const today = todayStr();
      const maps  = await getCapacityBatchForDate(today);

      const capacity = [];
      for (const [name, country] of Object.entries(teamMembers)) {
        const load      = getMemberActiveRequests(requests, name).length;
        const bd        = computeBreakdown(name, maps.staffingMap, maps.ptoMap, maps.backlogMap);
        const cap       = effectiveCapFromBreakdown(bd);
        const entry     = {
          name, country,
          current_requests:   load,
          effective_capacity: cap,
          remaining_capacity: Math.max(0, cap - load),
          blocked:            bd.is_blocked,
          block_reasons:      bd.reasons,
        };
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
        const ocNames     = overcapacity.map(m => m.name).join(', ');
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

      const today       = todayStr();
      const maps        = await getCapacityBatchForDate(today);
      const requests    = await loadRequests();
      const loadTracker = {};
      const applied = [], skipped = [];

      for (const { number, assignee } of recommendations) {
        if (!number || !assignee) continue;
        if (loadTracker[assignee] === undefined)
          loadTracker[assignee] = getMemberActiveRequests(requests, assignee).length;
        const bd  = computeBreakdown(assignee, maps.staffingMap, maps.ptoMap, maps.backlogMap);
        const cap = effectiveCapFromBreakdown(bd);
        if (loadTracker[assignee] >= cap) { skipped.push(number); continue; }
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

      const [requests, teamMembers] = await Promise.all([loadRequests(), loadTeamMembers()]);

      // Active request count per person (current week only)
      const activeReqs = {};
      for (const r of getActiveRequests(requests)) {
        if (r.assigned_to && r.assigned_to !== 'Unassigned')
          activeReqs[r.assigned_to] = (activeReqs[r.assigned_to] || 0) + 1;
      }

      // Build week ranges
      const baseMonday = addDays(getMondayStr(), offset * 7);
      const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const weekRanges = [];
      for (let w = 0; w < weeks; w++) {
        const from = addDays(baseMonday, w * 7);
        const to   = addDays(from, 4);
        const fd   = new Date(from + 'T00:00:00Z');
        const td   = new Date(to   + 'T00:00:00Z');
        const label = fd.getUTCMonth() === td.getUTCMonth()
          ? `${MONTHS[fd.getUTCMonth()]} ${fd.getUTCDate()}–${td.getUTCDate()}`
          : `${MONTHS[fd.getUTCMonth()]} ${fd.getUTCDate()} – ${MONTHS[td.getUTCMonth()]} ${td.getUTCDate()}`;
        weekRanges.push({ from, to, label });
      }

      const rangeStart = weekRanges[0].from;
      const rangeEnd   = weekRanges[weekRanges.length - 1].to;

      // Load all staffing, PTO, backlog records covering the view range
      const [{ rows: staffingRows }, { rows: ptoRows }, { rows: backlogRows }] = await Promise.all([
        pool.query(
          `SELECT team_member, case_name, capacity_pct, start_date::text, end_date::text
           FROM staffing WHERE start_date <= $1 AND end_date >= $2`, [rangeEnd, rangeStart]
        ),
        pool.query(
          `SELECT team_member, absence_type, capacity_pct, start_date::text, end_date::text
           FROM pto WHERE start_date <= $1 AND end_date >= $2`, [rangeEnd, rangeStart]
        ),
        pool.query(
          `SELECT name, lead, team, start_date::text, end_date::text,
                  allocation_pct, lead_alloc, team1_alloc, team2_alloc, team3_alloc
           FROM backlog
           WHERE start_date IS NOT NULL AND end_date IS NOT NULL
             AND status NOT IN ('Complete','Deprioritized')
             AND start_date <= $1 AND end_date >= $2`, [rangeEnd, rangeStart]
        ),
      ]);

      const today   = todayStr();
      const members = Object.keys(teamMembers).sort();
      const data    = {};

      for (const name of members) {
        data[name] = {};
        for (const week of weekRanges) {
          // Staffing: sum capacity_pct for records overlapping this week
          const sItems = staffingRows.filter(r =>
            r.team_member === name &&
            r.start_date <= week.to && r.end_date >= week.from
          );
          const staffingPct = Math.min(sItems.reduce((s, r) => s + (parseInt(r.capacity_pct) || 0), 0), 100);

          // PTO: sum capacity_pct for records overlapping this week
          const pItems = ptoRows.filter(r =>
            r.team_member === name &&
            r.start_date <= week.to && r.end_date >= week.from
          );
          const ptoPct = Math.min(pItems.reduce((s, r) => s + (parseInt(r.capacity_pct) || 0), 0), 100);

          // Backlog
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

          const isCurrent = week.from <= today && week.to >= today;
          const reqCount  = isCurrent ? (activeReqs[name] || 0) : 0;
          const reqPct    = Math.round((reqCount / MAX_REQUESTS) * 100);
          const total     = staffingPct + ptoPct + backlogPct + reqPct;

          data[name][week.from] = {
            staffing_pct: staffingPct,
            pto_pct:      ptoPct,
            backlog_pct:  backlogPct,
            backlog_items: backlogItems,
            req_count:    reqCount,
            req_pct:      reqPct,
            total,
            is_current:   isCurrent,
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
