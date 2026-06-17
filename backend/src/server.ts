import express, { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, '..', 'data');

// Parse JSON and URL-encoded bodies (Bitrix24 handler sends urlencoded form data)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  console.error(`[init] Failed to create DATA_DIR: ${e}`);
}

function dataFile(name: string) {
  return path.join(DATA_DIR, name + '.json');
}

function readJson(file: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    console.error(`[readJson] ${file}: ${e}`);
    return {};
  }
}

function writeJson(file: string, data: unknown) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`[writeJson] ${file}: ${e}`);
    throw e;
  }
}

function ts() {
  return new Date().toISOString();
}

// Parse cookies from request header manually (no extra dependency)
function getCookies(req: Request): Record<string, string> {
  const cookies: Record<string, string> = {};
  (req.headers.cookie || '').split(';').forEach((c) => {
    const idx = c.indexOf('=');
    if (idx > 0) {
      const k = c.slice(0, idx).trim();
      const v = c.slice(idx + 1).trim();
      cookies[k] = v;
    }
  });
  return cookies;
}

// Strip "Bearer " prefix if present — Bitrix24 REST API expects raw token
function extractToken(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (raw.toLowerCase().startsWith('bearer ')) return raw.slice(7).trim();
  return raw.trim() || undefined;
}

const VIBE_APP_KEY = process.env.VIBE_APP_KEY || '';
const BX24_DOMAIN = process.env.BX24_DOMAIN || 'credburo.bitrix24.ru';
// Cookie name used to store Bitrix24 auth token received from handler POST
const AUTH_COOKIE = 'bx_auth';

console.log(`[${ts()}] ORK Server starting on port ${PORT}`);
console.log(`[${ts()}] VIBE_APP_KEY: ${VIBE_APP_KEY ? '[SET, length=' + VIBE_APP_KEY.length + ']' : '[MISSING]'}`);
console.log(`[${ts()}] BX24_DOMAIN: ${BX24_DOMAIN}`);
console.log(`[${ts()}] NODE_ENV: ${process.env.NODE_ENV || 'development'}`);

// ─── Bitrix24 handler POST ────────────────────────────────────────────────────
// When Bitrix24 opens our app as a left-menu placement, it POSTs auth to the
// handler URL. We capture AUTH_ID and store it in an HttpOnly cookie so the
// browser sends it on every subsequent same-origin API request.
app.post('/', (req, res) => {
  const body = req.body as Record<string, string>;
  // Bitrix24 sends AUTH_ID or auth[access_token] in form data
  const authId = body.AUTH_ID || body.auth_id || '';
  const domain = body.DOMAIN || BX24_DOMAIN;
  const placement = body.PLACEMENT || 'unknown';

  console.log(`[${ts()}] POST / — Bitrix24 handler. PLACEMENT=${placement}, domain=${domain}, AUTH_ID=${authId ? '[present, len=' + authId.length + ']' : '[missing]'}, bodyKeys=${Object.keys(body).join(',')}`);

  if (authId) {
    // SameSite=None + Secure required for cross-site iframe cookies (Bitrix24 embeds us)
    res.setHeader('Set-Cookie', `${AUTH_COOKIE}=${authId}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=3600`);
  }

  const indexPath = path.join(__dirname, '..', 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(200).send('App not built yet.');
  }
});

// GET /api/healthcheck
app.get('/api/healthcheck', (req, res) => {
  const cookies = getCookies(req);
  res.json({
    ok: true,
    ts: ts(),
    env: {
      VIBE_APP_KEY: VIBE_APP_KEY ? '[SET, length=' + VIBE_APP_KEY.length + ']' : '[MISSING]',
      BX24_DOMAIN,
      NODE_ENV: process.env.NODE_ENV || 'development',
      PORT: String(PORT),
    },
    vibeHeaders: {
      hasAuthorization: !!req.headers['x-vibe-authorization'],
      authPrefix: req.headers['x-vibe-authorization']
        ? String(req.headers['x-vibe-authorization']).slice(0, 12) + '...'
        : null,
      hasPortalId: !!req.headers['x-vibe-portal-id'],
      hasUserId: !!req.headers['x-vibe-user-id'],
      hasRole: !!req.headers['x-vibe-user-role'],
    },
    cookieAuth: cookies[AUTH_COOKIE] ? '[present, len=' + cookies[AUTH_COOKIE].length + ']' : '[missing]',
  });
});

// GET /api/me — user info injected by Vibecode gateway
app.get('/api/me', (req, res) => {
  const encodedName = req.headers['x-vibe-user-name-encoded'] as string | undefined;
  const role = req.headers['x-vibe-user-role'] as string | undefined;
  const userId = req.headers['x-vibe-user-id'] as string | undefined;
  const portalId = req.headers['x-vibe-portal-id'] as string | undefined;
  const cookies = getCookies(req);
  const hasCookieAuth = !!cookies[AUTH_COOKIE];

  console.log(`[${ts()}] GET /api/me — userId=${userId || 'null'}, portalId=${portalId || 'null'}, role=${role || 'null'}, hasVibeAuth=${!!req.headers['x-vibe-authorization']}, hasCookieAuth=${hasCookieAuth}`);

  res.json({
    userId: userId || null,
    userName: encodedName ? decodeURIComponent(encodedName) : null,
    portalId: portalId || null,
    isAdmin: role === 'ADMIN',
  });
});

