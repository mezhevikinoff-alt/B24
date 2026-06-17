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

const VIBE_APP_KEY = process.env.VIBE_APP_KEY || '';
const BX24_DOMAIN = process.env.BX24_DOMAIN || 'credburo.bitrix24.ru';
const VIBE_API = 'https://vibecode.bitrix24.tech/v1';
// Cookie name used to store Bitrix24 auth token received from handler POST
const AUTH_COOKIE = 'bx_auth';

console.log(`[${ts()}] ORK Server starting on port ${PORT}`);
console.log(`[${ts()}] VIBE_APP_KEY: ${VIBE_APP_KEY ? '[SET, length=' + VIBE_APP_KEY.length + ']' : '[MISSING]'}`);
console.log(`[${ts()}] BX24_DOMAIN: ${BX24_DOMAIN}`);
console.log(`[${ts()}] VIBE_API: ${VIBE_API}`);
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

// POST /api/bx — proxy to Vibecode entity API using x-vibe-authorization
// Maps BX24 method names to Vibecode REST endpoints and normalises responses.
app.post('/api/bx', async (req, res) => {
  const vibeToken = req.headers['x-vibe-authorization'] as string | undefined;
  const { method, params } = req.body as { method: string; params?: Record<string, unknown> };

  if (!method) {
    res.status(400).json({ error: 'Missing method' });
    return;
  }

  if (!vibeToken) {
    console.warn(`[${ts()}] [bx] ${method}: NO x-vibe-authorization — returning empty result`);
    res.json({ result: [], next: undefined });
    return;
  }

  const t0 = Date.now();

  // Build Vibecode API request parameters based on BX24 method name
  let vibeUrl: string;
  let vibeMethod: string;
  let vibeBody: unknown;

  switch (method) {
    case 'user.get': {
      vibeUrl = `${VIBE_API}/users`;
      vibeMethod = 'GET';
      const qp = new URLSearchParams();
      const filter = ((params?.FILTER ?? params?.filter) as Record<string, unknown>) || {};
      if (filter.ACTIVE !== undefined) qp.set('filter[ACTIVE]', filter.ACTIVE ? 'Y' : 'N');
      if (params?.ID) qp.set('filter[ID]', String(params.ID));
      const select = ((params?.SELECT ?? params?.select) as string[]) || [];
      if (select.length) qp.set('select', select.join(','));
      qp.set('limit', '200');
      const startU = params?.start as number | undefined;
      if (startU) qp.set('offset', String(startU));
      vibeUrl += '?' + qp.toString();
      break;
    }
    case 'crm.lead.list': {
      vibeUrl = `${VIBE_API}/leads/search`;
      vibeMethod = 'POST';
      const filter = (params?.FILTER ?? params?.filter) || {};
      const select = (params?.SELECT ?? params?.select) || [];
      const startL = params?.start as number | undefined;
      vibeBody = { filter, select, limit: 50, ...(startL ? { offset: startL } : {}) };
      break;
    }
    case 'crm.status.list': {
      vibeUrl = `${VIBE_API}/statuses`;
      vibeMethod = 'GET';
      const filterS = ((params?.FILTER ?? params?.filter) as Record<string, string>) || {};
      const qpS = new URLSearchParams();
      if (filterS.ENTITY_ID) qpS.set('filter[ENTITY_ID]', filterS.ENTITY_ID);
      const qpSStr = qpS.toString();
      if (qpSStr) vibeUrl += '?' + qpSStr;
      break;
    }
    case 'crm.category.list': {
      vibeUrl = `${VIBE_API}/deal-categories`;
      vibeMethod = 'GET';
      break;
    }
    case 'crm.deal.list': {
      vibeUrl = `${VIBE_API}/deals/search`;
      vibeMethod = 'POST';
      const filterD = (params?.FILTER ?? params?.filter) || {};
      const selectD = (params?.SELECT ?? params?.select) || [];
      const startD = params?.start as number | undefined;
      vibeBody = { filter: filterD, select: selectD, limit: 50, ...(startD ? { offset: startD } : {}) };
      break;
    }
    default: {
      // Methods without a Vibecode wrapper (e.g. timeman.timecontrol.report.get)
      console.warn(`[${ts()}] [bx] ${method}: no Vibecode wrapper — returning empty result`);
      res.json({ result: [], next: undefined });
      return;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    console.error(`[${ts()}] [bx] ${method}: TIMEOUT after 20s`);
    controller.abort();
  }, 20000);

  console.log(`[${ts()}] [bx] → ${method} vibeUrl=${vibeUrl} vibeMethod=${vibeMethod}`);

  try {
    const fetchOpts: RequestInit = {
      method: vibeMethod || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${vibeToken}`,
      },
      signal: controller.signal,
    };
    if (vibeBody) fetchOpts.body = JSON.stringify(vibeBody);

    const response = await fetch(vibeUrl, fetchOpts);
    clearTimeout(timer);

    const text = await response.text();
    const elapsed = Date.now() - t0;

    let vibeData: { success: boolean; data: unknown; pagination?: { next?: number | string } };
    try {
      vibeData = JSON.parse(text) as typeof vibeData;
    } catch {
      console.error(`[${ts()}] [bx] ← ${method}: NON-JSON (HTTP ${response.status}) (${elapsed}ms): ${text.slice(0, 300)}`);
      res.status(502).json({ error: `Vibecode API returned non-JSON (HTTP ${response.status})`, raw: text.slice(0, 500) });
      return;
    }

    if (!vibeData.success) {
      console.error(`[${ts()}] [bx] ← ${method}: VIBE_ERROR (${elapsed}ms): ${text.slice(0, 300)}`);
      res.json({ error: 'vibecode_error', raw: vibeData });
      return;
    }

    // Normalise Vibecode response { success, data, pagination } → BX24 format { result, next }
    const items = Array.isArray(vibeData.data)
      ? vibeData.data
      : vibeData.data != null
        ? [vibeData.data]
        : [];
    const nextOffset = vibeData.pagination?.next ?? undefined;

    console.log(`[${ts()}] [bx] ← ${method}: OK ${items.length} items, next=${nextOffset ?? 'none'} (${elapsed}ms)`);
    res.json({ result: items, next: nextOffset });
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

// POST /api/bx24-debug — frontend reports BX24 SDK init status for server-side logging
app.post('/api/bx24-debug', (req, res) => {
  const body = req.body as Record<string, unknown>;
  console.log(`[${ts()}] BX24_DEBUG: ${JSON.stringify(body)}`);
  res.json({ ok: true });
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
// Also captures auth token if Vibecode/Bitrix24 passes it as URL param
app.get('*', (req, res) => {
  // Log all query params on root to see what Vibecode passes
  const queryKeys = Object.keys(req.query);
  if (queryKeys.length > 0) {
    const safeQuery: Record<string, string> = {};
    for (const k of queryKeys) {
      const v = String(req.query[k]);
      // Redact potential token values but show length
      const isToken = k.toLowerCase().includes('auth') || k.toLowerCase().includes('token');
      safeQuery[k] = isToken ? `[len=${v.length}]` : v;
    }
    console.log(`[${ts()}] GET ${req.path} — query params: ${JSON.stringify(safeQuery)}`);
  }

  // Capture auth token from URL params (various Bitrix24/Vibecode formats)
  const authFromParams =
    req.query.AUTH_ID ?? req.query.auth_id ??
    req.query.access_token ?? req.query._auth ??
    req.query.auth;

  if (authFromParams) {
    const authStr = String(authFromParams).trim();
    if (authStr.length > 10) {
      console.log(`[${ts()}] GET ${req.path} — AUTH in URL param, setting cookie (len=${authStr.length})`);
      res.setHeader('Set-Cookie', `${AUTH_COOKIE}=${authStr}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=3600`);
    }
  }

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
