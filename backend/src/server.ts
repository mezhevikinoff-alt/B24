import express from 'express';
import fs from 'fs';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, '..', 'data');

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function dataFile(name: string) {
  return path.join(DATA_DIR, name + '.json');
}

function readJson(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function writeJson(file: string, data: unknown) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function ts() {
  return new Date().toISOString();
}

const VIBE_APP_KEY = process.env.VIBE_APP_KEY || '';
const BX24_DOMAIN = process.env.BX24_DOMAIN || 'credburo.bitrix24.ru';

console.log(`[${ts()}] ORK Server starting on port ${PORT}`);
console.log(`[${ts()}] VIBE_APP_KEY: ${VIBE_APP_KEY ? '[SET, length=' + VIBE_APP_KEY.length + ']' : '[MISSING]'}`);
console.log(`[${ts()}] BX24_DOMAIN: ${BX24_DOMAIN}`);
console.log(`[${ts()}] NODE_ENV: ${process.env.NODE_ENV || 'development'}`);

// GET /api/healthcheck
app.get('/api/healthcheck', (req, res) => {
  res.json({
    ok: true,
    ts: ts(),
    env: {
      VIBE_APP_KEY: VIBE_APP_KEY ? '[SET, length=' + VIBE_APP_KEY.length + ']' : '[MISSING]',
      NODE_ENV: process.env.NODE_ENV || 'development',
      PORT: String(PORT),
    },
    vibeHeaders: {
      hasAuthorization: !!req.headers['x-vibe-authorization'],
      hasPortalId: !!req.headers['x-vibe-portal-id'],
      hasUserId: !!req.headers['x-vibe-user-id'],
      hasRole: !!req.headers['x-vibe-user-role'],
    },
  });
});

// GET /api/me — user info injected by Vibecode gateway
app.get('/api/me', (req, res) => {
  const encodedName = req.headers['x-vibe-user-name-encoded'] as string | undefined;
  const role = req.headers['x-vibe-user-role'] as string | undefined;
  const userId = req.headers['x-vibe-user-id'] as string | undefined;
  const portalId = req.headers['x-vibe-portal-id'] as string | undefined;

  console.log(`[${ts()}] GET /api/me — userId=${userId || 'null'}, portalId=${portalId || 'null'}, role=${role || 'null'}, hasAuth=${!!req.headers['x-vibe-authorization']}`);

  res.json({
    userId: userId || null,
    userName: encodedName ? decodeURIComponent(encodedName) : null,
    portalId: portalId || null,
    isAdmin: role === 'ADMIN',
  });
});

// GET /api/debug — show ALL incoming headers (safe for logs)
app.get('/api/debug', (req, res) => {
  const vibeHeaders: Record<string, string> = {};
  const allHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const val = k === 'x-vibe-authorization' ? '[REDACTED, len=' + String(v).length + ']' : String(v);
    allHeaders[k] = val;
    if (k.startsWith('x-vibe-')) {
      vibeHeaders[k] = val;
    }
  }
  console.log(`[${ts()}] GET /api/debug — ALL headers: ${JSON.stringify(allHeaders)}`);
  res.json({
    ts: ts(),
    headers: vibeHeaders,
    allHeaders,
    env: { VIBE_APP_KEY: VIBE_APP_KEY ? '[SET]' : '[MISSING]' },
  });
});

// POST /api/bx — proxy Bitrix24 REST API via Vibecode auth headers
app.post('/api/bx', async (req, res) => {
  const authorization = req.headers['x-vibe-authorization'] as string | undefined;
  const portalId = req.headers['x-vibe-portal-id'] as string | undefined;
  const { method, params } = req.body as { method: string; params?: Record<string, unknown> };

  if (!method) {
    res.status(400).json({ error: 'Missing method' });
    return;
  }

  if (!authorization) {
    console.warn(`[${ts()}] [bx] ${method}: NO AUTH HEADERS (authorization=false, portalId=${portalId || 'null'}) — returning empty result`);
    res.json({ result: [], next: undefined });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    console.error(`[${ts()}] [bx] ${method}: TIMEOUT after 20s`);
    controller.abort();
  }, 20000);

  const t0 = Date.now();
  console.log(`[${ts()}] [bx] → ${method} (domain=${BX24_DOMAIN}, portalId=${portalId || 'null'})`);

  try {
    const url = `https://${BX24_DOMAIN}/rest/${method}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...(params || {}), auth: authorization }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const data = await response.json() as Record<string, unknown>;
    const elapsed = Date.now() - t0;

    if (data.error) {
      console.error(`[${ts()}] [bx] ← ${method}: ERROR ${data.error} — ${data.error_description ?? ''} (${elapsed}ms)`);
    } else {
      const result = data.result;
      const cnt = Array.isArray(result) ? result.length : (result != null ? 1 : 0);
      console.log(`[${ts()}] [bx] ← ${method}: OK ${cnt} items, next=${data.next ?? 'none'} (${elapsed}ms)`);
    }
    res.json(data);
  } catch (err: unknown) {
    clearTimeout(timer);
    const elapsed = Date.now() - t0;
    const isAbort = err instanceof Error && err.name === 'AbortError';
    console.error(`[${ts()}] [bx] ← ${method}: ${isAbort ? 'TIMEOUT' : 'EXCEPTION'} — ${String(err)} (${elapsed}ms)`);
    res.status(500).json({ error: isAbort ? 'Request timed out after 20s' : String(err) });
  }
});

// Hour corrections: { "YYYY-MM": { "userId": { "YYYY-MM-DD": hours } } }
app.get('/api/corrections/:year/:month', (req, res) => {
  const key = `${req.params.year}-${req.params.month.padStart(2, '0')}`;
  const data = readJson(dataFile('corrections'));
  res.json(data[key] || {});
});

app.put('/api/corrections/:year/:month', (req, res) => {
  const key = `${req.params.year}-${req.params.month.padStart(2, '0')}`;
  const data = readJson(dataFile('corrections'));
  data[key] = req.body;
  writeJson(dataFile('corrections'), data);
  res.json({ ok: true });
});

// Joint leads: { "YYYY-MM": { "leadId": { secondManagerId: string } } }
app.get('/api/joints/:year/:month', (req, res) => {
  const key = `${req.params.year}-${req.params.month.padStart(2, '0')}`;
  const data = readJson(dataFile('joints'));
  res.json(data[key] || {});
});

app.post('/api/joints/:year/:month', (req, res) => {
  const key = `${req.params.year}-${req.params.month.padStart(2, '0')}`;
  const data = readJson(dataFile('joints')) as Record<string, Record<string, unknown>>;
  if (!data[key]) data[key] = {};
  const { leadId, secondManagerId } = req.body as { leadId: string; secondManagerId: string | null };
  if (secondManagerId) {
    data[key][leadId] = { secondManagerId };
  } else {
    delete data[key][leadId];
  }
  writeJson(dataFile('joints'), data);
  res.json({ ok: true });
});

// Catch-all: serve React app
app.get('*', (_req, res) => {
  const indexPath = path.join(__dirname, '..', 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(200).send('App not built yet.');
  }
});

app.listen(PORT, () => console.log(`[${ts()}] ORK Server ready on port ${PORT}`));
