// Tiny stand-in for a real tool (e.g. a payments API) used by proxy mode in Compose.
// It is only reachable on the internal data network, so the guardrail proxy is the only way in.
import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 9000);
const executions = [];

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return JSON.parse(body);
}

createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return sendJson(res, 200, { status: 'ok' });

  // Lets tests assert whether a call actually reached the tool.
  if (req.method === 'GET' && req.url === '/executions') {
    return sendJson(res, 200, { count: executions.length, executions: executions.slice(-20) });
  }

  const match = req.method === 'POST' && req.url?.match(/^\/tools\/([a-zA-Z0-9_.:-]+)$/);
  if (!match) return sendJson(res, 404, { error: 'NOT_FOUND' });

  try {
    const call = await readJson(req);
    const execution = {
      tool: match[1],
      arguments: call.arguments,
      decisionId: req.headers['x-guardrail-decision-id'],
      outcome: req.headers['x-guardrail-outcome'],
    };
    executions.push(execution);
    return sendJson(res, 200, { executed: true, ...execution });
  } catch {
    return sendJson(res, 400, { error: 'INVALID_JSON' });
  }
}).listen(port, '0.0.0.0');
