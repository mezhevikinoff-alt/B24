import React, { useEffect, useState } from 'react';
import * as XLSX from 'xlsx';
import { useApp } from '../context/AppContext';
import {
  getUserList, getLeadsForMonth, getDealCategories, getDealsByLeadIds,
  getTimemanReport, EXCLUDE_STATUS_IDS_CONFIG,
} from '../api/bitrix';
import { getCorrections, getJoints } from '../api/backend';
import { getMonthRange, calcProcessingHours, formatMonthRu, MAX_HOURS_PER_DAY, RATE_PER_HOUR, formatDate, getMonthDays } from '../utils/dates';
import { calcBaseFund, calcManagerSalary, fmtMoney, fmtPct } from '../utils/calculations';
import type { BX24User, ManagerMonth } from '../types';

interface Props {
  year: number;
  month: number;
}

export function SummaryModule({ year, month }: Props) {
  const { allUsers, setAllUsers } = useApp();
  const [rows, setRows] = useState<ManagerMonth[]>([]);
  const [loading, setLoading] = useState(true);
  const [deptConvRate, setDeptConvRate] = useState(0);

  const { from, to } = getMonthRange(year, month);
  const days = getMonthDays(year, month);

  useEffect(() => {
    setLoading(true);
    (async () => {
      let users: BX24User[] = allUsers;
      if (users.length === 0) {
        users = await getUserList();
        setAllUsers(users);
      }
      const userIds = users.map((u) => u.ID);

      const [allLeads, timeData, corrections, joints, categories] = await Promise.all([
        getLeadsForMonth(from, to),
        getTimemanReport(userIds, from.slice(0, 10), to.slice(0, 10)).catch(() => null),
        getCorrections(year, month),
        getJoints(year, month),
        getDealCategories().catch(() => []),
      ]);

      // Pipeline identification
      const bankIds = new Set<string>();
      categories.forEach((c: { ID: string; NAME: string }) => {
        if (c.NAME.toLowerCase().includes('банкрот')) bankIds.add(c.ID);
      });

      // Filter leads
      const excluded = EXCLUDE_STATUS_IDS_CONFIG;
      const filtered = allLeads.filter((l: any) => !excluded.includes(l.STATUS_ID));
      const converted = filtered.filter((l: any) => l.DATE_CONVERT && l.DATE_CONVERT.length > 0);

      // Dept-level conversion rate
      const deptRate = filtered.length > 0 ? converted.length / filtered.length : 0;
      setDeptConvRate(deptRate);

      // Get deals for converted leads
      const convertedLeadIds = converted.map((l: any) => l.ID);
      const deals = await getDealsByLeadIds(convertedLeadIds).catch(() => []);
      const dealByLead: Record<string, { ID: string; CATEGORY_ID: string }> = {};
      deals.forEach((d: any) => { if (d.LEAD_ID) dealByLead[d.LEAD_ID] = d; });

      // Parse timeman
      const rawHours: Record<string, Record<string, number>> = {};
      if (timeData && typeof timeData === 'object') {
        const usersData = (timeData as any).USERS || (timeData as any).users || {};
        for (const uid in usersData) {
          rawHours[uid] = {};
          const report = usersData[uid].REPORT || usersData[uid].report || {};
          for (const dateStr in report) {
            const entry = report[dateStr];
            const seconds = entry.DURATION || entry.duration || entry.WORK_TIME || 0;
            rawHours[uid][dateStr] = seconds / 3600;
          }
        }
      }

      // Build per-manager stats
      const managerRows: ManagerMonth[] = users.map((user) => {
        // Hours
        const userRaw = rawHours[user.ID] || {};
        const userCorr = corrections[user.ID] || {};
        let totalHours = 0;
        let totalDays = 0;
        for (const date of days) {
          const dateStr = formatDate(date);
          let h = 0;
          if (dateStr in userCorr) {
            h = userCorr[dateStr];
          } else if (dateStr in userRaw) {
            h = Math.min(userRaw[dateStr], MAX_HOURS_PER_DAY);
          }
          if (h > 0) {
            totalHours += h;
            totalDays += 1;
          }
        }
        const salaryBase = totalHours * RATE_PER_HOUR;

        // Leads: count leads in work where this manager is primary or secondary
        const managerLeads = filtered.filter((l: any) => {
          if (l.ASSIGNED_BY_ID === user.ID) return true;
          const joint = joints[l.ID];
          return joint?.secondManagerId === user.ID;
        });
        const totalLeadsInWork = managerLeads.length;

        // Converted leads contributions
        let sales300Fund = 0;
        let sales300Count = 0;
        let sales200Fund = 0;
        let sales200Count = 0;
        let bankruptcyFund = 0;
        let bankruptcyCount = 0;
        let totalConverted = 0;

        for (const lead of converted as any[]) {
          const deal = dealByLead[lead.ID];
          const catId = deal?.CATEGORY_ID || '0';
          const pipeline = bankIds.has(catId) ? 'bankruptcy' : 'sales';
          const hours = calcProcessingHours(lead.DATE_CREATE, lead.DATE_CONVERT);
          const baseFund = calcBaseFund(pipeline, hours);
          const joint = joints[lead.ID];
          const hasJoint = !!joint?.secondManagerId;

          const isPrimary = lead.ASSIGNED_BY_ID === user.ID;
          const isSecondary = hasJoint && joint.secondManagerId === user.ID;

          if (!isPrimary && !isSecondary) continue;

          totalConverted++;
          const share = isPrimary ? (hasJoint ? 0.7 : 1.0) : 0.3;
          const amount = baseFund * share;

          if (pipeline === 'bankruptcy') {
            bankruptcyCount++;
            bankruptcyFund += amount;
          } else if (baseFund === 300) {
            sales300Count++;
            sales300Fund += amount;
          } else {
            sales200Count++;
            sales200Fund += amount;
          }
        }

        const conversionRate = totalLeadsInWork > 0 ? totalConverted / totalLeadsInWork : 0;
        const calc = calcManagerSalary(totalHours, sales300Fund, sales200Fund, bankruptcyFund, deptRate);

        return {
          userId: user.ID,
          user,
          totalHours,
          totalDays,
          salaryBase,
          totalLeadsInWork,
          totalConverted,
          conversionRate,
          sales300Count,
          sales300Fund,
          sales300Coeff: calc.sales300Coeff,
          sales300Total: calc.sales300Total,
          sales200Count,
          sales200Fund,
          sales200Coeff: calc.sales200Coeff,
          sales200Total: calc.sales200Total,
          bankruptcyCount,
          bankruptcyFund,
          totalBonus: calc.totalBonus,
          totalSalary: calc.totalSalary,
        };
      });

      setRows(managerRows);
      setLoading(false);
    })();
  }, [year, month, from, to, allUsers, setAllUsers, days]);

  const totals = rows.reduce(
    (acc, r) => ({
      totalHours: acc.totalHours + r.totalHours,
      totalDays: acc.totalDays + r.totalDays,
      salaryBase: acc.salaryBase + r.salaryBase,
      totalLeadsInWork: acc.totalLeadsInWork + r.totalLeadsInWork,
      totalConverted: acc.totalConverted + r.totalConverted,
      sales300Count: acc.sales300Count + r.sales300Count,
      sales300Total: acc.sales300Total + r.sales300Total,
      sales200Count: acc.sales200Count + r.sales200Count,
      sales200Total: acc.sales200Total + r.sales200Total,
      bankruptcyCount: acc.bankruptcyCount + r.bankruptcyCount,
      bankruptcyFund: acc.bankruptcyFund + r.bankruptcyFund,
      totalBonus: acc.totalBonus + r.totalBonus,
      totalSalary: acc.totalSalary + r.totalSalary,
    }),
    {
      totalHours: 0, totalDays: 0, salaryBase: 0,
      totalLeadsInWork: 0, totalConverted: 0,
      sales300Count: 0, sales300Total: 0,
      sales200Count: 0, sales200Total: 0,
      bankruptcyCount: 0, bankruptcyFund: 0,
      totalBonus: 0, totalSalary: 0,
    },
  );

  const handleExport = () => {
    const header = [
      'ФИО', 'Часов', 'Дней', 'Оклад (445₽/ч)',
      'Лидов в работе', 'Конверсия (%)',
      'Сделки ≤18ч (кол-во)', 'Сделки ≤18ч (сумма с коэф.)',
      'Коэф. 300₽',
      'Сделки >18ч (кол-во)', 'Сделки >18ч (сумма с коэф.)',
      'Коэф. 200₽',
      '% перевода до 18ч',
      'Банкротство (кол-во)', 'Банкротство (сумма)',
      'Итого премия', 'ИТОГО ЗП',
    ];
    const dataRows = rows.map((r) => [
      `${r.user.LAST_NAME} ${r.user.NAME}`,
      r.totalHours.toFixed(1),
      r.totalDays,
      r.salaryBase,
      r.totalLeadsInWork,
      (r.conversionRate * 100).toFixed(1) + '%',
      r.sales300Count,
      r.sales300Total.toFixed(0),
      r.sales300Coeff.toFixed(4),
      r.sales200Count,
      r.sales200Total.toFixed(0),
      r.sales200Coeff.toFixed(4),
      r.sales300Count + r.sales200Count > 0
        ? ((r.sales300Count / (r.sales300Count + r.sales200Count)) * 100).toFixed(1) + '%'
        : '—',
      r.bankruptcyCount,
      r.bankruptcyFund.toFixed(0),
      r.totalBonus.toFixed(0),
      r.totalSalary.toFixed(0),
    ]);
    const totalRow = [
      'ИТОГО ПО ОТДЕЛУ',
      totals.totalHours.toFixed(1),
      totals.totalDays,
      totals.salaryBase.toFixed(0),
      totals.totalLeadsInWork,
      fmtPct(deptConvRate),
      totals.sales300Count,
      totals.sales300Total.toFixed(0),
      '—',
      totals.sales200Count,
      totals.sales200Total.toFixed(0),
      '—',
      totals.sales300Count + totals.sales200Count > 0
        ? ((totals.sales300Count / (totals.sales300Count + totals.sales200Count)) * 100).toFixed(1) + '%'
        : '—',
      totals.bankruptcyCount,
      totals.bankruptcyFund.toFixed(0),
      totals.totalBonus.toFixed(0),
      totals.totalSalary.toFixed(0),
    ];

    const ws = XLSX.utils.aoa_to_sheet([header, ...dataRows, totalRow]);
    ws['!cols'] = header.map(() => ({ wch: 20 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Сводный отчёт');
    XLSX.writeFile(wb, `ORK_Отчёт_${formatMonthRu(year, month).replace(' ', '_')}.xlsx`);
  };

  if (loading) {
    return <div className="flex items-center justify-center h-48 text-gray-500">Загрузка...</div>;
  }

  const pctFast = (r: ManagerMonth) =>
    r.sales300Count + r.sales200Count > 0
      ? fmtPct(r.sales300Count / (r.sales300Count + r.sales200Count))
      : '—';

  return (
    <div className="p-4">
      {/* Header stats */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex gap-4 text-sm">
          <span className="bg-blue-50 text-blue-800 px-3 py-1.5 rounded-lg border border-blue-200 font-medium">
            Конверсия отдела: <strong>{fmtPct(deptConvRate)}</strong>
          </span>
        </div>
        <button
          onClick={handleExport}
          className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-xl hover:bg-green-700 font-semibold shadow-sm transition-colors"
        >
          <span>📊</span> Экспорт в Excel
        </button>
      </div>

      <div className="table-scroll rounded-xl border border-gray-200 shadow-sm bg-white">
        <table className="text-sm border-collapse min-w-max">
          <thead>
            <tr className="bg-gray-50 text-gray-600">
              <th className="px-3 py-3 text-left border-b border-r border-gray-200 font-semibold min-w-[150px]">ФИО</th>
              <th className="px-3 py-3 text-center border-b border-r border-gray-200 font-semibold">Часов / Дней</th>
              <th className="px-3 py-3 text-center border-b border-r border-gray-200 font-semibold">Оклад</th>
              <th className="px-3 py-3 text-center border-b border-r border-gray-200 font-semibold">Лидов</th>
              <th className="px-3 py-3 text-center border-b border-r border-gray-200 font-semibold">Конв. %</th>
              <th className="px-3 py-3 text-center border-b border-r border-gray-200 font-semibold bg-green-50">≤18ч / 300₽ (к-т×)</th>
              <th className="px-3 py-3 text-center border-b border-r border-gray-200 font-semibold bg-red-50">&gt;18ч / 200₽ (к-т×)</th>
              <th className="px-3 py-3 text-center border-b border-r border-gray-200 font-semibold">% до 18ч</th>
              <th className="px-3 py-3 text-center border-b border-r border-gray-200 font-semibold bg-purple-50">Банкротство</th>
              <th className="px-3 py-3 text-center border-b border-r border-gray-200 font-semibold">Премия</th>
              <th className="px-3 py-3 text-center border-b border-gray-200 font-bold text-gray-800 bg-yellow-50">ИТОГО ЗП</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.userId} className="border-b border-gray-200 hover:bg-gray-50 transition-colors">
                <td className="px-3 py-2 font-medium text-gray-800 border-r border-gray-200">
                  {r.user.LAST_NAME} {r.user.NAME}
                </td>
                <td className="px-3 py-2 text-center border-r border-gray-200 text-gray-700">
                  <span className="font-semibold">{r.totalHours.toFixed(1)}</span>
                  <span className="text-gray-400 text-xs"> / {r.totalDays}д</span>
                </td>
                <td className="px-3 py-2 text-center border-r border-gray-200 text-gray-700 font-medium">
                  {fmtMoney(r.salaryBase)}
                </td>
                <td className="px-3 py-2 text-center border-r border-gray-200">
                  <span className="font-semibold">{r.totalConverted}</span>
                  <span className="text-gray-400 text-xs"> / {r.totalLeadsInWork}</span>
                </td>
                <td className="px-3 py-2 text-center border-r border-gray-200">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                    r.conversionRate >= 0.25 ? 'bg-green-100 text-green-800' :
                    r.conversionRate >= 0.20 ? 'bg-yellow-100 text-yellow-800' :
                    'bg-red-100 text-red-800'
                  }`}>
                    {fmtPct(r.conversionRate)}
                  </span>
                </td>
                <td className="px-3 py-2 text-center border-r border-gray-200 bg-green-50">
                  <div className="font-semibold text-green-800">{r.sales300Count} шт.</div>
                  <div className="text-xs text-green-700">{fmtMoney(r.sales300Total)}</div>
                  <div className="text-xs text-gray-400">к-т {r.sales300Coeff.toFixed(4)}</div>
                </td>
                <td className="px-3 py-2 text-center border-r border-gray-200 bg-red-50">
                  <div className="font-semibold text-red-800">{r.sales200Count} шт.</div>
                  <div className="text-xs text-red-700">{fmtMoney(r.sales200Total)}</div>
                  <div className="text-xs text-gray-400">к-т {r.sales200Coeff.toFixed(4)}</div>
                </td>
                <td className="px-3 py-2 text-center border-r border-gray-200 text-gray-700">
                  {pctFast(r)}
                </td>
                <td className="px-3 py-2 text-center border-r border-gray-200 bg-purple-50">
                  <div className="font-semibold text-purple-800">{r.bankruptcyCount} шт.</div>
                  <div className="text-xs text-purple-700">{fmtMoney(r.bankruptcyFund)}</div>
                </td>
                <td className="px-3 py-2 text-center border-r border-gray-200 font-semibold text-blue-700">
                  {fmtMoney(r.totalBonus)}
                </td>
                <td className="px-3 py-2 text-center font-bold text-gray-900 bg-yellow-50 text-base">
                  {fmtMoney(r.totalSalary)}
                </td>
              </tr>
            ))}

            {/* Totals row */}
            <tr className="bg-gray-800 text-white font-bold">
              <td className="px-3 py-3 border-r border-gray-700">Итого по отделу</td>
              <td className="px-3 py-3 text-center border-r border-gray-700">
                {totals.totalHours.toFixed(1)} / {totals.totalDays}д
              </td>
              <td className="px-3 py-3 text-center border-r border-gray-700">
                {fmtMoney(totals.salaryBase)}
              </td>
              <td className="px-3 py-3 text-center border-r border-gray-700">
                {totals.totalConverted} / {totals.totalLeadsInWork}
              </td>
              <td className="px-3 py-3 text-center border-r border-gray-700">
                {fmtPct(deptConvRate)}
              </td>
              <td className="px-3 py-3 text-center border-r border-gray-700">
                <div>{totals.sales300Count} шт.</div>
                <div className="text-sm">{fmtMoney(totals.sales300Total)}</div>
              </td>
              <td className="px-3 py-3 text-center border-r border-gray-700">
                <div>{totals.sales200Count} шт.</div>
                <div className="text-sm">{fmtMoney(totals.sales200Total)}</div>
              </td>
              <td className="px-3 py-3 text-center border-r border-gray-700">
                {totals.sales300Count + totals.sales200Count > 0
                  ? fmtPct(totals.sales300Count / (totals.sales300Count + totals.sales200Count))
                  : '—'}
              </td>
              <td className="px-3 py-3 text-center border-r border-gray-700">
                <div>{totals.bankruptcyCount} шт.</div>
                <div className="text-sm">{fmtMoney(totals.bankruptcyFund)}</div>
              </td>
              <td className="px-3 py-3 text-center border-r border-gray-700">
                {fmtMoney(totals.totalBonus)}
              </td>
              <td className="px-3 py-3 text-center text-yellow-300 text-lg">
                {fmtMoney(totals.totalSalary)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
