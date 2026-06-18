import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';

// ─── Конфигурация ─────────────────────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, '..', 'data');

const VIBE_APP_KEY = process.env.VIBE_APP_KEY || '';
const BX24_DOMAIN = process.env.BX24_DOMAIN || 'credburo.bitrix24.ru';
const VIBE_API = 'https://vibecode.bitrix24.tech/v1';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  console.error(`[init] Не удалось создать DATA_DIR: ${e}`);
}

// ─── Утилиты ──────────────────────────────────────────────────────────────────

function ts() { return new Date().toISOString(); }

function log(label: string, msg: string) {
  console.log(`[${ts()}] [${label}] ${msg}`);
}

function dataFile(name: string) { return path.join(DATA_DIR, name + '.json'); }

function readJson(file: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    log('readJson', `Ошибка чтения ${file}: ${e}`);
    return {};
  }
}

function writeJson(file: string, data: unknown) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    log('writeJson', `Ошибка записи ${file}: ${e}`);
    throw e;
  }
}

// ─── Вайбкод API ──────────────────────────────────────────────────────────────

interface VibeResponse {
  success: boolean;
  data?: unknown;
  meta?: { total?: number; hasMore?: boolean };
  error?: { code?: string; message?: string } | string;
}

let _rateLimitLock: Promise<void> = Promise.resolve();
const RATE_INTERVAL_MS = 200;

function scheduleVibecodeRequest<T>(fn: () => Promise<T>): Promise<T> {
  const scheduled = _rateLimitLock.then(async () => {
    await new Promise<void>(r => setTimeout(r, RATE_INTERVAL_MS));
    return fn();
  });
  _rateLimitLock = scheduled.then(() => {}, () => {});
  return scheduled;
}

async function callVibecode(
  url: string,
  opts: { method?: string; body?: unknown; bearerToken?: string },
  attempt = 1,
): Promise<VibeResponse> {
  return scheduleVibecodeRequest(() => callVibecodeDirect(url, opts, attempt));
}

