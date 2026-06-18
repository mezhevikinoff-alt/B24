import express, { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';

// ─── Конфигурация ─────────────────────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, '..', 'data');

// Rule 1: VIBE_APP_KEY — ключ приложения, добавляется как X-Api-Key
// ко ВСЕМ запросам к Вайбкод API
const VIBE_APP_KEY = process.env.VIBE_APP_KEY || '';
const BX24_DOMAIN = process.env.BX24_DOMAIN || 'credburo.bitrix24.ru';
const VIBE_API = 'https://vibecode.bitrix24.tech/v1';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  console.error(`[init] Не удалось создать DATA_DIR: ${e}`);
}

// ─── Утилиты ──────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString();
}

function log(label: string, msg: string) {
  console.log(`[${ts()}] [${label}] ${msg}`);
}

function dataFile(name: string) {
  return path.join(DATA_DIR, name + '.json');
}

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

// ─── Вайбкод API: единая функция запроса ──────────────────────────────────────
// Rule 1: всегда X-Api-Key: VIBE_APP_KEY
// Rule 2: всегда Authorization: Bearer <x-vibe-authorization>

interface VibeResponse {
  success: boolean;
  data?: unknown;
  meta?: { total?: number; hasMore?: boolean };
  error?: { code?: string; message?: string } | string;
}

// ─── Rate limiter: 200мс между запросами = максимум 5 req/s ──────────────────
// Все запросы к Вайбкод API проходят через очередь, исключая 429

let _rateLimitLock: Promise<void> = Promise.resolve();
const RATE_INTERVAL_MS = 200;

function scheduleVibecodeRequest<T>(fn: () => Promise<T>): Promise<T> {
  const scheduled = _rateLimitLock.then(async () => {
    // 200мс минимальный интервал после предыдущего запроса
    await new Promise<void>(r => setTimeout(r, RATE_INTERVAL_MS));
    return fn();
  });
  // Цепочка: следующий запрос ждёт завершения текущего (успех или ошибка)
  _rateLimitLock = scheduled.then(() => {}, () => {});
  return scheduled;
}

async function callVibecode(
  url: string,
  opts: { method?: string; body?: unknown; bearerToken: string },
  attempt = 1,
): Promise<VibeResponse> {
  return scheduleVibecodeRequest(() => callVibecodeDirect(url, opts, attempt));
}

async function callVibecodeDirect(
  url: string,
  opts: { method?: string; body?: unknown; bearerToken: string },
  attempt: number,
): Promise<VibeResponse> {
  const method = opts.method || 'GET';
  log('vibecode', `→ [попытка ${attempt}/3] ${method} ${url}${opts.body ? ' body=' + JSON.stringify(opts.body).slice(0, 200) : ''}`);

  const t0 = Date.now();
  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': VIBE_APP_KEY,                    // Rule 1: ключ приложения
      'Authorization': `Bearer ${opts.bearerToken}`, // Rule 2: токен пользователя
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const text = await response.text();
  const elapsed = Date.now() - t0;
  log('vibecode', `← HTTP ${response.status} за ${elapsed}мс: ${text.slice(0, 300)}`);

  // Обработка 429: ждём 1с и повторяем (максимум 3 попытки)
  if (response.status === 429) {
    if (attempt < 3) {
      log('vibecode', `429 Too Many Requests — ждём 1с и повторяем (попытка ${attempt + 1}/3)`);
      await new Promise<void>(r => setTimeout(r, 1000));
      return callVibecodeDirect(url, opts, attempt + 1);
    }
    throw new Error(`429 Too Many Requests — превышен лимит запросов после 3 попыток`);
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
    log('vibecode', `ОШИБКА API: ${errMsg}`);
    throw new Error(`Вайбкод API: ${errMsg}`);
  }

  return parsed;
}

// ─── Batch API: несколько запросов за один HTTP-вызов ────────────────────────

