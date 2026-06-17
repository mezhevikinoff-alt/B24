import express, { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, '..', 'data');

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
const AUTH_COOKIE = 'bx_auth';

console.log(`[${ts()}] ORK Server starting on port ${PORT}`);
console.log(`[${ts()}] VIBE_APP_KEY: ${VIBE_APP_KEY ? '[SET, length=' + VIBE_APP_KEY.length + ']' : '[MISSING]'}`);
console.log(`[${ts()}] BX24_DOMAIN: ${BX24_DOMAIN}`);

// ─── Entity field mappers: Vibecode camelCase → BX24 UPPER_CASE ─────────────

function mapUser(v: Record<string, unknown>): Record<string, unknown> {
  const deptId = v.departmentId;
  return {
    ID: String(v.id ?? ''),
    NAME: v.name ?? '',
    LAST_NAME: v.lastName ?? '',
    SECOND_NAME: v.secondName ?? '',
    ACTIVE: v.active === true ? 'Y' : 'N',
    UF_DEPARTMENT: Array.isArray(deptId) ? deptId : deptId != null ? [deptId] : [],
    IS_ADMIN: v.isAdmin === true,
    PERSONAL_PHOTO: v.personalPhoto ?? '',
    EMAIL: v.email ?? '',
  };
}

function mapLead(v: Record<string, unknown>): Record<string, unknown> {
  // stageSemanticId 'S' means success/converted; isConvert non-null also indicates conversion
  const isConverted = v.stageSemanticId === 'S' || (v.isConvert != null && v.isConvert !== false);
  return {
    ID: String(v.id ?? ''),
    TITLE: v.title ?? '',
    NAME: v.name ?? '',
    LAST_NAME: v.lastName ?? '',
    SECOND_NAME: v.secondName ?? '',
    DATE_CREATE: v.createdTime ?? v.createdAt ?? '',
    DATE_CONVERT: isConverted ? (v.dateClosed ?? v.movedTime ?? null) : null,
    STATUS_ID: String(v.stageId ?? v.statusId ?? ''),
    ASSIGNED_BY_ID: String(v.assignedById ?? ''),
    CATEGORY_ID: String(v.categoryId ?? '0'),
    OPPORTUNITY: String(v.opportunity ?? '0'),
    SOURCE_ID: String(v.sourceId ?? ''),
  };
}

function mapStatus(v: Record<string, unknown>): Record<string, unknown> {
  return {
    STATUS_ID: v.statusId ?? '',
    NAME: v.name ?? '',
    ENTITY_ID: v.entityId ?? '',
  };
}

function mapDeal(v: Record<string, unknown>): Record<string, unknown> {
  return {
    ID: String(v.id ?? ''),
    TITLE: v.title ?? '',
    LEAD_ID: v.leadId != null ? String(v.leadId) : null,
    CATEGORY_ID: String(v.categoryId ?? '0'),
    DATE_CREATE: v.createdAt ?? '',
    ASSIGNED_BY_ID: String(v.assignedById ?? ''),
  };
}

function mapCategory(v: Record<string, unknown>): Record<string, unknown> {
  return {
    ID: String(v.id ?? ''),
    NAME: v.name ?? '',
  };
}

// Map BX24-style filter keys to Vibecode camelCase field names
function mapLeadFilterKey(key: string): string {
  const opMatch = key.match(/^(>=|<=|>|<|%|!)/);
  const op = opMatch ? opMatch[0] : '';
  const field = key.slice(op.length);
  const fieldMap: Record<string, string> = {
    DATE_CREATE: 'createdAt',
    DATE_CONVERT: 'dateClosed',
    STATUS_ID: 'stageId',
    STAGE_ID: 'stageId',
    ASSIGNED_BY_ID: 'assignedById',
    SOURCE_ID: 'sourceId',
    ID: 'id',
    TITLE: 'title',
    NAME: 'name',
    LAST_NAME: 'lastName',
  };
  return op + (fieldMap[field] ?? field);
}

function mapDealFilterKey(key: string): string {
  const opMatch = key.match(/^(>=|<=|>|<|%|!)/);
  const op = opMatch ? opMatch[0] : '';
  const field = key.slice(op.length);
  const fieldMap: Record<string, string> = {
    LEAD_ID: 'leadId',
    CATEGORY_ID: 'categoryId',
    ASSIGNED_BY_ID: 'assignedById',
    DATE_CREATE: 'createdAt',
    ID: 'id',
  };
  return op + (fieldMap[field] ?? field);
}

function mapStatusFilterKey(key: string): string {
  const fieldMap: Record<string, string> = {
    ENTITY_ID: 'entityId',
    STATUS_ID: 'statusId',
  };
  return fieldMap[key] ?? key;
}

function remapFilterKeys(
  filter: Record<string, unknown>,
  mapper: (k: string) => string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(filter)) {
    out[mapper(k)] = v;
  }
  return out;
}

// ─── Simple in-memory cache (prevents 429 when multiple tabs load at once) ──

