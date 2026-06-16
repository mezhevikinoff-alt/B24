const BASE = '/api';

export async function getCorrections(year: number, month: number): Promise<Record<string, Record<string, number>>> {
  const r = await fetch(`${BASE}/corrections/${year}/${month}`);
  return r.json();
}

export async function saveCorrections(
  year: number,
  month: number,
  data: Record<string, Record<string, number>>,
): Promise<void> {
  await fetch(`${BASE}/corrections/${year}/${month}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function getJoints(year: number, month: number): Promise<Record<string, { secondManagerId: string }>> {
  const r = await fetch(`${BASE}/joints/${year}/${month}`);
  return r.json();
}

export async function saveJoint(
  year: number,
  month: number,
  leadId: string,
  secondManagerId: string | null,
): Promise<void> {
  await fetch(`${BASE}/joints/${year}/${month}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leadId, secondManagerId }),
  });
}
