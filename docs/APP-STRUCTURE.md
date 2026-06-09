# App Structure

Every app in `apps/` is a self-contained folder. The platform routes `/{folder-name}` to that folder's `index.html` and `/{folder-name}/api/*` to its `api.js`. Apps do not know about the platform or each other.

---

## Files

```
apps/my-tool/
  config.yaml     ← platform tile metadata (required)
  index.html      ← frontend entry point (required)
  app.js          ← frontend JavaScript
  style.css       ← styles
  api.js          ← backend handlers (optional — only if you need server-side logic)
  assets/         ← images, fonts, other static files
```

### `config.yaml`

Describes the app on the platform homepage tile. Required fields:

```yaml
name: "My Tool"
description: "One-line description shown on the tile."
icon: "🔧"
accent: "#3b82f6"
author: "Your Name"
```

Optional fields:

```yaml
tag: "Beta"           # small label shown on the tile
status: "coming_soon" # omit or set to "live" to show on the homepage
```

### `index.html`

The frontend entry point. Served as-is — it is **not** processed through Vite's transform pipeline. Reference assets with relative paths so they resolve correctly at `/{folder-name}/`.

```html
<link rel="stylesheet" href="style.css">
<script src="app.js" defer></script>
```

If your app is a pre-built React/Vite SPA (compiled output), drop the built files directly in the folder root. The platform serves them without reprocessing.

### `app.js`

All frontend logic — DOM manipulation, state, and `fetch()` calls to the app's own API at `/{folder-name}/api/*`. No build step required; plain browser JavaScript works fine. Use relative URLs for API calls so they work in both dev and production:

```js
fetch('api/my-endpoint')           // resolves to /{folder-name}/api/my-endpoint
fetch('api/items', { method: 'POST', ... })
```

### `style.css`

All styles for the app. Self-contained — there is no shared platform stylesheet to inherit from.

### `api.js`

Server-side handlers for anything that needs secrets, database access, or external APIs. See `API.md` for the full contract. Only include this file if the app needs a backend.

---

## Rules

- **Self-contained.** An app must not import from or depend on another app folder.
- **No `dist/` subfolder.** Files go at the folder root, not inside a `dist/` subdirectory.
- **Relative paths only.** All asset references (`src=`, `href=`, CSS `url()`) must use relative paths (e.g. `./hero.jpg`, not `/hero.jpg`) so the app works at any mount point.
- **No local `package.json`.** Platform-level packages (`pg`, `@anthropic-ai/sdk`) are available via `require()` in `api.js` without a separate install.
- **Filenames with spaces work.** The platform URL-decodes requests before filesystem lookup, so `hero bg.jpg` is served correctly when the browser requests `hero%20bg.jpg`. That said, prefer hyphens in filenames to avoid surprises elsewhere.
- **`api.js` changes need a server restart.** Node caches `require()`'d modules. After editing `api.js`, restart `npm run dev` for changes to take effect.
