import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 3001;
const DATA_DIR = path.join(__dirname, '..', 'data');

app.use(cors());
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

// Joint leads: { "YYYY-MM": { "leadId": { secondManagerId: string, note: string } } }
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
    res.status(404).send('App not built. Run: cd frontend && npm run build && cp -r dist/* ../backend/public/');
  }
});

app.listen(PORT, () => {
  console.log(`ORK Server running on port ${PORT}`);
});
