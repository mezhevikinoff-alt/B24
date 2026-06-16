import React, { useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';
import {
  getUserList, getLeadsForMonth, getDealCategories, getDealsByLeadIds,
  resolveExcludedStatusIds,
} from '../api/bitrix';
import { getJoints, saveJoint } from '../api/backend';
import { getMonthRange, calcProcessingHours, formatDateRu } from '../utils/dates';
import { calcBaseFund, fmtMoney, fmtPct } from '../utils/calculations';
import type { BX24User, Lead, ConversionEntry, Pipeline } from '../types';

interface Props {
  year: number;
  month: number;
}

export function ConversionModule({ year, month }: Props) {
  const { allUsers, setAllUsers } = useApp();
  const [entries, setEntries] = useState<ConversionEntry[]>([]);
  const [excludedCount, setExcludedCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadStep, setLoadStep] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [editingJoint, setEditingJoint] = useState<string | null>(null);
  const [jointValue, setJointValue] = useState('');
  const [usersMap, setUsersMap] = useState<Record<string, BX24User>>({});
  const [bankruptcyCatIds, setBankruptcyCatIds] = useState<Set<string>>(new Set());

  const { from, to } = getMonthRange(year, month);

  useEffect(() => {
    setLoading(true);
    setError(null);
    (async () => {
      try {
        let users: BX24User[] = allUsers;
        if (users.length === 0) {
          setLoadStep('Загрузка сотрудников...');
          users = await getUserList();
          setAllUsers(users);
        }
        const uMap: Record<string, BX24User> = {};
        users.forEach((u) => { uMap[u.ID] = u; });
        setUsersMap(uMap);

        setLoadStep('Загрузка категорий сделок...');
        const categories = await getDealCategories().catch(() => []);
        const bankIds = new Set<string>();
        categories.forEach((c: { ID: string; NAME: string }) => {
          if (c.NAME.toLowerCase().includes('банкрот')) bankIds.add(c.ID);
        });
        setBankruptcyCatIds(bankIds);

        setLoadStep('Загрузка лидов...');
        const [allLeads, joints] = await Promise.all([
          getLeadsForMonth(from, to),
          getJoints(year, month),
        ]);

        const total = allLeads.length;
        setTotalCount(total);

        setLoadStep('Фильтрация статусов...');
        const excludedIds = await resolveExcludedStatusIds();
        const filteredLeads: Lead[] = allLeads.filter(
          (l: Lead) => !excludedIds.has(l.STATUS_ID),
        );
        setExcludedCount(total - filteredLeads.length);

        const convertedLeads: Lead[] = filteredLeads.filter(
          (l: Lead) => l.DATE_CONVERT && l.DATE_CONVERT.length > 0,
        );

        setLoadStep('Загрузка сделок...');
        const leadIds = convertedLeads.map((l) => l.ID);
        const deals = await getDealsByLeadIds(leadIds).catch(() => []);
        const dealByLead: Record<string, { ID: string; CATEGORY_ID: string }> = {};
        deals.forEach((d: { ID: string; LEAD_ID?: string; CATEGORY_ID: string }) => {
          if (d.LEAD_ID) dealByLead[d.LEAD_ID] = d;
        });

        setLoadStep('Расчёт конверсии...');
        const built: ConversionEntry[] = convertedLeads.map((lead) => {
          const deal = dealByLead[lead.ID];
          const catId = deal?.CATEGORY_ID || '0';
          const pipeline: Pipeline = bankIds.has(catId) ? 'bankruptcy' : 'sales';
          const hours = calcProcessingHours(lead.DATE_CREATE, lead.DATE_CONVERT!);
          const baseFund = calcBaseFund(pipeline, hours);
          const joint = joints[lead.ID];
          const hasJoint = !!joint?.secondManagerId;
          const primaryAmount = hasJoint ? baseFund * 0.7 : baseFund;
          const secondaryAmount = hasJoint ? baseFund * 0.3 : 0;

          return {
            lead,
            dealId: deal?.ID,
            pipeline,
            processingHours: hours,
            baseFund,
            primaryManagerId: lead.ASSIGNED_BY_ID,
            secondManagerId: joint?.secondManagerId,
            primaryAmount,
            secondaryAmount,
          };
        });

        setEntries(built);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [year, month, from, to, allUsers, setAllUsers]);

  const conversionRate = totalCount - excludedCount > 0
    ? entries.length / (totalCount - excludedCount)
    : 0;

  const handleSaveJoint = async (leadId: string) => {
    await saveJoint(year, month, leadId, jointValue || null);
    setEntries((prev) =>
      prev.map((e) => {
        if (e.lead.ID !== leadId) return e;
        const hasJoint = !!jointValue;
        return {
          ...e,
          secondManagerId: jointValue || undefined,
          primaryAmount: hasJoint ? e.baseFund * 0.7 : e.baseFund,
          secondaryAmount: hasJoint ? e.baseFund * 0.3 : 0,
        };
      }),
    );
    setEditingJoint(null);
    setJointValue('');
  };

  const userName = (id: string) => {
    const u = usersMap[id];
    if (!u) return `#${id}`;
    return `${u.LAST_NAME} ${u.NAME}`;
  };

  if (loading) return <LoadingView step={loadStep} />;
  if (error) return <ErrorView message={error} onRetry={() => { setError(null); setLoading(true); }} />;

  return (
    <div className="p-4">
      {/* Stats bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard label="Всего лидов" value={String(totalCount)} />
        <StatCard label="Отфильтровано" value={String(excludedCount)} sub="Дубль / СПАМ / Предложения" />
        <StatCard label="Конвертировано" value={String(entries.length)} />
        <StatCard
          label="Конверсия"
          value={fmtPct(conversionRate)}
          sub={`из ${totalCount - excludedCount} лидов`}
          highlight
        />
      </div>

      {/* Table */}
      <div className="table-scroll rounded-xl border border-gray-200 shadow-sm bg-white">
        <table className="text-sm border-collapse min-w-max w-full">
          <thead>
            <tr className="bg-gray-50">
              <th className="px-3 py-3 text-left border-b border-r border-gray-200 text-gray-600 font-semibold">ID</th>
              <th className="px-3 py-3 text-left border-b border-r border-gray-200 text-gray-600 font-semibold min-w-[140px]">Клиент</th>
              <th className="px-3 py-3 text-center border-b border-r border-gray-200 text-gray-600 font-semibold">Дата лида</th>
              <th className="px-3 py-3 text-center border-b border-r border-gray-200 text-gray-600 font-semibold">Дата конверсии</th>
              <th className="px-3 py-3 text-center border-b border-r border-gray-200 text-gray-600 font-semibold">Время обр., ч</th>
              <th className="px-3 py-3 text-center border-b border-r border-gray-200 text-gray-600 font-semibold">Воронка</th>
              <th className="px-3 py-3 text-left border-b border-r border-gray-200 text-gray-600 font-semibold min-w-[120px]">Основной</th>
              <th className="px-3 py-3 text-left border-b border-r border-gray-200 text-gray-600 font-semibold min-w-[120px]">Второй (30%)</th>
              <th className="px-3 py-3 text-center border-b border-r border-gray-200 text-gray-600 font-semibold">Базовый фонд</th>
              <th className="px-3 py-3 text-center border-b border-gray-200 text-gray-600 font-semibold">Основной / Второй</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const fast = entry.pipeline === 'sales' && entry.processingHours <= 18;
              const rowBg = entry.pipeline === 'bankruptcy'
                ? 'bg-purple-50'
                : fast ? 'bg-green-50' : 'bg-red-50';
              const timeBadge = entry.pipeline === 'bankruptcy'
                ? 'bg-purple-100 text-purple-800'
                : fast
                ? 'bg-green-100 text-green-800'
                : 'bg-red-100 text-red-800';
              const clientName = [entry.lead.LAST_NAME, entry.lead.NAME, entry.lead.SECOND_NAME]
                .filter(Boolean).join(' ') || entry.lead.TITLE || '—';

              return (
                <tr key={entry.lead.ID} className={`${rowBg} border-b border-gray-200 hover:brightness-95 transition-all`}>
                  <td className="px-3 py-2 text-gray-500 border-r border-gray-200 font-mono text-xs">
                    {entry.lead.ID}
                  </td>
                  <td className="px-3 py-2 text-gray-800 border-r border-gray-200 font-medium">
                    {clientName}
                  </td>
                  <td className="px-3 py-2 text-center text-gray-600 border-r border-gray-200 text-xs">
                    {formatDateRu(new Date(entry.lead.DATE_CREATE))}
                  </td>
                  <td className="px-3 py-2 text-center text-gray-600 border-r border-gray-200 text-xs">
                    {entry.lead.DATE_CONVERT ? formatDateRu(new Date(entry.lead.DATE_CONVERT)) : '—'}
                  </td>
                  <td className="px-3 py-2 text-center border-r border-gray-200">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${timeBadge}`}>
                      {entry.processingHours}ч
                    </span>
                  </td>
                  <td className="px-3 py-2 text-center border-r border-gray-200">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                      entry.pipeline === 'bankruptcy' ? 'bg-purple-200 text-purple-900' : 'bg-blue-100 text-blue-800'
                    }`}>
                      {entry.pipeline === 'bankruptcy' ? 'Банкротство' : 'Продажи'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-gray-800 border-r border-gray-200 text-xs">
                    {userName(entry.primaryManagerId)}
                  </td>
                  <td className="px-3 py-2 border-r border-gray-200">
                    {editingJoint === entry.lead.ID ? (
                      <div className="flex gap-1">
                        <select
                          className="border border-gray-300 rounded px-1 py-0.5 text-xs flex-1"
                          value={jointValue}
                          onChange={(e) => setJointValue(e.target.value)}
                        >
                          <option value="">— убрать</option>
                          {Object.values(usersMap)
                            .filter((u) => u.ID !== entry.primaryManagerId)
                            .map((u) => (
                              <option key={u.ID} value={u.ID}>
                                {u.LAST_NAME} {u.NAME}
                              </option>
                            ))}
                        </select>
                        <button
                          onClick={() => handleSaveJoint(entry.lead.ID)}
                          className="px-1 py-0.5 bg-green-600 text-white rounded text-xs"
                        >✓</button>
                        <button
                          onClick={() => { setEditingJoint(null); setJointValue(''); }}
                          className="px-1 py-0.5 bg-gray-400 text-white rounded text-xs"
                        >✕</button>
                      </div>
                    ) : (
                      <button
                        className="text-xs text-blue-600 hover:underline"
                        onClick={() => {
                          setEditingJoint(entry.lead.ID);
                          setJointValue(entry.secondManagerId || '');
                        }}
                      >
                        {entry.secondManagerId ? userName(entry.secondManagerId) : '+ добавить'}
                      </button>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center border-r border-gray-200 font-semibold text-gray-800">
                    {fmtMoney(entry.baseFund)}
                  </td>
                  <td className="px-3 py-2 text-center text-xs">
                    {entry.secondManagerId ? (
                      <span>
                        <span className="text-green-700 font-semibold">{fmtMoney(entry.primaryAmount)}</span>
                        {' / '}
                        <span className="text-orange-700 font-semibold">{fmtMoney(entry.secondaryAmount)}</span>
                      </span>
                    ) : (
                      <span className="text-green-700 font-semibold">{fmtMoney(entry.primaryAmount)}</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {entries.length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-8 text-center text-gray-400">
                  Нет конвертированных лидов за выбранный период
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Color legend */}
      <div className="flex gap-4 mt-3 text-xs text-gray-600">
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-green-200 inline-block" /> Продажи ≤ 18ч (300₽)</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-red-200 inline-block" /> Продажи &gt; 18ч (200₽)</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-purple-200 inline-block" /> Банкротство (200₽ фикс)</span>
      </div>
    </div>
  );
}

function LoadingView({ step }: { step: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-48 gap-3">
      <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
      <div className="text-gray-500 text-sm">{step || 'Загрузка...'}</div>
    </div>
  );
}

function ErrorView({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="p-8 text-center">
      <div className="text-red-500 text-4xl mb-3">⚠</div>
      <div className="text-red-700 font-semibold mb-2">Ошибка загрузки данных</div>
      <div className="text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg p-3 mb-4 text-left font-mono break-all max-w-lg mx-auto">
        {message}
      </div>
      <button
        onClick={onRetry}
        className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
      >
        Повторить
      </button>
    </div>
  );
}

function StatCard({
  label, value, sub, highlight,
}: {
  label: string; value: string; sub?: string; highlight?: boolean;
}) {
  return (
    <div className={`rounded-xl p-4 shadow-sm border ${highlight ? 'bg-blue-600 text-white border-blue-700' : 'bg-white text-gray-800 border-gray-200'}`}>
      <div className="text-xs font-medium opacity-70 mb-1">{label}</div>
      <div className="text-2xl font-bold">{value}</div>
      {sub && <div className="text-xs opacity-60 mt-1">{sub}</div>}
    </div>
  );
}
