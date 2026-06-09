module.exports = function ({ register, readJson, sendJson, sendError }) {

  // GET /testing/api/ping
  // No external deps — verifies routing is wired up correctly
  register('GET', 'ping', async (_req, res) => {
    sendJson(res, { ok: true, time: new Date().toISOString() });
  });

  // POST /testing/api/echo
  // Returns whatever JSON body was sent — verifies readJson/sendJson
  register('POST', 'echo', async (req, res) => {
    const body = await readJson(req);
    sendJson(res, { echo: body });
  });

  // GET /testing/api/time
  // Calls timeapi.io — verifies the server can make outbound HTTP requests
  register('GET', 'time', async (_req, res) => {
    let response;
    try {
      response = await fetch('https://timeapi.io/api/time/current/zone?timeZone=UTC');
    } catch (err) {
      return sendError(res, 502, `fetch error: ${err.message}${err.cause ? ' — ' + err.cause.message : ''}`);
    }
    const data = await response.json();
    sendJson(res, { datetime: data.dateTime, utc_offset: data.timeZone, unixtime: data.unixTime });
  });

  // POST /testing/api/ask
  // Calls Claude — verifies Anthropic SDK and ANTHROPIC_API_KEY env var
  register('POST', 'ask', async (req, res) => {
    if (!process.env.ANTHROPIC_API_KEY) {
      return sendError(res, 500, 'ANTHROPIC_API_KEY is not set');
    }

    const { prompt } = await readJson(req);
    if (!prompt) return sendError(res, 400, 'Missing field: prompt');

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic();
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
    });

    sendJson(res, { reply: message.content[0].text });
  });

};
