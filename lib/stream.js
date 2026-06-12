/**
 * SSE streaming helper — pipes a Claude streaming response to the browser.
 *
 * Import in any app's api.js:
 *
 *   const { streamText } = require('../../lib/stream');
 *
 * Usage:
 *
 *   register('POST', 'chat', async (req, res) => {
 *     const { messages } = await readJson(req);
 *     const stream = claude.messages.stream({
 *       model:      'claude-haiku-4-5-20251001',
 *       max_tokens: 1024,
 *       messages,
 *     });
 *     await streamText(res, stream);
 *   });
 *
 * Browser-side consumption (fetch + ReadableStream):
 *
 *   const res  = await fetch('api/chat', { method: 'POST', body: JSON.stringify({ messages }) });
 *   const reader = res.body.getReader();
 *   const decoder = new TextDecoder();
 *   while (true) {
 *     const { done, value } = await reader.read();
 *     if (done) break;
 *     for (const line of decoder.decode(value).split('\n')) {
 *       if (!line.startsWith('data: ')) continue;
 *       const payload = line.slice(6);
 *       if (payload === '[DONE]') break;
 *       const { text } = JSON.parse(payload);
 *       // append `text` to your UI element
 *     }
 *   }
 */

/**
 * Streams a Claude response as Server-Sent Events.
 * Sends `data: {"text":"..."}` events, then `data: [DONE]`.
 *
 * @param {import('http').ServerResponse} res
 * @param {import('@anthropic-ai/sdk').MessageStream} stream
 */
async function streamText(res, stream) {
  res.writeHead(200, {
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',   // disable nginx buffering on Azure
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
    }
  }

  res.write('data: [DONE]\n\n');
  res.end();
}

module.exports = { streamText };
