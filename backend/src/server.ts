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

const VIBE_APP_KEY = process.env.VIBE_APP_KEY || '';

// GET /api/me — user info injected by Vibecode gateway
app.get('/api/me', (req, res) => {
  const encodedName = req.headers['x-vibe-user-name-encoded'] as string | undefined;
  const role = req.headers['x-vibe-user-role'] as string | undefined;
  res.json({
    userId: req.headers['x-vibe-user-id'] || null,
    userName: encodedName ? decodeURIComponent(encodedName) : null,
    portalId: req.headers['x-vibe-portal-id'] || null,
    isAdmin: role === 'ADMIN',
  });
});

// GET /api/debug — show incoming Vibecode headers (names only, safe for logs)
app.get('/api/debug', (req, res) => {
  const vibeHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.startsWith('x-vibe-')) {
      vibeHeaders[k] = k === 'x-vibe-authorization' ? '[REDACTED]' : String(v);
    }
  }
  res.json({ headers: vibeHeaders, env: { VIBE_APP_KEY: VIBE_APP_KEY ? '[SET]' : '[MISSING]' } });
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

  if (!authorization || !portalId) {
    console.warn(`[bx] ${method}: no auth headers (authorization=${!!authorization}, portalId=${portalId})`);
    res.json({ result: [], next: undefined });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const url = `https://${portalId}/rest/${method}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...(params || {}), auth: authorization }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const data = await response.json();
    if (data.error) console.error(`[bx] ${method} → error: ${data.error} ${data.error_description || ''}`);
    else console.log(`[bx] ${method} → HTTP ${response.status}, result count: ${Array.isArray(data.result) ? data.result.length : '?'}`);
    res.json(data);
  } catch (err) {
    clearTimeout(timer);
    console.error(`[bx] ${method} → exception:`, err);
    res.status(500).json({ error: String(err) });
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

app.listen(PORT, () => console.log(`ORK Server running on port ${PORT}`));
