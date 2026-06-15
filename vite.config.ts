import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const MIME: Record<string, string> = {
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

// Mirrors the helpers passed to api.js in server.js
function readJson(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: any) => (body += chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
    });
  });
}

function sendJson(res: any, data: any, status = 200) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

function sendError(res: any, status: number, message: string) {
  sendJson(res, { error: message }, status);
}

function serveApps(): Plugin {
  const appsDir = path.resolve(process.cwd(), 'apps');

  // Load api.js routes at plugin init — same scan as server.js
  const apiRoutes = new Map<string, (req: any, res: any) => Promise<void>>();

  if (fs.existsSync(appsDir)) {
    for (const folder of fs.readdirSync(appsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)) {

      const apiPath = path.join(appsDir, folder, 'api.js');
      if (!fs.existsSync(apiPath)) continue;

      try {
        const appApi = require(apiPath);
        appApi({
          readJson,
          sendJson,
          sendError,
          register(method: string, suffix: string, handler: any) {
            const key = `${method.toUpperCase()} /${folder}/api/${suffix.replace(/^\//, '')}`;
            apiRoutes.set(key, handler);
            console.log(`[api] registered: ${key}`);
          },
        });
        console.log(`[dev] Loaded API: apps/${folder}/api.js`);
      } catch (err: any) {
        console.error(`[dev] Failed to load apps/${folder}/api.js:`, err.message);
      }
    }
  }

  return {
    name: 'serve-apps',

    handleHotUpdate({ file, server }) {
      if (!file.startsWith(appsDir)) return;

      if (file.endsWith('config.yaml')) {
        // Regenerate the app list — Vite will HMR apps.generated.ts automatically
        const { execSync } = require('child_process');
        execSync('node scripts/generate-apps.js', { cwd: process.cwd() });
        return;
      }

      // Any other app file change — full reload so the browser gets the new static file
      server.hot.send({ type: 'full-reload' });
      return [];
    },

    configureServer(server) {
      // Must run before Vite's internal middleware — specifically before
      // htmlFallbackMiddleware which would otherwise hijack any navigation
      // to an app folder path and serve the platform homepage instead.
      server.middlewares.use((req: any, res: any, next: any) => {
        const urlPath = (req.url ?? '/').split('?')[0];
        const parts = urlPath.split('/').filter(Boolean);
        if (!parts.length) return next();

        const folder = parts[0];
        const folderPath = path.join(appsDir, folder);
        if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) return next();

        // API route
        const apiKey = `${req.method} ${urlPath}`;
        if (apiRoutes.has(apiKey)) {
          apiRoutes.get(apiKey)!(req, res).catch((err: any) => {
            if (!res.headersSent) {
              const parts = [err.message, err.detail, err.hint].filter(Boolean);
              const msg = parts.join(' — ') || String(err);
              console.error('[api error]', err.code || '', msg);
              sendError(res, 500, msg);
            }
          });
          return;
        }

        // Exact static file — decode percent-encoded chars (e.g. spaces → %20)
        const rawSub = parts.slice(1).join('/');
        const subPath = (() => { try { return decodeURIComponent(rawSub); } catch { return rawSub; } })();
        if (subPath) {
          const filePath = path.join(folderPath, subPath);
          if (filePath.startsWith(folderPath) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            res.setHeader('Content-Type', MIME[path.extname(filePath)] ?? 'application/octet-stream');
            return res.end(fs.readFileSync(filePath));
          }
        }

        // SPA fallback — serve raw HTML, NOT through transformIndexHtml
        // (sub-apps are pre-built static files, not Vite source)
        const indexPath = path.join(folderPath, 'index.html');
        if (fs.existsSync(indexPath)) {
          if (parts.length === 1 && !urlPath.endsWith('/')) {
            res.writeHead(302, { Location: `/${folder}/` });
            return res.end();
          }
          const html = fs.readFileSync(indexPath, 'utf8').replace('</body>', '<script src="/back-nav.js"></script>\n</body>');
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          return res.end(html);
        }

        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), serveApps()],
  server: {
    watch: {
      ignored: [
        '**/*.py', '**/*.pyc', '**/__pycache__/**',
        '**/node_modules/**', '**/.git/**', '**/dist/**',
      ],
    },
  },
});
