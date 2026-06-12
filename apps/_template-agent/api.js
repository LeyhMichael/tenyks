/**
 * Template Agent — api.js
 *
 * Provides a single POST /my-tool/api/chat endpoint that:
 *   1. Reads the user message from the request body
 *   2. Maintains per-user conversation history (in-memory)
 *   3. Calls Claude and streams the response back as SSE
 *
 * Customise:
 *   - SYSTEM_PROMPT  →  give the agent its persona and instructions
 *   - model          →  swap to claude-sonnet-4-5 for harder tasks
 *   - tools          →  add Anthropic tool-use blocks for external actions
 *   - history store  →  swap the Map for a PostgreSQL table (see AGENT-GUIDE.md)
 */

const { claude }     = require('../../lib/llm');
const { streamText } = require('../../lib/stream');

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a helpful assistant on the BCG TDA Vantage Platform.
Answer concisely and professionally.`;

// ── In-memory conversation history (keyed by user identity) ──────────────────
// Each entry is an array of Anthropic message objects: { role, content }
// Swap this Map for a DB table when you need persistence across server restarts.
const histories = new Map();

const MAX_HISTORY_TURNS = 20; // keep last 20 turns to limit token usage

function getHistory(userId) {
  if (!histories.has(userId)) histories.set(userId, []);
  return histories.get(userId);
}

function trimHistory(history) {
  // Each "turn" is 2 messages (user + assistant). Keep the last N turns.
  const maxMessages = MAX_HISTORY_TURNS * 2;
  if (history.length > maxMessages) history.splice(0, history.length - maxMessages);
}

// ── Get the current user from Azure Easy Auth headers ─────────────────────────
// When Easy Auth is enabled, X-MS-CLIENT-PRINCIPAL-NAME contains the user's email.
// Falls back to 'anonymous' when running locally without auth.
function getUserId(req) {
  return req.headers['x-ms-client-principal-name'] || 'anonymous';
}

// ── Register endpoints ────────────────────────────────────────────────────────
module.exports = function ({ register, readJson, sendJson, sendError }) {

  // POST /my-tool/api/chat
  // Body: { message: string }
  // Response: SSE stream of { text: string } chunks, ending with [DONE]
  register('POST', 'chat', async (req, res) => {
    const { message } = await readJson(req);
    if (!message?.trim()) return sendError(res, 400, 'message is required');

    const userId  = getUserId(req);
    const history = getHistory(userId);

    // Append user turn
    history.push({ role: 'user', content: message });
    trimHistory(history);

    // Stream Claude's reply
    const stream = claude.messages.stream({
      model:      'claude-haiku-4-5-20251001',  // fast + cheap; upgrade to claude-sonnet-4-5 for complex tasks
      max_tokens: 1024,
      system:     SYSTEM_PROMPT,
      messages:   history,
    });

    // Collect the full reply so we can save it to history
    let assistantReply = '';
    stream.on('text', (text) => { assistantReply += text; });
    stream.on('finalMessage', () => {
      history.push({ role: 'assistant', content: assistantReply });
      trimHistory(history);
    });

    await streamText(res, stream);
  });

  // DELETE /my-tool/api/chat  — clear conversation history for the current user
  register('DELETE', 'chat', async (req, res) => {
    const userId = getUserId(req);
    histories.delete(userId);
    sendJson(res, { cleared: true });
  });

};
