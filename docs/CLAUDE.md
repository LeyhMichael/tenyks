# CLAUDE.md

## What this is

A static platform homepage (Vite + React + TypeScript at root) that auto-discovers apps from `apps/*/config.yaml` and renders a tile grid. Each app is a self-contained folder of static files served at `/{folder-name}`.

---

## Key files

| File | Role |
|---|---|
| `src/App.tsx` | Platform homepage component |
| `src/apps.generated.ts` | **Auto-generated** — do not edit. Rebuilt every `npm run dev` / `npm run build` |
| `src/types.ts` | `AppConfig` interface — source of truth for the config.yaml schema |
| `scripts/generate-apps.js` | Reads `apps/*/config.yaml` → writes `src/apps.generated.ts` |
| `scripts/copy-apps.js` | Copies `apps/{folder}/*` (minus `config.yaml`) → `dist/{folder}/` |
| `server.js` | Zero-dependency native Node `http` server for production. No Express by design. |
| `vite.config.ts` | Contains `serveApps()` plugin — mirrors server.js routing logic in dev |
| `lib/llm.js` | Shared Anthropic client — `const { claude } = require('../../lib/llm')` |
| `lib/stream.js` | SSE streaming helper — `const { streamText } = require('../../lib/stream')` |

---

## Dev workflow

```bash
npm install
npm run dev     # runs generate-apps.js, then starts Vite at localhost:5173
```

Sub-apps are served in dev by the `serveApps()` Vite middleware plugin in `vite.config.ts`. It intercepts all requests matching an `apps/` folder and serves static files and API routes directly — same logic as `server.js`, no extra config needed.

Changes to files in `apps/` trigger a full browser reload. Changes to `config.yaml` re-run `generate-apps.js` so the homepage tile updates via HMR. Changes to `api.js` require a dev server restart (Node module cache).

The watcher ignores Python files (`*.py`, `*.pyc`, `__pycache__`), `dist/`, `node_modules/`, and `.git/` to prevent infinite rebuild loops from non-frontend files.

---

## Build pipeline

```
prebuild  → scripts/generate-apps.js   (reads config.yamls → apps.generated.ts)
build     → vite build                 (compiles React homepage → dist/)
postbuild → scripts/copy-apps.js       (copies apps/{folder}/* → dist/{folder}/)
```

Run `npm run build && node server.js` to test production locally.

---

## App contributor contract

Each app folder needs:
- `config.yaml` — platform metadata (name, description, icon, accent, author, tag?, status?)
- Built app files at the folder root (`index.html`, assets, etc.) — **not** in a `dist/` subfolder

The folder name is the URL. `apps/my-tool/` → `/my-tool`.

**Folders prefixed with `_`** (e.g. `apps/_template-agent/`) are ignored by both `generate-apps.js`
and `copy-apps.js` — they do not get a homepage tile and are not deployed. Use `_` prefix for
templates and experiments.

---

## Building an agent app

The platform ships two shared utilities for Claude-powered apps:

```js
const { claude }     = require('../../lib/llm');    // shared Anthropic client
const { streamText } = require('../../lib/stream'); // SSE streaming helper
```

A working starter lives in `apps/_template-agent/` — copy it, rename the folder (remove the `_`),
and customise the system prompt, model, and UI. Full guide: `docs/AGENT-GUIDE.md`.

**Prerequisite:** set `ANTHROPIC_API_KEY` in Azure App Service → Configuration → Application Settings.

---

## Deployment

- **Target:** Azure App Service (`tda-vantage-dev`), Node.js runtime
- **Trigger:** push to `main` → `.github/workflows/deploy.yml`
- **Flow:** GH Actions runs `npm install && npm run build`, deploys entire working directory. App Service runs `npm start` → `node server.js`.
- **Secret:** `AZURE_WEBAPP_PUBLISH_PROFILE`

---

## Constraints and decisions

- **No Express, no external server packages.** `server.js` uses only built-in Node `http`/`fs`/`path`. Keep it that way.
- **No runtime API.** The app list is baked in at build time via `apps.generated.ts`. There is no `/api/apps` endpoint.
- **`platform/` folder** exists on disk (untracked). Ignore it — it's an old experiment. Work belongs at root.
- **Quarterback** (`apps/quarterback/`) is a live React SPA backed by PostgreSQL. See its `api.js` for a full example of DB + Claude usage in a real app.
- **TypeScript is relaxed** (`strict: false`). Don't tighten it without asking.