const _cache = new Map<string, { items: unknown[]; ts: number }>();
const CACHE_TTL = 60_000;

function cacheGet(key: string): unknown[] | null {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { _cache.delete(key); return null; }
  return entry.items;
}

function cacheSet(key: string, items: unknown[]) {
  _cache.set(key, { items, ts: Date.now() });
}

// ─── Bitrix24 handler POST ────────────────────────────────────────────────────

app.post('/', (req, res) => {
  const body = req.body as Record<string, string>;
  const authId = body.AUTH_ID || body.auth_id || '';
  const domain = body.DOMAIN || BX24_DOMAIN;
  const placement = body.PLACEMENT || 'unknown';

  console.log(`[${ts()}] POST / — PLACEMENT=${placement}, domain=${domain}, AUTH_ID=${authId ? '[present, len=' + authId.length + ']' : '[missing]'}`);

  if (authId) {
    res.setHeader('Set-Cookie', `${AUTH_COOKIE}=${authId}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=3600`);
  }

  const indexPath = path.join(__dirname, '..', 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(200).send('App not built yet.');
  }
});

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
    },
    cookieAuth: cookies[AUTH_COOKIE] ? '[present]' : '[missing]',
  });
});

app.get('/api/me', (req, res) => {
  const encodedName = req.headers['x-vibe-user-name-encoded'] as string | undefined;
  const role = req.headers['x-vibe-user-role'] as string | undefined;
  const userId = req.headers['x-vibe-user-id'] as string | undefined;
  const portalId = req.headers['x-vibe-portal-id'] as string | undefined;

  console.log(`[${ts()}] GET /api/me — userId=${userId || 'null'}, role=${role || 'null'}, hasVibeAuth=${!!req.headers['x-vibe-authorization']}`);

  res.json({
    userId: userId || null,
    userName: encodedName ? decodeURIComponent(encodedName) : null,
    portalId: portalId || null,
    isAdmin: role === 'ADMIN',
  });
});

app.get('/api/debug', (req, res) => {
  const vibeHeaders: Record<string, string> = {};
  const allHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const val = k === 'x-vibe-authorization' ? '[REDACTED, len=' + String(v).length + ']' : String(v);
    allHeaders[k] = val;
    if (k.startsWith('x-vibe-')) vibeHeaders[k] = val;
  }
  const cookies = getCookies(req);
  console.log(`[${ts()}] GET /api/debug`);
  res.json({ ts: ts(), headers: vibeHeaders, allHeaders, cookies: { [AUTH_COOKIE]: cookies[AUTH_COOKIE] ? '[present]' : '[missing]' } });
});