async function callVibecodeDirect(
  url: string,
  opts: { method?: string; body?: unknown; bearerToken?: string },
  attempt: number,
): Promise<VibeResponse> {
  const method = opts.method || 'GET';
  log('vibecode', `→ [${attempt}/3] ${method} ${url}`);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Api-Key': VIBE_APP_KEY,
  };
  if (opts.bearerToken) {
    headers['Authorization'] = opts.bearerToken.startsWith('Bearer ')
      ? opts.bearerToken
      : `Bearer ${opts.bearerToken}`;
  }

  const t0 = Date.now();
  const response = await fetch(url, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(30000),
  });

  const text = await response.text();
  log('vibecode', `← HTTP ${response.status} за ${Date.now() - t0}мс: ${text.slice(0, 200)}`);

  if (response.status === 429) {
    if (attempt < 3) {
      await new Promise<void>(r => setTimeout(r, 1000));
      return callVibecodeDirect(url, opts, attempt + 1);
    }
    throw new Error('429 Too Many Requests');
  }

  let parsed: VibeResponse;
  try {
    parsed = JSON.parse(text) as VibeResponse;
  } catch {
    throw new Error(`Не-JSON ответ (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }

  if (!parsed.success) {
    const errMsg = typeof parsed.error === 'object'
      ? (parsed.error as { message?: string })?.message || JSON.stringify(parsed.error)
      : String(parsed.error || 'Unknown error');
    throw new Error(`Вайбкод API: ${errMsg}`);
  }

  return parsed;
}

// ─── Batch API ────────────────────────────────────────────────────────────────

interface BatchRequest { method: string; path: string; body?: unknown; }

interface BatchVibeResponse {
  success: boolean;
  responses?: Record<string, VibeResponse>;
  error?: unknown;
}

async function callVibeBatch(
  requests: Record<string, BatchRequest>,
  bearerToken?: string,
): Promise<Record<string, VibeResponse>> {
  log('batch', `→ ${Object.keys(requests).length} запросов`);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Api-Key': VIBE_APP_KEY,
  };
  if (bearerToken) {
    headers['Authorization'] = bearerToken.startsWith('Bearer ') ? bearerToken : `Bearer ${bearerToken}`;
  }

  const response = await fetch(`${VIBE_API}/batch`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ requests }),
    signal: AbortSignal.timeout(30000),
  });

  const text = await response.text();
  log('batch', `← HTTP ${response.status}: ${text.slice(0, 300)}`);

  if (response.status === 429) throw new Error('429 Too Many Requests (batch)');

  let parsed: BatchVibeResponse;
  try {
    parsed = JSON.parse(text) as BatchVibeResponse;
  } catch {
    throw new Error(`Не-JSON batch ответ (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }

  if (!parsed.success) throw new Error(`Batch API ошибка: ${JSON.stringify(parsed.error)}`);
  return parsed.responses || {};
}

// ─── Маппинг полей ────────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;

function mapUser(v: Rec): Rec {
  // Vibecode returns users in UPPER_CASE (undeclared schema); support both to be safe
  const deptId = v.UF_DEPARTMENT ?? v.departmentId;
  const active = v.ACTIVE ?? v.active;
  return {
    ID: String(v.ID ?? v.id ?? ''),
    NAME: String(v.NAME ?? v.name ?? ''),
    LAST_NAME: String(v.LAST_NAME ?? v.lastName ?? ''),
    SECOND_NAME: String(v.SECOND_NAME ?? v.secondName ?? ''),
    ACTIVE: typeof active === 'boolean' ? (active ? 'Y' : 'N') : (active ?? 'Y'),
    UF_DEPARTMENT: Array.isArray(deptId) ? deptId : deptId != null ? [deptId] : [],
    IS_ADMIN: v.IS_ADMIN === true || v.isAdmin === true,
    PERSONAL_PHOTO: v.PERSONAL_PHOTO ?? v.personalPhoto ?? '',
    EMAIL: v.EMAIL ?? v.email ?? '',
  };
}

function mapLead(v: Rec): Rec {
  const converted = v.stageSemanticId === 'S' || (v.isConvert != null && v.isConvert !== false);
  return {
    ID: String(v.id ?? ''),
    TITLE: v.title ?? '',
    NAME: v.name ?? '',
    LAST_NAME: v.lastName ?? '',
    SECOND_NAME: v.secondName ?? '',
    DATE_CREATE: v.createdTime ?? v.createdAt ?? '',
    DATE_CONVERT: converted ? (v.dateClosed ?? v.movedTime ?? null) : null,
    STATUS_ID: String(v.stageId ?? v.statusId ?? ''),
    ASSIGNED_BY_ID: String(v.assignedById ?? ''),
    CATEGORY_ID: String(v.categoryId ?? '0'),
    OPPORTUNITY: String(v.opportunity ?? '0'),
    SOURCE_ID: String(v.sourceId ?? ''),
  };
}

function mapDeal(v: Rec): Rec {
  return {
    ID: String(v.id ?? ''),
    TITLE: v.title ?? '',
    LEAD_ID: v.leadId != null ? String(v.leadId) : null,
    CATEGORY_ID: String(v.categoryId ?? '0'),
    DATE_CREATE: v.createdAt ?? '',
    ASSIGNED_BY_ID: String(v.assignedById ?? ''),
  };
}

function mapStatus(v: Rec): Rec {
  return {
    STATUS_ID: String(v.STATUS_ID ?? v.statusId ?? ''),
    NAME: String(v.NAME ?? v.name ?? ''),
    ENTITY_ID: String(v.ENTITY_ID ?? v.entityId ?? ''),
  };
}

function mapCategory(v: Rec): Rec {
  return {
    ID: String(v.ID ?? v.id ?? ''),
    NAME: String(v.NAME ?? v.name ?? ''),
  };
}

// Converts Bitrix24-style filter { '>=DATE_CREATE': '2026-06-01' }
// to Vibecode MongoDB-style { 'createdAt': { '$gte': '2026-06-01' } }
const BX_OP_TO_MONGO: Record<string, string> = {
  '>=': '$gte', '<=': '$lte', '>': '$gt', '<': '$lt', '!': '$ne',
};

function convertFilter(filter: Rec, fieldMapper: (k: string) => string): Rec {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(filter)) {
    const m = k.match(/^(>=|<=|>|<|!)/);
    const op = m ? m[0] : '';
    const field = fieldMapper(k.slice(op.length));
    if (!op) {
      out[field] = Array.isArray(v) ? { $in: v } : v;
    } else {
      const mongo = BX_OP_TO_MONGO[op] ?? op;
      const cur = out[field];
      if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
        (cur as Record<string, unknown>)[mongo] = v;
      } else {
        out[field] = { [mongo]: v };
      }
    }
  }
  return out as Rec;
}

