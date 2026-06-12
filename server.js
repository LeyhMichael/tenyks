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
// Route table: "METHOD /appname/api/suffix" → handler

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

// ── Request handler ───────────────────────────────────────────────────────────

http.createServer({ maxHeaderSize: 32768 }, async (req, res) => {
  const rawPath = new URL(req.url, 'http://x').pathname;
  const urlPath = rawPath.replace(/\/$/, '') || '/';

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
  const topSegment = urlPath.split('/')[1];
  if (topSegment) {
    const subIndex = path.join(DIST, topSegment, 'index.html');
    if (fs.existsSync(subIndex)) {
      // Redirect /{app} → /{app}/ so relative asset paths resolve correctly
      if (urlPath === `/${topSegment}` && !rawPath.endsWith('/')) {
        res.writeHead(301, { Location: `/${topSegment}/` });
        return res.end();
      }
      return send(res, subIndex);
    }
  }

  // 4. Platform homepage fallback
  send(res, path.join(DIST, 'index.html'));
}).listen(PORT, () => console.log(`Tenyks running on port ${PORT}`));
