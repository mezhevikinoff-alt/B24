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

// GET /api/me — user info injected by Vibecode gateway
app.get('/api/me', (req, res) => {
  res.json({
    userId: req.headers['x-vibe-user-id'] || null,
    userName: req.headers['x-vibe-user-name'] || null,
    portalId: req.headers['x-vibe-portal-id'] || null,
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

  if (!authorization || !portalId) {
    // Dev mode: return empty result so UI doesn't crash
    res.json({ result: [], next: undefined });
    return;
  }

  try {
    const url = `https://${portalId}/rest/${method}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...( params || {}), auth: authorization }),
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
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
