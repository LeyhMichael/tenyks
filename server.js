const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DIST = path.join(__dirname, 'dist');
const APPS = path.join(__dirname, 'apps');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
};

// ── Team membership ───────────────────────────────────────────────────────────
// Set TEAM_EMAILS in Azure App Service → Settings → Environment variables.
// Comma-separated BCG email addresses of team members who may access
// visibility:"team" apps (quarterback, onboarding).
// Example: TEAM_EMAILS=michael.leyh@bcg.com,carmen.casas@bcg.com

const TEAM_EMAILS = new Set(
  (process.env.TEAM_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

// Routes whose top-level folder requires team membership
const TEAM_PATHS = new Set(['quarterback', 'onboarding', 'testing']);

// Azure App Service EasyAuth injects the signed-in user's UPN / email here
function getCallerEmail(req) {
  // X-MS-CLIENT-PRINCIPAL-NAME is the UPN (user@bcg.com) set by EasyAuth
  const raw = req.headers['x-ms-client-principal-name'] || '';
  return raw.trim().toLowerCase();
}

function isTeamMember(email) {
  if (!email) return false;
  // If TEAM_EMAILS is not configured at all, allow everyone (dev / fallback)
  if (TEAM_EMAILS.size === 0) return true;
  return TEAM_EMAILS.has(email);
}

// ── Shared utilities passed to every api.js ──────────────────────────────────

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
    });
  });
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendError(res, status, message) {
  sendJson(res, { error: message }, status);
}

// ── Load per-app API routes ───────────────────────────────────────────────────

const apiRoutes = new Map();

if (fs.existsSync(APPS)) {
  for (const folder of fs.readdirSync(APPS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)) {

    const apiPath = path.join(APPS, folder, 'api.js');
    if (!fs.existsSync(apiPath)) continue;

    try {
      const appApi = require(apiPath);
      appApi({
        readJson,
        sendJson,
        sendError,
        register(method, suffix, handler) {
          const key = `${method.toUpperCase()} /${folder}/api/${suffix.replace(/^\//, '')}`;
          apiRoutes.set(key, handler);
          console.log(`  ${method.toUpperCase()} /${folder}/api/${suffix.replace(/^\//, '')}`);
        },
      });
      console.log(`Loaded API: apps/${folder}/api.js`);
    } catch (err) {
      console.error(`Failed to load apps/${folder}/api.js:`, err.message);
    }
  }
}

// ── Static file helper ────────────────────────────────────────────────────────

function send(res, filePath) {
  const type = MIME[path.extname(filePath)] || 'application/octet-stream';
  const data = fs.readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': type });
  res.end(data);
}

// ── 403 page ──────────────────────────────────────────────────────────────────

function send403(res, email) {
  res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Access Restricted · Vantage Platform</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         background:#f8f9fb;color:#111827;display:flex;align-items:center;
         justify-content:center;min-height:100vh;padding:24px}
    .card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;
          padding:40px 48px;max-width:460px;width:100%;text-align:center;
          box-shadow:0 4px 20px rgba(0,0,0,0.06)}
    .icon{font-size:40px;margin-bottom:16px}
    h1{font-size:20px;font-weight:700;margin-bottom:8px;color:#111827}
    p{font-size:14px;color:#6b7280;line-height:1.6;margin-bottom:6px}
    .email{font-size:13px;color:#9ca3af;margin:12px 0 24px;
           background:#f3f4f6;padding:6px 12px;border-radius:6px;
           display:inline-block;word-break:break-all}
    a{display:inline-block;margin-top:8px;padding:9px 20px;background:#1a7f4b;
      color:#fff;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600}
    a:hover{background:#15693d}
    .home{background:none;border:1px solid #d1d5db;color:#374151;
          margin-left:8px;padding:9px 20px;border-radius:8px;
          font-size:14px;font-weight:600;text-decoration:none;display:inline-block}
    .home:hover{background:#f3f4f6}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🔒</div>
    <h1>Team access only</h1>
    <p>This tool is restricted to members of the TDA Vantage team.</p>
    ${email ? `<div class="email">Signed in as: ${email}</div>` : ''}
    <p>If you should have access, ask Michael Leyh to add your email to the team list.</p>
    <a href="mailto:michael.leyh@bcg.com?subject=Vantage team access request">Request access</a>
    <a href="/" class="home">← Back to platform</a>
  </div>
</body>
</html>`);
}

// ── Request handler ───────────────────────────────────────────────────────────

http.createServer({ maxHeaderSize: 32768 }, async (req, res) => {
  const rawPath = new URL(req.url, 'http://x').pathname;
  const urlPath = rawPath.replace(/\/$/, '') || '/';
  const topSegment = urlPath.split('/')[1];

  // ── Team-membership guard for protected apps ─────────────────────────────
  // Applies to both page requests and API calls under a protected folder.
  // On localhost (no EasyAuth header) the guard is bypassed automatically
  // because getCallerEmail() returns '' and isTeamMember('') is true when
  // TEAM_EMAILS is empty (dev mode).
  if (TEAM_PATHS.has(topSegment)) {
    const email = getCallerEmail(req);
    if (!isTeamMember(email)) {
      return send403(res, email);
    }
  }

  // ── /api/me — identity & team-membership endpoint used by the frontend ───
  if (urlPath === '/api/me') {
    const email = getCallerEmail(req);
    return sendJson(res, {
      email: email || null,
      isTeamMember: isTeamMember(email),
    });
  }

  // 1. Per-app API routes
  const key = `${req.method} ${urlPath}`;
  if (apiRoutes.has(key)) {
    try {
      await apiRoutes.get(key)(req, res);
    } catch (err) {
      const parts = [err.message, err.detail, err.hint].filter(Boolean);
      const msg = parts.join(' — ') || String(err);
      console.error('[server]', err.code || '', msg);
      sendError(res, 500, msg);
    }
    return;
  }

  // 2. Exact static file match
  const file = path.join(DIST, urlPath);
  if (fs.existsSync(file) && fs.statSync(file).isFile()) return send(res, file);

  // 3. SPA fallback for sub-apps: /quarterback/anything → dist/quarterback/index.html
  if (topSegment) {
    const subIndex = path.join(DIST, topSegment, 'index.html');
    if (fs.existsSync(subIndex)) {
      // Redirect /{app} → /{app}/ so relative asset paths resolve correctly
      if (urlPath === `/${topSegment}` && !rawPath.endsWith('/')) {
        res.writeHead(301, { Location: `/${topSegment}/` });
        return res.end();
      }
      const html = fs.readFileSync(subIndex, 'utf8').replace('</body>', '<script src="/back-nav.js"></script>\n</body>');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
  }

  // 4. Platform homepage fallback
  send(res, path.join(DIST, 'index.html'));
}).listen(PORT, () => console.log(`Tenyks running on port ${PORT}`));
