// A stand-in for the cluster's OpenAI-compatible model gateway, just enough of
// chat/completions (which Goose's `openai` provider speaks) for one task-mode
// run. Every request is logged as one JSON line, so the test can assert on what
// Goose actually sent: the model, the bearer key, and the prompt.
//
// The known model gets a one-line answer, streamed or not as asked. Any other
// model gets the 400 a LiteLLM gateway returns for a model it does not route —
// the case Goose reports as text and exits 0 on, which the task launcher has to
// catch itself.
import http from 'node:http';

const MODEL = process.env.MOCK_MODEL ?? 'goose-test-model';
const port = Number(process.env.PORT ?? 18080);
const ANSWER = 'TASK-DONE';

http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let json = {};
    try { json = JSON.parse(body); } catch { /* not JSON */ }
    console.log(JSON.stringify({ method: req.method, url: req.url, model: json.model ?? null, auth: req.headers.authorization ?? null, body }));

    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model' }] }));
    }
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: `no route for ${req.method} ${req.url}` } }));
    }
    if (json.model !== MODEL) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: `Invalid model name passed in model=${json.model}`, type: 'invalid_request_error', code: '400' } }));
    }

    const base = { id: 'chatcmpl-1', created: 1, model: MODEL };
    const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
    if (!json.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        ...base, object: 'chat.completion', usage,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: ANSWER } }],
      }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (choice, extra = {}) => res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [choice], ...extra })}\n\n`);
    chunk({ index: 0, delta: { role: 'assistant', content: ANSWER }, finish_reason: null });
    chunk({ index: 0, delta: {}, finish_reason: 'stop' }, { usage });
    res.end('data: [DONE]\n\n');
  });
}).listen(port, () => console.error(`mock gateway on :${port}`));
