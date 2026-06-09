# App Backend API Spec

Apps that need server-side logic (database access, AI calls, secrets) can include an `api.js`
file in their folder. The platform loads it automatically — no edits to platform files required.

---

## How it works

At startup, `server.js` (production) and the `serveApps()` Vite plugin (dev) scan every
`apps/*/api.js`. For each one found, they call the exported function and pass a `register`
helper plus shared utilities. The app uses those to declare its endpoints. Incoming requests
matching `/{appname}/api/*` are routed to the right handler before static file serving runs.

```
Request: POST /quarterback/api/assign
  └── route table lookup
        └── match → calls handler in apps/quarterback/api.js
              └── handler reads body, calls pg/Anthropic, writes JSON response
```

---

## Contract

`api.js` must export a single function. The platform calls it once at startup.

```js
module.exports = function ({ register, readJson, sendJson, sendError }) {
  // register your endpoints here
};
```

### `register(method, suffix, handler)`

Registers one endpoint.

| Param | Type | Example |
|---|---|---|
| `method` | string | `'GET'`, `'POST'`, `'DELETE'` |
| `suffix` | string | `'assign'` → mounts at `/{appname}/api/assign` |
| `handler` | async function | `async (req, res) => {}` |

The suffix is relative to `/{appname}/api/`. Do not include the app name or `/api/` prefix.

```js
// mounts at /quarterback/api/assign
register('POST', 'assign', async (req, res) => { ... });

// mounts at /quarterback/api/requests
register('GET', 'requests', async (req, res) => { ... });
```

### `readJson(req)` → `Promise<object>`

Reads and parses the request body as JSON.

```js
const body = await readJson(req);
const { userId, requestId } = body;
```

### `sendJson(res, data, status = 200)`

Writes a JSON response.

```js
sendJson(res, { success: true, id: 42 });
sendJson(res, { items: [] }, 200);
```

### `sendError(res, status, message)`

Writes an error response.

```js
sendError(res, 400, 'Missing required field: userId');
sendError(res, 500, 'Database error');
```

---

## Environment variables

Secrets (API keys, DB credentials) are set in Azure App Service → Configuration →
Application Settings. Access them via `process.env`:

```js
process.env.ANTHROPIC_API_KEY
process.env.DB_HOST
process.env.DB_PASSWORD
process.env.DB_NAME
process.env.DB_USER
```

Never hardcode secrets. Never commit `.env` files.

---

## Available packages

These are installed at the platform level — no local `package.json` needed in your app folder:

| Package | Import | Use for |
|---|---|---|
| `@anthropic-ai/sdk` | `require('@anthropic-ai/sdk')` | Claude API calls |
| `pg` | `require('pg')` | PostgreSQL queries |

---

## Full example

```js
// apps/my-tool/api.js

const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl:      { rejectUnauthorized: false },
});

module.exports = function ({ register, readJson, sendJson, sendError }) {

  register('GET', 'items', async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM items ORDER BY created_at DESC');
      sendJson(res, result.rows);
    } catch (err) {
      sendError(res, 500, err.message);
    }
  });

  register('POST', 'summarise', async (req, res) => {
    try {
      const { text } = await readJson(req);
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic();
      const message = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: `Summarise this: ${text}` }],
      });
      sendJson(res, { summary: message.content[0].text });
    } catch (err) {
      sendError(res, 500, err.message);
    }
  });

};
```

---

## Local development

`npm run dev` handles everything. The `serveApps()` Vite plugin in `vite.config.ts` loads
all `api.js` files at startup and routes `/{appname}/api/*` requests the same way `server.js`
does. No proxy config needed, no separate server to run.

**Important:** changes to `api.js` require restarting the dev server (`Ctrl-C`, `npm run dev`).
Node caches `require()`'d modules — editing the file does not hot-reload the backend.

To test production routing exactly:

```bash
npm run build
node server.js   # endpoints live at localhost:3000/{appname}/api/*
```

---

## File layout

```
apps/my-tool/
  config.yaml     ← platform tile metadata
  index.html      ← frontend entry point
  api.js          ← backend handlers (optional)
  assets/         ← JS, CSS, images
```
