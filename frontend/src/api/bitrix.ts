/* eslint-disable @typescript-eslint/no-explicit-any */
declare const BX24: any;

export function bx24Init(): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof BX24 === 'undefined') {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => resolve(false), 5000);
    BX24.init(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

export function bx24IsAdmin(): boolean {
  return BX24.isAdmin();
}

export function bx24GetUser(): { ID: string; NAME: string; LAST_NAME: string } {
  return BX24.getUser();
}

export function callMethod(method: string, params: Record<string, any> = {}): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const all: any[] = [];
    function handler(result: any) {
      if (result.error()) {
        reject(new Error(String(result.error())));
        return;
      }
      const data = result.data();
      if (Array.isArray(data)) {
        all.push(...data);
      } else {
        all.push(data);
      }
      if (result.more()) {
        result.next();
      } else {
        resolve(all);
      }
    }
    BX24.callMethod(method, params, handler);
  });
}

export function callMethodSingle(method: string, params: Record<string, any> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    BX24.callMethod(method, params, (result: any) => {
      if (result.error()) {
        reject(new Error(String(result.error())));
        return;
      }
      resolve(result.data());
    });
  });
}

export function callBatch(
  calls: Record<string, { method: string; params?: Record<string, any> }>,
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const batchCalls: Record<string, [string, Record<string, any>]> = {};
    for (const key in calls) {
      batchCalls[key] = [calls[key].method, calls[key].params || {}];
    }
    BX24.callBatch(batchCalls, (results: Record<string, any>) => {
      const out: Record<string, any> = {};
      for (const key in results) {
        if (results[key].error()) {
          reject(new Error(`Batch error [${key}]: ${results[key].error()}`));
          return;
        }
        out[key] = results[key].data();
      }
      resolve(out);
    });
  });
}

// ─── Users ──────────────────────────────────────────────────────────────────

export async function getUserList(departmentId?: number): Promise<any[]> {
  const filter: Record<string, any> = { ACTIVE: true };
  if (departmentId) filter['UF_DEPARTMENT'] = departmentId;
  return callMethod('user.get', { FILTER: filter, SELECT: ['ID', 'NAME', 'LAST_NAME', 'SECOND_NAME', 'IS_ADMIN', 'UF_DEPARTMENT', 'ACTIVE', 'PERSONAL_PHOTO'] });
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

// System status IDs always excluded (Битрикс24 hardcoded values)
export const EXCLUDE_STATUS_IDS_SYSTEM = ['JUNK', 'DUPLICATE', 'RECYCLED'];

// Status names to exclude via text match (case-insensitive, partial match)
export const EXCLUDE_STATUS_NAME_PATTERNS = [
  'предложение по сотрудничеству',
];

// Loads all lead statuses from Bitrix24 and returns a map ID → NAME
export async function getLeadStatusMap(): Promise<Record<string, string>> {
  const statuses = await callMethod('crm.status.list', {
    FILTER: { ENTITY_ID: 'STATUS' },
    SELECT: ['STATUS_ID', 'NAME'],
  });
  const map: Record<string, string> = {};
  for (const s of statuses) {
    map[s.STATUS_ID] = s.NAME;
  }
  return map;
}

// Resolves the full set of status IDs to exclude:
// system IDs + any IDs whose NAME matches EXCLUDE_STATUS_NAME_PATTERNS
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
    // If status list fails, fall back to system IDs only
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
  return callMethod('crm.category.list', { entityTypeId: 2 }); // 2 = Deals
}

export async function getDealsByLeadIds(leadIds: string[]): Promise<any[]> {
  if (leadIds.length === 0) return [];
  const calls: Record<string, { method: string; params: Record<string, any> }> = {};
  // Batch up to 50 at a time
  const chunks: string[][] = [];
  for (let i = 0; i < leadIds.length; i += 50) {
    chunks.push(leadIds.slice(i, i + 50));
  }
  let idx = 0;
  for (const chunk of chunks) {
    calls[`deals_${idx}`] = {
      method: 'crm.deal.list',
      params: {
        FILTER: { LEAD_ID: chunk },
        SELECT: ['ID', 'TITLE', 'LEAD_ID', 'CATEGORY_ID', 'DATE_CREATE', 'ASSIGNED_BY_ID'],
      },
    };
    idx++;
  }
  const results = await callBatch(calls);
  const all: any[] = [];
  for (const key in results) {
    if (Array.isArray(results[key])) all.push(...results[key]);
  }
  return all;
}

export async function registerLeftMenuPlacement(appUrl: string): Promise<void> {
  await callMethodSingle('placement.bind', {
    PLACEMENT: 'APPLICATION_LEFT_MENU',
    HANDLER: appUrl,
    LANG_ALL: {
      ru: { NAME: 'ОРК — Отчёты', GROUP_NAME: 'CRM' },
    },
  });
}
