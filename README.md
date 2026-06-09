# Tenyks — TDA Vantage Platform

Internal tools platform for BCG TDA Boston. Each app lives in its own folder under `apps/` and gets a tile on the homepage automatically.

## !! More documentation is in the `docs/` folder
* Supported features in an `/apps/...` folder
  * Config 👉 See `APP-STRUCTURE.md`
  * API calling (Agents, Claude, Postgres) 👉 See `API.md`
  * Overall Claude help/context 👉 `CLAUDE.md`

---

## Local setup

**Prerequisites:** Node.js 20+

```bash
git clone https://github.com/bcgx-pi-60017564-1-2/tenyks.git
cd tenyks
npm install
npm run dev
```

Open `http://localhost:5173` — you'll see the platform homepage. The dev server hot-reloads as you edit `src/`.

> The `npm run dev` command also runs the app-discovery script, so any `config.yaml` changes are picked up on restart.

---

## Adding your app

### Step 1 — Create your folder

```
apps/
  your-app-name/
    config.yaml     ← required
    index.html      ← your app
    assets/         ← JS, CSS, images (if any)
```

The folder name becomes your app's URL: `apps/my-tool/` → served at `/my-tool`.

---

### Step 2 — Configure `config.yaml`

```yaml
name: "My Tool"
description: "One or two sentences about what this does."
icon: "🔧"
accent: "#6366f1"
author: "Your Name"
tag: "Analytics"
status: live
```

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Display name on the tile |
| `description` | yes | Shown under the name |
| `icon` | yes | Emoji |
| `accent` | yes | Hex color for the tile's highlight |
| `author` | yes | Your name |
| `tag` | no | Short badge label e.g. `"AI"`, `"Ops"`, `"Survey"` |
| `status` | no | `live` (default) or `coming_soon` |

---

### Step 3 — Add your app files

#### Option A — Single HTML file

Just drop your `index.html` directly in the folder. Works for anything self-contained.

```
apps/my-tool/
  config.yaml
  index.html
```

#### Option B — SPA built with Vite (or any bundler)

Build your app locally, then copy the build output into your app folder:

```bash
# inside your SPA project
npm run build

# copy the contents of dist/ into your apps/ folder
cp -r dist/* /path/to/tenyks/apps/my-tool/
```

> If your SPA uses client-side routing (React Router etc.), the platform server handles the fallback automatically — any path under `/my-tool/*` serves your `index.html`.

**Important:** if your Vite app uses a `base` path, set it to your folder name so assets resolve correctly:

```ts
// vite.config.ts in your SPA project
export default defineConfig({
  base: '/my-tool/',
})
```

---

### Step 4 — Test locally

```bash
npm run build   # builds platform + copies all app folders into dist/
node server.js  # serves everything at http://localhost:3000
```

Your tile should appear on the homepage and `/my-tool` should load your app.

---

### Step 5 — Ship it

1. Open a Pull Request on GitHub
2. Michael reviews and merges
3. Auto-deploys to `tda-vantage-dev`, acessible at `vantage.bcg.com/[folder-name]` within minutes — your tile is live

---

## How the build works

```
npm run build
  │
  ├── prebuild  scripts/generate-apps.js
  │             Reads apps/*/config.yaml → generates src/apps.generated.ts
  │
  ├── build     vite build
  │             Compiles the React homepage → dist/
  │
  └── postbuild scripts/copy-apps.js
                Copies apps/{folder}/* (excluding config.yaml) → dist/{folder}/
```

The final `dist/` is a flat static tree served by `server.js` (zero dependencies — native Node only).