function leadField(k: string): string {
  const map: Record<string, string> = {
    DATE_CREATE: 'createdAt', DATE_CONVERT: 'dateClosed',
    STATUS_ID: 'stageId', STAGE_ID: 'stageId',
    ASSIGNED_BY_ID: 'assignedById', SOURCE_ID: 'sourceId',
    ID: 'id', NAME: 'name', TITLE: 'title',
  };
  return map[k] ?? k;
}

function dealField(k: string): string {
  const map: Record<string, string> = {
    LEAD_ID: 'leadId', CATEGORY_ID: 'categoryId',
    ASSIGNED_BY_ID: 'assignedById', DATE_CREATE: 'createdAt', ID: 'id',
  };
  return map[k] ?? k;
}

function statusField(k: string): string {
  const map: Record<string, string> = { ENTITY_ID: 'entityId', STATUS_ID: 'statusId' };
  return map[k] ?? k;
}

// ─── Кэш ──────────────────────────────────────────────────────────────────────

const _cache = new Map<string, { items: unknown[]; ts: number }>();
const CACHE_TTL = 60_000;

function cacheGet(key: string): unknown[] | null {
  const e = _cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) { _cache.delete(key); return null; }
  return e.items;
}

function cacheSet(key: string, items: unknown[]) {
  _cache.set(key, { items, ts: Date.now() });
}

// ─── Маршруты ─────────────────────────────────────────────────────────────────

app.post('/', (req, res) => {
  const body = req.body as Rec;
  log('bx24', `POST / placement=${body.PLACEMENT || 'unknown'}`);
  const indexPath = path.join(__dirname, '..', 'public', 'index.html');
  if (fs.existsSync(indexPath)) res.sendFile(indexPath);
  else res.status(200).send('App not built yet.');
});

app.get('/api/debug', (req, res) => {
  const vibeAuth = req.headers['x-vibe-authorization'] as string | undefined;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const sensitive = ['authorization', 'x-vibe-authorization'].includes(k.toLowerCase());
    headers[k] = sensitive ? `[REDACTED, len=${String(v).length}]` : String(v);
  }
  res.json({
    ts: ts(),
    vibeGateway: {
      hasXVibeAuthorization: !!vibeAuth,
      xVibeAuthorizationPrefix: vibeAuth ? vibeAuth.slice(0, 20) + '...' : null,
      xVibeUserId: req.headers['x-vibe-user-id'] || null,
      xVibeUserRole: req.headers['x-vibe-user-role'] || null,
      xVibePortalId: req.headers['x-vibe-portal-id'] || null,
    },
    server: {
      vibeAppKeySet: !!VIBE_APP_KEY,
      vibeAppKeyLength: VIBE_APP_KEY.length,
      port: PORT,
      nodeEnv: process.env.NODE_ENV || 'development',
    },
    allHeaders: headers,
  });
});

app.get('/api/healthcheck', (req, res) => {
  res.json({ ok: true, ts: ts(), vibeAppKeySet: !!VIBE_APP_KEY, v: '2' });
});