interface BatchRequest {
  method: string;
  path: string;
  body?: unknown;
}

interface BatchVibeResponse {
  success: boolean;
  responses?: Record<string, VibeResponse>;
  error?: unknown;
}

async function callVibeBatch(
  requests: Record<string, BatchRequest>,
  bearerToken: string,
): Promise<Record<string, VibeResponse>> {
  log('batch', `→ batch из ${Object.keys(requests).length} запросов: ${Object.keys(requests).join(', ')}`);
  const t0 = Date.now();

  const response = await fetch(`${VIBE_API}/batch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': VIBE_APP_KEY,
      'Authorization': `Bearer ${bearerToken}`,
    },
    body: JSON.stringify({ requests }),
  });

  const text = await response.text();
  const elapsed = Date.now() - t0;
  log('batch', `← HTTP ${response.status} за ${elapsed}мс: ${text.slice(0, 500)}`);

  if (response.status === 429) {
    throw new Error(`429 Too Many Requests — превышен лимит (batch)`);
  }

  let parsed: BatchVibeResponse;
  try {
    parsed = JSON.parse(text) as BatchVibeResponse;
  } catch {
    throw new Error(`Не-JSON batch ответ (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }

  if (!parsed.success) {
    throw new Error(`Batch API ошибка: ${JSON.stringify(parsed.error)}`);
  }

  return parsed.responses || {};
}

// ─── Маппинг полей Vibecode camelCase → BX24 UPPER_CASE ─────────────────────
// Согласно /v1/leads/fields и /v1/deals/fields

type Rec = Record<string, unknown>;

function mapUser(v: Rec): Rec {
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

function mapLead(v: Rec): Rec {
  // stageSemanticId='S' = успешно конвертирован, isConvert != null тоже признак конверсии
  const converted = v.stageSemanticId === 'S' || (v.isConvert != null && v.isConvert !== false);
  return {
    ID: String(v.id ?? ''),
    TITLE: v.title ?? '',
    NAME: v.name ?? '',
    LAST_NAME: v.lastName ?? '',
    SECOND_NAME: v.secondName ?? '',
    DATE_CREATE: v.createdTime ?? v.createdAt ?? '',  // Vibecode: createdTime
    DATE_CONVERT: converted ? (v.dateClosed ?? v.movedTime ?? null) : null,
    STATUS_ID: String(v.stageId ?? v.statusId ?? ''), // stageId — код стадии лида
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
    STATUS_ID: v.statusId ?? '',
    NAME: v.name ?? '',
    ENTITY_ID: v.entityId ?? '',
  };
}

function mapCategory(v: Rec): Rec {
  return {
    ID: String(v.id ?? ''),
    NAME: v.name ?? '',
  };
}

// Маппинг ключей фильтра: BX24 → Vibecode
function remapFilter(
  filter: Rec,
  mapper: (k: string) => string,
): Rec {
  const out: Rec = {};
  for (const [k, v] of Object.entries(filter)) {
    out[mapper(k)] = v;
  }
  return out;
}

function leadFilterKey(k: string): string {
  const opMatch = k.match(/^(>=|<=|>|<|%|!)/);
  const op = opMatch ? opMatch[0] : '';
  const field = k.slice(op.length);
  const map: Record<string, string> = {
    DATE_CREATE: 'createdAt',
    DATE_CONVERT: 'dateClosed',
    STATUS_ID: 'stageId',
    STAGE_ID: 'stageId',
    ASSIGNED_BY_ID: 'assignedById',
    SOURCE_ID: 'sourceId',
    ID: 'id', NAME: 'name', TITLE: 'title',
  };
  return op + (map[field] ?? field);
}

function dealFilterKey(k: string): string {
  const opMatch = k.match(/^(>=|<=|>|<|%|!)/);
  const op = opMatch ? opMatch[0] : '';
  const field = k.slice(op.length);
  const map: Record<string, string> = {
    LEAD_ID: 'leadId',
    CATEGORY_ID: 'categoryId',
    ASSIGNED_BY_ID: 'assignedById',
    DATE_CREATE: 'createdAt',
    ID: 'id',
  };
  return op + (map[field] ?? field);
}

function statusFilterKey(k: string): string {
  const map: Record<string, string> = { ENTITY_ID: 'entityId', STATUS_ID: 'statusId' };
  return map[k] ?? k;
}

// ─── Кэш (предотвращает 429 при одновременном открытии нескольких вкладок) ───

const _cache = new Map<string, { items: unknown[]; ts: number }>();
const CACHE_TTL = 60_000; // 60 секунд

function cacheGet(key: string): unknown[] | null {
  const e = _cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) { _cache.delete(key); return null; }
  return e.items;
}

function cacheSet(key: string, items: unknown[]) {
  _cache.set(key, { items, ts: Date.now() });
}

// ─── Обработчик POST от Битрикс24 (открытие приложения) ─────────────────────

app.post('/', (req, res) => {
  const body = req.body as Rec;
  const placement = String(body.PLACEMENT || 'unknown');
  const domain = String(body.DOMAIN || BX24_DOMAIN);
  const authId = String(body.AUTH_ID || body.auth_id || '');
  log('bx24-handler', `POST / — placement=${placement}, domain=${domain}, authId=${authId ? '[есть, len=' + authId.length + ']' : '[нет]'}`);

  const indexPath = path.join(__dirname, '..', 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(200).send('App not built yet.');
  }
});

// ─── GET /api/debug — все заголовки входящего запроса (Rule 5) ───────────────
// Используется для проверки что Gateway правильно инжектирует X-Vibe-Authorization

app.get('/api/debug', (req, res) => {
  log('debug', `GET /api/debug — показываем все заголовки`);

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    // Скрываем значение Authorization/Token-заголовков, но показываем наличие и длину
    const sensitive = ['authorization', 'x-vibe-authorization'].includes(k.toLowerCase());
    headers[k] = sensitive ? `[REDACTED, len=${String(v).length}]` : String(v);
  }

  const vibeAuth = req.headers['x-vibe-authorization'] as string | undefined;

  res.json({
    ts: ts(),
    vibeGateway: {
      hasXVibeAuthorization: !!vibeAuth,
      xVibeAuthorizationPrefix: vibeAuth ? vibeAuth.slice(0, 16) + '...' : null,
      xVibeUserId: req.headers['x-vibe-user-id'] || null,
      xVibeUserRole: req.headers['x-vibe-user-role'] || null,
      xVibePortalId: req.headers['x-vibe-portal-id'] || null,
      xVibeUserNameEncoded: req.headers['x-vibe-user-name-encoded'] || null,
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

// ─── POST /api/batch — загрузка нескольких BX24-методов за один запрос ───────
// Объединяет user.get + crm.lead.list + crm.status.list + crm.category.list
// в один вызов POST /v1/batch, сокращая число запросов к Вайбкод API

app.post('/api/batch', async (req, res) => {
  const bearerToken = req.headers['x-vibe-authorization'] as string | undefined;

  if (!bearerToken) {
    log('batch-api', 'нет X-Vibe-Authorization — 401');
    res.status(401).json({ error: 'Откройте приложение через Битрикс24' });
    return;
  }

  const { commands } = req.body as { commands: Record<string, { method: string; params?: Rec }> };
  if (!commands || typeof commands !== 'object') {
    res.status(400).json({ error: 'Требуется поле commands: { name: { method, params } }' });
    return;
  }

  log('batch-api', `команды: ${Object.keys(commands).join(', ')}`);

  // Строим vibecode batch requests из BX24-команд
  const vibeRequests: Record<string, BatchRequest> = {};
  const mapperByName: Record<string, ((v: Rec) => Rec) | null> = {};

  for (const [name, cmd] of Object.entries(commands)) {
    const { method, params } = cmd;
    const startOffset = (params?.start as number) || 0;

    switch (method) {
      case 'user.get': {
        const qp = new URLSearchParams();
        const filter = ((params?.FILTER ?? params?.filter) as Rec) || {};
        if (filter.ACTIVE !== undefined) qp.set('filter[ACTIVE]', filter.ACTIVE ? 'Y' : 'N');
        qp.set('limit', '200');
        if (startOffset) qp.set('offset', String(startOffset));
        vibeRequests[name] = { method: 'GET', path: `/v1/users?${qp.toString()}` };
        mapperByName[name] = mapUser;
        break;
      }
      case 'crm.lead.list': {
        const rawFilter = ((params?.FILTER ?? params?.filter) as Rec) || {};
        const mappedFilter = remapFilter(rawFilter, leadFilterKey);
        vibeRequests[name] = {
          method: 'POST',
          path: '/v1/leads/search',
          body: { filter: mappedFilter, limit: 50, ...(startOffset ? { offset: startOffset } : {}) },
        };
        mapperByName[name] = mapLead;
        break;
      }
      case 'crm.status.list': {
        const rawFilter = ((params?.FILTER ?? params?.filter) as Rec) || {};
        const mappedFilter = remapFilter(rawFilter, statusFilterKey);
        const qp = new URLSearchParams();
        if (mappedFilter.entityId) qp.set('filter[entityId]', String(mappedFilter.entityId));
        qp.set('limit', '200');
        vibeRequests[name] = { method: 'GET', path: `/v1/statuses?${qp.toString()}` };
        mapperByName[name] = mapStatus;
        break;
      }
      case 'crm.category.list': {
        vibeRequests[name] = { method: 'GET', path: '/v1/deal-categories' };
        mapperByName[name] = mapCategory;
        break;
      }
      case 'crm.deal.list': {
        const rawFilter = ((params?.FILTER ?? params?.filter) as Rec) || {};
        const mappedFilter = remapFilter(rawFilter, dealFilterKey);
        vibeRequests[name] = {
          method: 'POST',
          path: '/v1/deals/search',
          body: { filter: mappedFilter, limit: 50, ...(startOffset ? { offset: startOffset } : {}) },
        };
        mapperByName[name] = mapDeal;
        break;
      }
      default:
        log('batch-api', `неизвестный метод: ${method} (пропускаем)`);
    }
  }

  if (Object.keys(vibeRequests).length === 0) {
    res.json({ results: {} });
    return;
  }

  try {
    const batchResp = await callVibeBatch(vibeRequests, bearerToken);
    const results: Record<string, { result: unknown[]; next?: number }> = {};

    for (const [name, vibeResp] of Object.entries(batchResp)) {
      const mapper = mapperByName[name];
      const startOff = (commands[name]?.params?.start as number) || 0;
      const rawItems = (Array.isArray(vibeResp.data) ? vibeResp.data : vibeResp.data != null ? [vibeResp.data] : []) as Rec[];
      const items = mapper ? rawItems.map(mapper) : rawItems;
      const hasMore = vibeResp.meta?.hasMore ?? false;
      const next = hasMore ? startOff + items.length : undefined;
      log('batch-api', `${name}: ${items.length} записей, hasMore=${hasMore}`);
      results[name] = { result: items, next };
    }

    res.json({ results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('batch-api', `ОШИБКА — ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// ─── GET /api/healthcheck ─────────────────────────────────────────────────────

app.get('/api/healthcheck', (req, res) => {
  log('healthcheck', 'OK');
  res.json({
    ok: true,
    ts: ts(),
    vibeAppKeySet: !!VIBE_APP_KEY,
    hasXVibeAuthorization: !!req.headers['x-vibe-authorization'],
  });
});

// ─── GET /api/me — данные пользователя из заголовков Gateway ─────────────────

app.get('/api/me', (req, res) => {
  const encodedName = req.headers['x-vibe-user-name-encoded'] as string | undefined;
  const role = req.headers['x-vibe-user-role'] as string | undefined;
  const userId = req.headers['x-vibe-user-id'] as string | undefined;
  const portalId = req.headers['x-vibe-portal-id'] as string | undefined;

  log('me', `userId=${userId || 'null'}, role=${role || 'null'}, portal=${portalId || 'null'}, hasVibeAuth=${!!req.headers['x-vibe-authorization']}`);

  res.json({
    userId: userId || null,
    userName: encodedName ? decodeURIComponent(encodedName) : null,
    portalId: portalId || null,
    isAdmin: role === 'ADMIN',
  });
});

// ─── POST /api/bx — прокси к Вайбкод Entity API ──────────────────────────────
// Rule 2: берёт X-Vibe-Authorization из запроса, передаёт как Bearer-токен
// Rule 4: если токена нет — 401

app.post('/api/bx', async (req, res) => {
  // Rule 2: получаем токен пользователя из заголовка инжектированного Gateway
  const bearerToken = req.headers['x-vibe-authorization'] as string | undefined;

  const { method, params } = req.body as { method: string; params?: Rec };

  if (!method) {
    res.status(400).json({ error: 'Missing method' });
    return;
  }

  // Rule 4: без токена — 401
  if (!bearerToken) {
    log('bx', `${method}: нет X-Vibe-Authorization — 401`);
    res.status(401).json({
      error: 'Откройте приложение через Битрикс24',
      hint: 'X-Vibe-Authorization заголовок отсутствует. Приложение должно открываться через портал Битрикс24, где Gateway автоматически добавляет этот заголовок.',
    });
    return;
  }

  log('bx', `→ метод=${method}, params=${JSON.stringify(params || {}).slice(0, 200)}`);

  const t0 = Date.now();
  const startOffset = (params?.start as number) || 0;

  try {
    let vibeUrl: string;
    let vibeMethod: string;
    let vibeBody: unknown;
    let mapper: ((v: Rec) => Rec) | null = null;

    switch (method) {

      // ── user.get → GET /v1/users ────────────────────────────────────────────
      case 'user.get': {
        log('bx', `user.get: загружаем пользователей портала`);
        const qp = new URLSearchParams();
        const filter = ((params?.FILTER ?? params?.filter) as Rec) || {};
        if (filter.ACTIVE !== undefined) qp.set('filter[ACTIVE]', filter.ACTIVE ? 'Y' : 'N');
        if (params?.ID) qp.set('filter[id]', String(params.ID));
        qp.set('limit', '200');
        if (startOffset) qp.set('offset', String(startOffset));
        vibeUrl = `${VIBE_API}/users?${qp.toString()}`;
        vibeMethod = 'GET';
        mapper = mapUser;

        // Кэш: пользователи редко меняются, не стоит дёргать API на каждую вкладку
        const cacheKey = `users:${bearerToken.slice(-20)}:${qp.toString()}`;
        const cached = cacheGet(cacheKey);
        if (cached) {
          log('bx', `user.get: CACHE HIT — ${cached.length} пользователей`);
          res.json({ result: cached, next: undefined });
          return;
        }

        const vResp = await callVibecode(vibeUrl, { method: vibeMethod, bearerToken });
        const rawUsers = (Array.isArray(vResp.data) ? vResp.data : []) as Rec[];
        const users = rawUsers.map(mapUser);

        const hasMore = vResp.meta?.hasMore ?? false;
        const next = hasMore ? startOffset + users.length : undefined;

        cacheSet(cacheKey, users);
        log('bx', `user.get: загружено ${users.length} пользователей, hasMore=${hasMore}`);
        res.json({ result: users, next });
        return;
      }

      // ── crm.lead.list → POST /v1/leads/search ──────────────────────────────
      case 'crm.lead.list': {
        log('bx', `crm.lead.list: поиск лидов, offset=${startOffset}`);
        const rawFilter = ((params?.FILTER ?? params?.filter) as Rec) || {};
        const mappedFilter = remapFilter(rawFilter, leadFilterKey);
        log('bx', `crm.lead.list: фильтр BX24=${JSON.stringify(rawFilter)} → Vibe=${JSON.stringify(mappedFilter)}`);
        vibeUrl = `${VIBE_API}/leads/search`;
        vibeMethod = 'POST';
        vibeBody = { filter: mappedFilter, limit: 50, ...(startOffset ? { offset: startOffset } : {}) };
        mapper = mapLead;
        break;
      }

      // ── crm.status.list → GET /v1/statuses ─────────────────────────────────
      case 'crm.status.list': {
        log('bx', `crm.status.list: загружаем справочник статусов`);
        const rawFilter = ((params?.FILTER ?? params?.filter) as Rec) || {};
        const mappedFilter = remapFilter(rawFilter, statusFilterKey);
        const qp = new URLSearchParams();
        if (mappedFilter.entityId) qp.set('filter[entityId]', String(mappedFilter.entityId));
        qp.set('limit', '200');
        if (startOffset) qp.set('offset', String(startOffset));
        vibeUrl = `${VIBE_API}/statuses?${qp.toString()}`;
        vibeMethod = 'GET';
        mapper = mapStatus;
        break;
      }

      // ── crm.category.list → GET /v1/deal-categories ────────────────────────
      case 'crm.category.list': {
        log('bx', `crm.category.list: загружаем категории сделок`);
        vibeUrl = `${VIBE_API}/deal-categories`;
        vibeMethod = 'GET';
        mapper = mapCategory;
        break;
      }

      // ── crm.deal.list → POST /v1/deals/search ──────────────────────────────
      case 'crm.deal.list': {
        log('bx', `crm.deal.list: поиск сделок, offset=${startOffset}`);
        const rawFilter = ((params?.FILTER ?? params?.filter) as Rec) || {};
        const mappedFilter = remapFilter(rawFilter, dealFilterKey);
        log('bx', `crm.deal.list: фильтр BX24=${JSON.stringify(rawFilter)} → Vibe=${JSON.stringify(mappedFilter)}`);
        vibeUrl = `${VIBE_API}/deals/search`;
        vibeMethod = 'POST';
        vibeBody = { filter: mappedFilter, limit: 50, ...(startOffset ? { offset: startOffset } : {}) };
        mapper = mapDeal;
        break;
      }

      // ── timeman.timecontrol.report.get → GET /v1/workday/status ────────────
      // Вайбкод не поддерживает исторические отчёты timeman;
      // /v1/workday/status возвращает текущий статус рабочего дня авторизованного пользователя
      case 'timeman.timecontrol.report.get': {
        log('bx', `timeman: запрашиваем статус рабочего дня через /v1/workday/status`);
        vibeUrl = `${VIBE_API}/workday/status`;
        vibeMethod = 'GET';

        const vResp = await callVibecode(vibeUrl, { method: vibeMethod, bearerToken });
        log('bx', `timeman: ответ=${JSON.stringify(vResp.data).slice(0, 200)}`);
        // Возвращаем пустой результат — исторические данные timeman не поддерживаются API
        res.json({ result: null, raw: vResp.data });
        return;
      }

      default: {
        log('bx', `${method}: нет обёртки в Вайбкод — возвращаем пустой результат`);
        res.json({ result: [], next: undefined });
        return;
      }
    }

    // Общий путь для методов с виб-URL + mapper
    const vResp = await callVibecode(vibeUrl!, {
      method: vibeMethod!,
      body: vibeBody,
      bearerToken,
    });

    const rawItems = (Array.isArray(vResp.data) ? vResp.data : vResp.data != null ? [vResp.data] : []) as Rec[];
    const items = mapper ? rawItems.map(mapper) : rawItems;

    // Пагинация через meta.hasMore
    const hasMore = vResp.meta?.hasMore ?? false;
    const next = hasMore ? startOffset + items.length : undefined;

    const elapsed = Date.now() - t0;
    log('bx', `${method}: загружено ${items.length} записей, hasMore=${hasMore}, next=${next ?? 'нет'} (${elapsed}мс)`);

    res.json({ result: items, next });

  } catch (err: unknown) {
    const elapsed = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    log('bx', `${method}: ОШИБКА — ${msg} (${elapsed}мс)`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    res.status(500).json({ error: msg });
  }
});

// ─── Коррекции рабочих часов ──────────────────────────────────────────────────

app.get('/api/corrections/:year/:month', (req, res) => {
  const key = `${req.params.year}-${req.params.month.padStart(2, '0')}`;
  log('corrections', `GET ${key}`);
  const data = readJson(dataFile('corrections'));
  res.json(data[key] || {});
});

app.put('/api/corrections/:year/:month', (req, res) => {
  try {
    const key = `${req.params.year}-${req.params.month.padStart(2, '0')}`;
    log('corrections', `PUT ${key}`);
    const data = readJson(dataFile('corrections'));
    data[key] = req.body;
    writeJson(dataFile('corrections'), data);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── Совместные лиды ──────────────────────────────────────────────────────────

app.get('/api/joints/:year/:month', (req, res) => {
  const key = `${req.params.year}-${req.params.month.padStart(2, '0')}`;
  log('joints', `GET ${key}`);
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
    log('joints', `POST ${key}: lead=${leadId} manager=${secondManagerId || 'убран'}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── Catch-all: отдаём React-приложение ──────────────────────────────────────

app.get('*', (req, res) => {
  const queryKeys = Object.keys(req.query);
  if (queryKeys.length > 0) {
    const safe: Record<string, string> = {};
    for (const k of queryKeys) {
      const v = String(req.query[k]);
      safe[k] = k.toLowerCase().includes('auth') ? `[len=${v.length}]` : v;
    }
    log('get', `${req.path} — query: ${JSON.stringify(safe)}`);
  }

  const indexPath = path.join(__dirname, '..', 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(200).send('App not built yet.');
  }
});

// ─── Глобальный обработчик ошибок ────────────────────────────────────────────

app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const msg = err instanceof Error ? err.message : String(err);
  log('error', `UNHANDLED ${req.method} ${req.path}: ${msg}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  if (!res.headersSent) res.status(500).json({ error: msg });
});

process.on('unhandledRejection', (reason) => {
  log('error', `UNHANDLED REJECTION: ${reason}`);
});

process.on('uncaughtException', (err) => {
  log('error', `UNCAUGHT EXCEPTION: ${(err as Error).message}`);
  console.error((err as Error).stack);
});

// ─── Запуск сервера ───────────────────────────────────────────────────────────

console.log(`[${ts()}] === ОРК Статистика запускается ===`);
console.log(`[${ts()}] PORT=${PORT}, NODE_ENV=${process.env.NODE_ENV || 'development'}`);
console.log(`[${ts()}] VIBE_APP_KEY: ${VIBE_APP_KEY ? '[УСТАНОВЛЕН, len=' + VIBE_APP_KEY.length + ']' : '[ОТСУТСТВУЕТ — запросы к Вайбкод API не пройдут]'}`);
console.log(`[${ts()}] VIBE_API: ${VIBE_API}`);
console.log(`[${ts()}] BX24_DOMAIN: ${BX24_DOMAIN}`);
console.log(`[${ts()}] Правила авторизации:`);
console.log(`[${ts()}]   X-Api-Key: VIBE_APP_KEY (ключ приложения, всегда)`);
console.log(`[${ts()}]   Authorization: Bearer <X-Vibe-Authorization> (токен пользователя от Gateway)`);

app.listen(PORT, () => {
  console.log(`[${ts()}] === Сервер запущен на порту ${PORT} ===`);
});
