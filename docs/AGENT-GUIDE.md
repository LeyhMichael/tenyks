# Building an Agent on the Vantage Platform

This guide takes you from zero to a streaming Claude agent in one afternoon.
For platform architecture and the app registration contract, see `CLAUDE.md` and `APP-STRUCTURE.md`.

---

## Quickstart

```bash
# 1. Copy the template
cp -r apps/_template-agent apps/my-tool

# 2. Edit metadata
nano apps/my-tool/config.yaml

# 3. Customise the agent
nano apps/my-tool/api.js      # system prompt, model, tools
nano apps/my-tool/index.html  # UI

# 4. Run locally
npm run dev
# → visit http://localhost:5173/my-tool
```

---

## Platform utilities

### Shared Claude client — `lib/llm.js`

```js
const { claude } = require('../../lib/llm');
```

A pre-configured `Anthropic` client. Reads `ANTHROPIC_API_KEY` from the environment.
No setup needed — just import and call.

### SSE streaming helper — `lib/stream.js`

```js
const { streamText } = require('../../lib/stream');
```

Pipes a `claude.messages.stream(...)` call to the browser as Server-Sent Events.
The browser reads word-by-word using the fetch + `ReadableStream` pattern shown in the template.

---

## Anatomy of api.js

```js
const { claude }     = require('../../lib/llm');
const { streamText } = require('../../lib/stream');

const SYSTEM_PROMPT = `You are a specialist in X. Be concise.`;

module.exports = function ({ register, readJson, sendJson, sendError }) {

  register('POST', 'chat', async (req, res) => {
    const { message, history = [] } = await readJson(req);

    const messages = [...history, { role: 'user', content: message }];

    const stream = claude.messages.stream({
      model:      'claude-haiku-4-5-20251001',  // or claude-sonnet-4-5 for harder tasks
      max_tokens: 1024,
      system:     SYSTEM_PROMPT,
      messages,
    });

    await streamText(res, stream);
  });

};
```

The browser sends the full conversation history on each turn (stateless server).
The template agent (`apps/_template-agent/api.js`) shows the alternative: server-side history in a `Map`.

---

## Choosing a conversation history strategy

| Strategy | When to use | How |
|---|---|---|
| **Client-side** | Simple apps, demos | Browser accumulates messages array and sends it each request |
| **Server-side Map** | Single-server, non-critical | `Map<userId, messages[]>` in api.js (lost on restart) |
| **PostgreSQL** | Production | `conversations` + `messages` tables; see below |

### PostgreSQL schema (if you need persistence)

```sql
CREATE TABLE agent_conversations (
  id         SERIAL PRIMARY KEY,
  user_id    TEXT NOT NULL,
  app_name   TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE agent_messages (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER REFERENCES agent_conversations(id),
  role            TEXT NOT NULL,   -- 'user' | 'assistant'
  content         TEXT NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON agent_messages(conversation_id);
```

### Loading history from the DB

```js
const { Pool } = require('pg');
const pool = new Pool({ host: process.env.DB_HOST, /* ... */ });

async function loadHistory(conversationId) {
  const result = await pool.query(
    'SELECT role, content FROM agent_messages WHERE conversation_id = $1 ORDER BY id',
    [conversationId]
  );
  return result.rows;
}
```

---

## Adding tools (function calling)

Give your agent the ability to take actions:

```js
const tools = [
  {
    name: 'search_database',
    description: 'Search the internal database for records matching a query.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms' },
      },
      required: ['query'],
    },
  },
];

// In your stream call:
const stream = claude.messages.stream({
  model:    'claude-sonnet-4-5',   // use Sonnet+ for tool use — Haiku struggles with complex tool calls
  max_tokens: 2048,
  system:   SYSTEM_PROMPT,
  tools,
  messages,
});
```

For the tool-use agentic loop (model calls tool → you execute it → model resumes), see the
[Anthropic tool use docs](https://docs.anthropic.com/en/docs/tool-use) and the `@anthropic-ai/sdk` README.

---

## Getting the current user

Azure Easy Auth injects the authenticated user's identity into every request header.
Use this to scope history, personalise responses, or gate features:

```js
function getUserId(req) {
  // Email when Easy Auth is on; falls back gracefully in local dev
  return req.headers['x-ms-client-principal-name'] || 'anonymous';
}
```

---

## Model selection guide

| Task | Recommended model |
|---|---|
| Simple Q&A, summarisation, extraction | `claude-haiku-4-5-20251001` |
| Reasoning, writing, analysis | `claude-sonnet-4-5` |
| Complex multi-step agents, hard coding | `claude-opus-4-5` |

Start with Haiku (fast, cheap), upgrade to Sonnet when you need better output quality.
Avoid Opus for high-volume calls — reserve it for genuinely hard reasoning tasks.

---

## Environment variables

All secrets live in Azure App Service → Configuration → Application Settings.
These are available to every app's `api.js` via `process.env`:

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Required for all agent apps |
| `DB_HOST` | PostgreSQL host |
| `DB_USER` | PostgreSQL user |
| `DB_PASSWORD` | PostgreSQL password |
| `DB_NAME` | PostgreSQL database name |

For local dev, create a `.env` file at the repo root (it's gitignored):

```
ANTHROPIC_API_KEY=sk-ant-...
DB_HOST=...
```

Then load it in your terminal: `export $(cat .env | xargs)` before `npm run dev`.

---

## Checklist before you ship

- [ ] System prompt written and tested
- [ ] Model chosen to match task complexity
- [ ] History strategy decided (client / server Map / DB)
- [ ] `ANTHROPIC_API_KEY` set in Azure App Service settings
- [ ] `config.yaml` filled in with real name, description, author
- [ ] Error states handled in the UI (network errors, 500s)
- [ ] Folder starts without `_` so the build pipeline picks it up