// GET /api/debug — show ALL incoming headers + cookie status
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
  const cookies = getCookies(req);
  const cookieStatus = { [AUTH_COOKIE]: cookies[AUTH_COOKIE] ? '[present, len=' + cookies[AUTH_COOKIE].length + ']' : '[missing]' };

  console.log(`[${ts()}] GET /api/debug — ALL headers: ${JSON.stringify(allHeaders)}, cookies: ${JSON.stringify(cookieStatus)}`);
  res.json({
    ts: ts(),
    headers: vibeHeaders,
    allHeaders,
    cookies: cookieStatus,
    env: {
      VIBE_APP_KEY: VIBE_APP_KEY ? '[SET]' : '[MISSING]',
      BX24_DOMAIN,
    },
  });
});

// POST /api/bx — proxy Bitrix24 REST API
// Auth priority: 1) x-vibe-authorization header (Vibecode injection)
//                2) bx_auth cookie (Bitrix24 handler POST flow)
app.post('/api/bx', async (req, res) => {
  const rawVibeAuth = req.headers['x-vibe-authorization'] as string | undefined;
  const vibeAuth = extractToken(rawVibeAuth);

  const cookies = getCookies(req);
  const cookieAuth = cookies[AUTH_COOKIE] || undefined;

  const authorization = vibeAuth || cookieAuth;

  const portalId = req.headers['x-vibe-portal-id'] as string | undefined;
  const { method, params } = req.body as { method: string; params?: Record<string, unknown> };

  if (!method) {
    res.status(400).json({ error: 'Missing method' });
    return;
  }

  if (!authorization) {
    console.warn(`[${ts()}] [bx] ${method}: NO AUTH — vibeHeader=${!!rawVibeAuth}, cookie=${!!cookieAuth}, portalId=${portalId || 'null'} — returning empty result`);
    res.json({ result: [], next: undefined });
    return;
  }

  const authSource = vibeAuth ? 'vibe-header' : 'cookie';
  const controller = new AbortController();
  const timer = setTimeout(() => {
    console.error(`[${ts()}] [bx] ${method}: TIMEOUT after 20s`);
    controller.abort();
  }, 20000);

  const t0 = Date.now();
  const url = `https://${BX24_DOMAIN}/rest/${method}`;
  console.log(`[${ts()}] [bx] → ${method} url=${url} authSource=${authSource} tokenLen=${authorization.length}`);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...(params || {}), auth: authorization }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const text = await response.text();
    const elapsed = Date.now() - t0;

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      console.error(`[${ts()}] [bx] ← ${method}: NON-JSON (HTTP ${response.status}) (${elapsed}ms): ${text.slice(0, 300)}`);
      res.status(502).json({ error: `Bitrix24 returned non-JSON (HTTP ${response.status})`, raw: text.slice(0, 500) });
      return;
    }

    if (data.error) {
      console.error(`[${ts()}] [bx] ← ${method}: BX_ERROR ${data.error} — ${data.error_description ?? ''} (${elapsed}ms)`);
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
    const msg = isAbort ? 'Request timed out after 20s' : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error(`[${ts()}] [bx] ← ${method}: ${isAbort ? 'TIMEOUT' : 'EXCEPTION'} — ${msg} (${elapsed}ms)`);
    if (stack) console.error(stack);
    res.status(500).json({ error: msg });
  }
});

// Hour corrections: { "YYYY-MM": { "userId": { "YYYY-MM-DD": hours } } }
app.get('/api/corrections/:year/:month', (req, res) => {
  const key = `${req.params.year}-${req.params.month.padStart(2, '0')}`;
  const data = readJson(dataFile('corrections'));
  res.json(data[key] || {});
});

app.put('/api/corrections/:year/:month', (req, res) => {
  try {
    const key = `${req.params.year}-${req.params.month.padStart(2, '0')}`;
    const data = readJson(dataFile('corrections'));
    data[key] = req.body;
    writeJson(dataFile('corrections'), data);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Joint leads
app.get('/api/joints/:year/:month', (req, res) => {
  const key = `${req.params.year}-${req.params.month.padStart(2, '0')}`;
  const data = readJson(dataFile('joints'));
  res.json(data[key] || {});
});

app.post('/api/joints/:year/:month', (req, res) => {
  try {
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
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Catch-all: serve React app for all GET requests
app.get('*', (_req, res) => {
  const indexPath = path.join(__dirname, '..', 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(200).send('App not built yet.');
  }
});

// Global Express error handler
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const msg = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  console.error(`[${ts()}] UNHANDLED ERROR ${req.method} ${req.path}: ${msg}`);
  if (stack) console.error(stack);
  if (!res.headersSent) {
    res.status(500).json({ error: msg });
  }
});

process.on('unhandledRejection', (reason) => {
  console.error(`[${ts()}] UNHANDLED REJECTION: ${reason}`);
});

process.on('uncaughtException', (err) => {
  console.error(`[${ts()}] UNCAUGHT EXCEPTION: ${err.message}`);
  console.error(err.stack);
});

app.listen(PORT, () => console.log(`[${ts()}] ORK Server ready on port ${PORT}`));
