const BASE = '/api';

async function safeJson<T>(r: Response): Promise<T> {
  const text = await r.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    if (text.includes('DOCTYPE') || text.includes('<html') || text.includes('<HTML')) {
      throw new Error('Сервер недоступен. Откройте приложение через портал Битрикс24.');
    }
    throw new Error(`Неверный ответ сервера (HTTP ${r.status}): ${text.slice(0, 100)}`);
  }
}

export async function getCorrections(
  year: number,
  month: number,
): Promise<Record<string, Record<string, number>>> {
  try {
    const r = await fetch(`${BASE}/corrections/${year}/${month}`);
    return await safeJson<Record<string, Record<string, number>>>(r);
  } catch {
    return {};
  }
}

export async function saveCorrections(
  year: number,
  month: number,
  data: Record<string, Record<string, number>>,
): Promise<void> {
  try {
    await fetch(`${BASE}/corrections/${year}/${month}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  } catch {
    // ignore save errors
  }
}

export async function getJoints(
  year: number,
  month: number,
): Promise<Record<string, { secondManagerId: string }>> {
  try {
    const r = await fetch(`${BASE}/joints/${year}/${month}`);
    return await safeJson<Record<string, { secondManagerId: string }>>(r);
  } catch {
    return {};
  }
}

export async function saveJoint(
  year: number,
  month: number,
  leadId: string,
  secondManagerId: string | null,
): Promise<void> {
  try {
    await fetch(`${BASE}/joints/${year}/${month}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadId, secondManagerId }),
    });
  } catch {
    // ignore save errors
  }
}
