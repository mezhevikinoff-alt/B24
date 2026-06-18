/* eslint-disable @typescript-eslint/no-explicit-any */

// All Bitrix24 calls go through the backend proxy at /api/bx.
// Auth is handled automatically via the Vibecode gateway (x-vibe-authorization injected server-side).

async function bxCall(method: string, params: Record<string, unknown> = {}): Promise<any> {
  let r: Response;
  try {
    r = await fetch('/api/bx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params }),
    });
  } catch (netErr) {
    throw new Error(`Сетевая ошибка: ${netErr instanceof Error ? netErr.message : String(netErr)}`);
  }

  const text = await r.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    // HTML-страница вместо JSON — сервер недоступен или Gateway перехватил запрос
    if (text.includes('DOCTYPE') || text.includes('<html') || text.includes('<HTML')) {
      throw new Error('Сервер недоступен. Откройте приложение через портал Битрикс24.');
    }
    throw new Error(`Неверный формат ответа (HTTP ${r.status}): ${text.slice(0, 120)}`);
  }

  if (!r.ok) {
    throw new Error(data?.error || data?.error_description || `HTTP ${r.status}`);
  }
  if (data?.error) {
    throw new Error(data.error_description || String(data.error));
  }

  return data;
}

export async function callMethod(method: string, params: Record<string, any> = {}): Promise<any[]> {
  const all: any[] = [];
  let start = 0;

  for (;;) {
    const data = await bxCall(method, { ...params, start });
    const result = data.result;
    if (Array.isArray(result)) all.push(...result);
    else if (result != null) all.push(result);

    if (typeof data.next === 'number') {
      start = data.next;
    } else {
      break;
    }
  }
  return all;
}

export async function callMethodSingle(method: string, params: Record<string, any> = {}): Promise<any> {
  const data = await bxCall(method, params);
  return data.result;
}

export async function callBatch(
  calls: Record<string, { method: string; params?: Record<string, any> }>,
): Promise<Record<string, any>> {
  const entries = Object.entries(calls);
  const results = await Promise.all(
    entries.map(async ([key, { method, params }]) => {
      const result = await callMethodSingle(method, params || {});
      return [key, result] as [string, any];
    }),
  );
  return Object.fromEntries(results);
}

// ─── Users ──────────────────────────────────────────────────────────────────

export async function getUserList(departmentId?: number): Promise<any[]> {
  const filter: Record<string, any> = { ACTIVE: true };
  if (departmentId) filter['UF_DEPARTMENT'] = departmentId;
  return callMethod('user.get', {
    FILTER: filter,
    SELECT: ['ID', 'NAME', 'LAST_NAME', 'SECOND_NAME', 'IS_ADMIN', 'UF_DEPARTMENT', 'ACTIVE', 'PERSONAL_PHOTO'],
  });
}

export async function getCurrentUserFull(userId: string): Promise<any> {
  const data = await callMethod('user.get', { ID: userId });
  return data[0] || null;
}

// ─── Timeman ─────────────────────────────────────────────────────────────────

export async function getTimemanReport(
  userIds: string[],
  dateFrom: string,
  dateTo: string,
): Promise<any> {
  return callMethodSingle('timeman.timecontrol.report.get', {
    USER_IDS: userIds,
    DATE_FROM: dateFrom,
    DATE_TO: dateTo,
  });
}

// ─── CRM ─────────────────────────────────────────────────────────────────────

export const EXCLUDE_STATUS_IDS_SYSTEM = ['JUNK', 'DUPLICATE', 'RECYCLED'];
export const EXCLUDE_STATUS_NAME_PATTERNS = ['предложение по сотрудничеству'];

export async function getLeadStatusMap(): Promise<Record<string, string>> {
  const statuses = await callMethod('crm.status.list', {
    FILTER: { ENTITY_ID: 'STATUS' },
    SELECT: ['STATUS_ID', 'NAME'],
  });
  const map: Record<string, string> = {};
  for (const s of statuses) map[s.STATUS_ID] = s.NAME;
  return map;
}

export async function resolveExcludedStatusIds(): Promise<Set<string>> {
  const excluded = new Set(EXCLUDE_STATUS_IDS_SYSTEM);
  try {
    const statusMap = await getLeadStatusMap();
    for (const [id, name] of Object.entries(statusMap)) {
      const nameLower = name.toLowerCase();
      if (EXCLUDE_STATUS_NAME_PATTERNS.some((p) => nameLower.includes(p))) {
        excluded.add(id);
      }
    }
  } catch {
    // fall back to system IDs only
  }
  return excluded;
}

export async function getLeadsForMonth(dateFrom: string, dateTo: string): Promise<any[]> {
  return callMethod('crm.lead.list', {
    FILTER: {
      '>=DATE_CREATE': dateFrom,
      '<DATE_CREATE': dateTo,
    },
    SELECT: [
      'ID', 'TITLE', 'NAME', 'LAST_NAME', 'SECOND_NAME',
      'DATE_CREATE', 'DATE_CONVERT', 'STATUS_ID',
      'ASSIGNED_BY_ID', 'CATEGORY_ID', 'OPPORTUNITY', 'SOURCE_ID',
    ],
  });
}

export async function getDealCategories(): Promise<any[]> {
  return callMethod('crm.category.list', { entityTypeId: 2 });
}

export async function getDealsByLeadIds(leadIds: string[]): Promise<any[]> {
  if (leadIds.length === 0) return [];
  const calls: Record<string, { method: string; params: Record<string, any> }> = {};
  const chunks: string[][] = [];
  for (let i = 0; i < leadIds.length; i += 50) chunks.push(leadIds.slice(i, i + 50));
  chunks.forEach((chunk, idx) => {
    calls[`deals_${idx}`] = {
      method: 'crm.deal.list',
      params: {
        FILTER: { LEAD_ID: chunk },
        SELECT: ['ID', 'TITLE', 'LEAD_ID', 'CATEGORY_ID', 'DATE_CREATE', 'ASSIGNED_BY_ID'],
      },
    };
  });
  const results = await callBatch(calls);
  const all: any[] = [];
  for (const key in results) {
    if (Array.isArray(results[key])) all.push(...results[key]);
  }
  return all;
}