// POST /api/bx — proxy to Vibecode entity API, maps BX24 field names ↔ Vibecode camelCase
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
  const startOffset = (params?.start as number) || 0;

  let vibeUrl: string;
  let vibeMethod: string;
  let vibeBody: unknown;
  let mapper: ((v: Record<string, unknown>) => Record<string, unknown>) | null = null;

  switch (method) {
    case 'user.get': {
      vibeUrl = `${VIBE_API}/users`;
      vibeMethod = 'GET';
      const qp = new URLSearchParams();
      const filter = ((params?.FILTER ?? params?.filter) as Record<string, unknown>) || {};
      if (filter.ACTIVE !== undefined) qp.set('filter[ACTIVE]', filter.ACTIVE ? 'Y' : 'N');
      if (params?.ID) qp.set('filter[id]', String(params.ID));
      qp.set('limit', '200');
      if (startOffset) qp.set('offset', String(startOffset));
      vibeUrl += '?' + qp.toString();
      mapper = mapUser;

      // Cache user list to avoid 429 when multiple tabs load simultaneously
      const cacheKey = vibeToken.slice(-16) + ':' + vibeUrl;
      const cached = cacheGet(cacheKey);
      if (cached) {
        console.log(`[${ts()}] [bx] ← ${method}: CACHE HIT (${cached.length} items)`);
        res.json({ result: cached, next: undefined });
        return;
      }
      break;
    }
    case 'crm.lead.list': {
      vibeUrl = `${VIBE_API}/leads/search`;
      vibeMethod = 'POST';
      const rawFilter = (params?.FILTER ?? params?.filter) as Record<string, unknown> || {};
      const mappedFilter = remapFilterKeys(rawFilter, mapLeadFilterKey);
      vibeBody = {
        filter: mappedFilter,
        limit: 50,
        ...(startOffset ? { offset: startOffset } : {}),
      };
      mapper = mapLead;
      break;
    }
    case 'crm.status.list': {
      vibeUrl = `${VIBE_API}/statuses`;
      vibeMethod = 'GET';
      const rawFilterS = ((params?.FILTER ?? params?.filter) as Record<string, string>) || {};
      const mappedFilterS = remapFilterKeys(rawFilterS, mapStatusFilterKey);
      const qpS = new URLSearchParams();
      if (mappedFilterS.entityId) qpS.set('filter[entityId]', String(mappedFilterS.entityId));
      qpS.set('limit', '200');
      if (startOffset) qpS.set('offset', String(startOffset));
      const qpSStr = qpS.toString();
      vibeUrl += '?' + qpSStr;
      mapper = mapStatus;
      break;
    }
    case 'crm.category.list': {
      vibeUrl = `${VIBE_API}/deal-categories`;
      vibeMethod = 'GET';
      mapper = mapCategory;
      break;
    }
    case 'crm.deal.list': {
      vibeUrl = `${VIBE_API}/deals/search`;
      vibeMethod = 'POST';
      const rawFilterD = (params?.FILTER ?? params?.filter) as Record<string, unknown> || {};
      const mappedFilterD = remapFilterKeys(rawFilterD, mapDealFilterKey);
      vibeBody = {
        filter: mappedFilterD,
        limit: 50,
        ...(startOffset ? { offset: startOffset } : {}),
      };
      mapper = mapDeal;
      break;
    }
    default: {
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

  console.log(`[${ts()}] [bx] → ${method} ${vibeMethod} ${vibeUrl}`);

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

    let vibeData: { success: boolean; data: unknown; meta?: { total?: number; hasMore?: boolean }; pagination?: { next?: number } };
    try {
      vibeData = JSON.parse(text) as typeof vibeData;
    } catch {
      console.error(`[${ts()}] [bx] ← ${method}: NON-JSON (HTTP ${response.status}) (${elapsed}ms): ${text.slice(0, 300)}`);
      res.status(502).json({ error: `Vibecode API returned non-JSON (HTTP ${response.status})`, raw: text.slice(0, 300) });
      return;
    }

    if (!vibeData.success) {
      console.error(`[${ts()}] [bx] ← ${method}: VIBE_ERROR (${elapsed}ms): ${text.slice(0, 400)}`);
      res.json({ error: 'vibecode_error', raw: vibeData });
      return;
    }

    // Normalize response: Vibecode { success, data, meta } → BX24 { result, next }
    const rawItems = Array.isArray(vibeData.data)
      ? vibeData.data as Record<string, unknown>[]
      : vibeData.data != null ? [vibeData.data as Record<string, unknown>] : [];

    const items = mapper ? rawItems.map(mapper) : rawItems;

    // Pagination: use meta.hasMore + offset to compute next
    const hasMore = vibeData.meta?.hasMore ?? (vibeData.pagination?.next != null);
    const nextOffset = hasMore ? startOffset + items.length : undefined;

    // Cache user results to prevent 429 on re-requests
    if (method === 'user.get' && items.length > 0) {
      cacheSet(vibeToken.slice(-16) + ':' + vibeUrl, items);
    }

    console.log(`[${ts()}] [bx] ← ${method}: OK ${items.length} items, next=${nextOffset ?? 'none'} (${elapsed}ms)`);
    res.json({ result: items, next: nextOffset });
  } catch (err: unknown) {
    clearTimeout(timer);
    const elapsed = Date.now() - t0;
    const isAbort = err instanceof Error && err.name === 'AbortError';
    const msg = isAbort ? 'Request timed out after 20s' : String(err);
    console.error(`[${ts()}] [bx] ← ${method}: ${isAbort ? 'TIMEOUT' : 'EXCEPTION'} — ${msg} (${elapsed}ms)`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    res.status(500).json({ error: msg });
  }
});

app.post('/api/bx24-debug', (req, res) => {
  const body = req.body as Record<string, unknown>;
  console.log(`[${ts()}] BX24_DEBUG: ${JSON.stringify(body)}`);
  res.json({ ok: true });
});

// Hour corrections
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

// Catch-all: serve React app
app.get('*', (req, res) => {
  const queryKeys = Object.keys(req.query);
  if (queryKeys.length > 0) {
    const safeQuery: Record<string, string> = {};
    for (const k of queryKeys) {
      const v = String(req.query[k]);
      const isToken = k.toLowerCase().includes('auth') || k.toLowerCase().includes('token');
      safeQuery[k] = isToken ? `[len=${v.length}]` : v;
    }
    console.log(`[${ts()}] GET ${req.path} — query: ${JSON.stringify(safeQuery)}`);
  }

  const authFromParams =
    req.query.AUTH_ID ?? req.query.auth_id ??
    req.query.access_token ?? req.query._auth ?? req.query.auth;

  if (authFromParams) {
    const authStr = String(authFromParams).trim();
    if (authStr.length > 10) {
      console.log(`[${ts()}] GET ${req.path} — AUTH in URL param, setting cookie`);
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

app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[${ts()}] UNHANDLED ERROR ${req.method} ${req.path}: ${msg}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  if (!res.headersSent) res.status(500).json({ error: msg });
});

process.on('unhandledRejection', (reason) => {
  console.error(`[${ts()}] UNHANDLED REJECTION: ${reason}`);
});

process.on('uncaughtException', (err) => {
  console.error(`[${ts()}] UNCAUGHT EXCEPTION: ${(err as Error).message}`);
  console.error((err as Error).stack);
});

app.listen(PORT, () => console.log(`[${ts()}] ORK Server ready on port ${PORT}`));