app.get('/api/me', (req, res) => {
  const encodedName = req.headers['x-vibe-user-name-encoded'] as string | undefined;
  const role = req.headers['x-vibe-user-role'] as string | undefined;
  const userId = req.headers['x-vibe-user-id'] as string | undefined;
  const portalId = req.headers['x-vibe-portal-id'] as string | undefined;
  log('me', `userId=${userId || 'null'}, role=${role || 'null'}`);
  res.json({
    userId: userId || null,
    userName: encodedName ? decodeURIComponent(encodedName) : null,
    portalId: portalId || null,
    isAdmin: role === 'ADMIN',
  });
});

// ─── POST /api/bx ─────────────────────────────────────────────────────────────

app.post('/api/bx', async (req, res) => {
  const bearerToken = req.headers['x-vibe-authorization'] as string | undefined;
  const { method, params } = req.body as { method: string; params?: Rec };

  if (!method) {
    res.status(400).json({ error: 'Missing method' });
    return;
  }

  if (!bearerToken) {
    log('bx', `${method}: нет X-Vibe-Authorization — 401`);
    res.status(401).json({ error: 'Откройте приложение через Битрикс24' });
    return;
  }

  log('bx', `→ ${method}`);
  const t0 = Date.now();
  const startOffset = (params?.start as number) || 0;

  try {
    // Variables с инициализацией во избежание ошибок TypeScript
    let vibeUrl: string = '';
    let vibeMethod: string = 'GET';
    let vibeBody: unknown = undefined;
    let mapper: ((v: Rec) => Rec) | null = null;

    switch (method) {

      case 'user.get': {
        const qp = new URLSearchParams();
        const filter = ((params?.FILTER ?? params?.filter) as Rec) || {};
        if (filter.ACTIVE !== undefined) qp.set('filter[active]', filter.ACTIVE ? 'Y' : 'N');
        if (params?.ID) qp.set('filter[id]', String(params.ID));
        qp.set('limit', '200');
        if (startOffset) qp.set('offset', String(startOffset));

        const cacheKey = `users:${bearerToken.slice(-20)}:${qp.toString()}`;
        const cached = cacheGet(cacheKey);
        if (cached) {
          log('bx', `user.get: CACHE HIT ${cached.length}`);
          res.json({ result: cached, next: undefined });
          return;
        }

        const vr = await callVibecode(`${VIBE_API}/users?${qp}`, { method: 'GET', bearerToken });
        const users = ((Array.isArray(vr.data) ? vr.data : []) as Rec[]).map(mapUser);
        const next = vr.meta?.hasMore ? startOffset + users.length : undefined;
        cacheSet(cacheKey, users);
        log('bx', `user.get: ${users.length} пользователей`);
        res.json({ result: users, next });
        return;
      }

      case 'crm.lead.list': {
        const rawFilter = ((params?.FILTER ?? params?.filter) as Rec) || {};
        vibeUrl = `${VIBE_API}/leads/search`;
        vibeMethod = 'POST';
        vibeBody = { filter: convertFilter(rawFilter, leadField), limit: 1000, ...(startOffset ? { offset: startOffset } : {}) };
        mapper = mapLead;
        break;
      }

      case 'crm.status.list': {
        const rawFilter = ((params?.FILTER ?? params?.filter) as Rec) || {};
        const mapped = convertFilter(rawFilter, statusField);
        const qp = new URLSearchParams();
        if (mapped.entityId) qp.set('filter[entityId]', String(mapped.entityId));
        qp.set('limit', '200');
        vibeUrl = `${VIBE_API}/statuses?${qp}`;
        vibeMethod = 'GET';
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
        const rawFilter = ((params?.FILTER ?? params?.filter) as Rec) || {};
        vibeUrl = `${VIBE_API}/deals/search`;
        vibeMethod = 'POST';
        vibeBody = { filter: convertFilter(rawFilter, dealField), limit: 1000, ...(startOffset ? { offset: startOffset } : {}) };
        mapper = mapDeal;
        break;
      }

      case 'timeman.timecontrol.report.get': {
        const userIds = (params?.USER_IDS as string[]) || [];
        const dateFrom = ((params?.DATE_FROM as string) || '').slice(0, 10);
        const dateTo = ((params?.DATE_TO as string) || '').slice(0, 10);
        log('bx', `timeman: ${userIds.length} пользователей, ${dateFrom}—${dateTo}`);

        try {
          const timeFilter: Record<string, unknown> = {};
          if (dateFrom) timeFilter['date'] = { ...((timeFilter['date'] as object) || {}), $gte: dateFrom };
          if (dateTo) timeFilter['date'] = { ...((timeFilter['date'] as object) || {}), $lte: dateTo };
          if (userIds.length > 0) timeFilter['userId'] = { $in: userIds };

          const vr = await callVibecode(`${VIBE_API}/timeman/entries/search`, {
            method: 'POST',
            body: { filter: timeFilter, limit: 5000 },
            bearerToken,
          });
          const entries = (Array.isArray(vr.data) ? vr.data : []) as Rec[];
          log('bx', `timeman: ${entries.length} записей, пример=${JSON.stringify(entries[0] ?? null).slice(0, 150)}`);

          const USERS: Record<string, { REPORT: Record<string, { DURATION: number }> }> = {};
          for (const entry of entries) {
            const uid = String(entry.userId ?? entry.user_id ?? entry.USER_ID ?? '');
            const rawDate = String(entry.date ?? entry.startDate ?? entry.start ?? entry.DATE ?? '').slice(0, 10);
            const duration = Number(entry.duration ?? entry.workTime ?? entry.work_time ?? entry.DURATION ?? entry.WORK_TIME ?? 0);
            if (!uid || !rawDate) continue;
            if (!USERS[uid]) USERS[uid] = { REPORT: {} };
            if (!USERS[uid].REPORT[rawDate]) USERS[uid].REPORT[rawDate] = { DURATION: 0 };
            USERS[uid].REPORT[rawDate].DURATION += duration;
          }

          log('bx', `timeman: сгруппировано по ${Object.keys(USERS).length} пользователям`);
          res.json({ result: { USERS }, next: undefined });
        } catch (timeErr) {
          log('bx', `timeman: ошибка — ${timeErr}. Возвращаем пустые данные`);
          res.json({ result: { USERS: {} }, next: undefined });
        }
        return;
      }

      default: {
        log('bx', `${method}: нет обёртки — пустой результат`);
        res.json({ result: [], next: undefined });
        return;
      }
    }

    const vr = await callVibecode(vibeUrl, { method: vibeMethod, body: vibeBody, bearerToken });
    const rawItems = (Array.isArray(vr.data) ? vr.data : vr.data != null ? [vr.data] : []) as Rec[];
    const items = mapper ? rawItems.map(mapper) : rawItems;
    const next = vr.meta?.hasMore ? startOffset + items.length : undefined;

    log('bx', `${method}: ${items.length} записей, hasMore=${vr.meta?.hasMore} (${Date.now() - t0}мс)`);
    res.json({ result: items, next });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('bx', `${method}: ОШИБКА — ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// ─── POST /api/batch ──────────────────────────────────────────────────────────

app.post('/api/batch', async (req, res) => {
  const bearerToken = req.headers['x-vibe-authorization'] as string | undefined;
  if (!bearerToken) { res.status(401).json({ error: 'Откройте приложение через Битрикс24' }); return; }

  const { commands } = req.body as { commands: Record<string, { method: string; params?: Rec }> };
  if (!commands) { res.status(400).json({ error: 'Требуется поле commands' }); return; }

  const vibeRequests: Record<string, BatchRequest> = {};
  const mapperByName: Record<string, ((v: Rec) => Rec) | null> = {};

  for (const [name, cmd] of Object.entries(commands)) {
    const { method, params } = cmd;
    const offset = (params?.start as number) || 0;
    switch (method) {
      case 'user.get': {
        const qp = new URLSearchParams();
        const f = ((params?.FILTER ?? params?.filter) as Rec) || {};
        if (f.ACTIVE !== undefined) qp.set('filter[active]', f.ACTIVE ? 'Y' : 'N');
        qp.set('limit', '200');
        if (offset) qp.set('offset', String(offset));
        vibeRequests[name] = { method: 'GET', path: `/v1/users?${qp}` };
        mapperByName[name] = mapUser;
        break;
      }
      case 'crm.lead.list':
        vibeRequests[name] = { method: 'POST', path: '/v1/leads/search', body: { filter: convertFilter((params?.FILTER ?? params?.filter ?? {}) as Rec, leadField), limit: 1000, ...(offset ? { offset } : {}) } };
        mapperByName[name] = mapLead;
        break;
      case 'crm.status.list': {
        const qp = new URLSearchParams();
        const mf = convertFilter((params?.FILTER ?? params?.filter ?? {}) as Rec, statusField);
        if (mf.entityId) qp.set('filter[entityId]', String(mf.entityId));
        qp.set('limit', '200');
        vibeRequests[name] = { method: 'GET', path: `/v1/statuses?${qp}` };
        mapperByName[name] = mapStatus;
        break;
      }
      case 'crm.category.list':
        vibeRequests[name] = { method: 'GET', path: '/v1/deal-categories' };
        mapperByName[name] = mapCategory;
        break;
      case 'crm.deal.list':
        vibeRequests[name] = { method: 'POST', path: '/v1/deals/search', body: { filter: convertFilter((params?.FILTER ?? params?.filter ?? {}) as Rec, dealField), limit: 1000, ...(offset ? { offset } : {}) } };
        mapperByName[name] = mapDeal;
        break;
      default:
        log('batch-api', `неизвестный метод: ${method}`);
    }
  }

  if (Object.keys(vibeRequests).length === 0) { res.json({ results: {} }); return; }

  try {
    const batchResp = await callVibeBatch(vibeRequests, bearerToken);
    const results: Record<string, { result: unknown[]; next?: number }> = {};
    for (const [name, vr] of Object.entries(batchResp)) {
      const mapper = mapperByName[name];
      const offset = (commands[name]?.params?.start as number) || 0;
      const rawItems = (Array.isArray(vr.data) ? vr.data : vr.data != null ? [vr.data] : []) as Rec[];
      const items = mapper ? rawItems.map(mapper) : rawItems;
      results[name] = { result: items, next: vr.meta?.hasMore ? offset + items.length : undefined };
    }
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── Коррекции и совместные лиды ─────────────────────────────────────────────

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
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

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
    if (secondManagerId) data[key][leadId] = { secondManagerId };
    else delete data[key][leadId];
    writeJson(dataFile('joints'), data);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ─── Catch-all ────────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    const indexPath = path.join(__dirname, '..', 'public', 'index.html');
    if (fs.existsSync(indexPath)) { res.sendFile(indexPath); return; }
  }
  next();
});

// ─── Обработчик ошибок ────────────────────────────────────────────────────────

app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const msg = err instanceof Error ? err.message : String(err);
  log('error', `${req.method} ${req.path}: ${msg}`);
  if (!res.headersSent) res.status(500).json({ error: msg });
});

process.on('unhandledRejection', (r) => log('error', `UNHANDLED REJECTION: ${r}`));
process.on('uncaughtException', (e) => { log('error', `UNCAUGHT: ${e.message}`); });

// ─── Старт ────────────────────────────────────────────────────────────────────

console.log(`[${ts()}] === ОРК Статистика запускается ===`);
console.log(`[${ts()}] PORT=${PORT}, NODE_ENV=${process.env.NODE_ENV || 'development'}`);
console.log(`[${ts()}] VIBE_APP_KEY: ${VIBE_APP_KEY ? `[len=${VIBE_APP_KEY.length}]` : '[НЕ ЗАДАН — API будет отклонять запросы]'}`);

app.listen(PORT, () => {
  console.log(`[${ts()}] === Сервер запущен на порту ${PORT} ===`);
});
