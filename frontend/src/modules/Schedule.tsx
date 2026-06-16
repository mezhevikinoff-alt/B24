import React, { useEffect, useState, useCallback } from 'react';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';
import { useApp } from '../context/AppContext';
import { getUserList, getTimemanReport } from '../api/bitrix';
import { getCorrections, saveCorrections } from '../api/backend';
import { getMonthDays, formatDate, getDayType, MAX_HOURS_PER_DAY, RATE_PER_HOUR } from '../utils/dates';
import { fmtMoney } from '../utils/calculations';
import type { BX24User } from '../types';

interface Props {
  year: number;
  month: number;
}

type DayType = 'workday' | 'weekend' | 'holiday';

interface DayCell {
  date: Date;
  dayStr: string;
  type: DayType;
  hours: number; // final hours after cap + corrections
}

interface UserRow {
  user: BX24User;
  days: DayCell[];
  totalHours: number;
  totalDays: number;
  salary: number;
}

export function ScheduleModule({ year, month }: Props) {
  const { isAdmin, allUsers, setAllUsers } = useApp();
  const [rows, setRows] = useState<UserRow[]>([]);
  const [corrections, setCorrections] = useState<Record<string, Record<string, number>>>({});
  const [loading, setLoading] = useState(true);
  const [editCell, setEditCell] = useState<{ userId: string; dateStr: string } | null>(null);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);

  const days = getMonthDays(year, month);

  const buildRows = useCallback(
    (users: BX24User[], rawData: Record<string, Record<string, number>>, corr: Record<string, Record<string, number>>): UserRow[] => {
      return users.map((user) => {
        const userRaw = rawData[user.ID] || {};
        const userCorr = corr[user.ID] || {};
        let totalHours = 0;
        let totalDays = 0;

        const dayCells: DayCell[] = days.map((date) => {
          const dateStr = formatDate(date);
          const type = getDayType(date);
          let hours = 0;
          if (dateStr in userCorr) {
            hours = userCorr[dateStr];
          } else if (dateStr in userRaw) {
            hours = Math.min(userRaw[dateStr], MAX_HOURS_PER_DAY);
          }
          if (hours > 0) {
            totalHours += hours;
            totalDays += 1;
          }
          return { date, dayStr: dateStr, type, hours };
        });

        const salary = totalHours * RATE_PER_HOUR;
        return { user, days: dayCells, totalHours, totalDays, salary };
      });
    },
    [days],
  );

  useEffect(() => {
    setLoading(true);
    const dateFrom = `${year}-${String(month).padStart(2, '0')}-01T00:00:00`;
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    const dateTo = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01T00:00:00`;

    (async () => {
      let users: BX24User[] = allUsers;
      if (users.length === 0) {
        users = await getUserList();
        setAllUsers(users);
      }
      const userIds = users.map((u) => u.ID);
      const [timeData, corr] = await Promise.all([
        getTimemanReport(userIds, dateFrom, dateTo).catch(() => null),
        getCorrections(year, month),
      ]);
      setCorrections(corr);

      // Parse timeman report data
      // Expected: { USERS: { "userId": { REPORT: { "YYYY-MM-DD": { DURATION: seconds } } } } }
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

      setRows(buildRows(users, rawHours, corr));
      setLoading(false);
    })();
  }, [year, month, allUsers, setAllUsers, buildRows]);

  const handleCellClick = (userId: string, dateStr: string, currentHours: number) => {
    if (!isAdmin) return;
    setEditCell({ userId, dateStr });
    setEditValue(String(currentHours));
  };

  const handleSaveEdit = async () => {
    if (!editCell) return;
    setSaving(true);
    const val = parseFloat(editValue);
    const newCorr = {
      ...corrections,
      [editCell.userId]: {
        ...(corrections[editCell.userId] || {}),
        [editCell.dateStr]: isNaN(val) ? 0 : Math.min(val, MAX_HOURS_PER_DAY),
      },
    };
    await saveCorrections(year, month, newCorr);
    setCorrections(newCorr);
    // Rebuild rows from current raw data (need to re-fetch) — for now update locally
    setRows((prev) =>
      prev.map((row) => {
        if (row.user.ID !== editCell.userId) return row;
        const updDays = row.days.map((d) => {
          if (d.dayStr !== editCell.dateStr) return d;
          const h = isNaN(val) ? 0 : Math.min(val, MAX_HOURS_PER_DAY);
          return { ...d, hours: h };
        });
        const totalHours = updDays.reduce((s, d) => s + d.hours, 0);
        const totalDays = updDays.filter((d) => d.hours > 0).length;
        return { ...row, days: updDays, totalHours, totalDays, salary: totalHours * RATE_PER_HOUR };
      }),
    );
    setEditCell(null);
    setSaving(false);
  };

  const cellBg = (type: DayType, hours: number) => {
    if (type === 'holiday') return 'bg-blue-100 text-blue-800';
    if (type === 'weekend') return 'bg-gray-100 text-gray-500';
    if (hours >= MAX_HOURS_PER_DAY) return 'bg-green-200 text-green-900';
    if (hours > 0) return 'bg-green-50 text-green-800';
    return 'bg-white text-gray-400';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-500">
        Загрузка данных...
      </div>
    );
  }

  return (
    <div className="p-4">
      {/* Legend */}
      <div className="flex gap-4 mb-4 text-sm">
        <span className="flex items-center gap-1"><span className="w-4 h-4 rounded bg-green-200 inline-block" /> Рабочий день</span>
        <span className="flex items-center gap-1"><span className="w-4 h-4 rounded bg-gray-200 inline-block" /> Выходной</span>
        <span className="flex items-center gap-1"><span className="w-4 h-4 rounded bg-blue-200 inline-block" /> Праздник</span>
        {isAdmin && <span className="text-blue-600 ml-2">✏️ Нажмите на ячейку для редактирования</span>}
      </div>

      <div className="table-scroll rounded-xl border border-gray-200 shadow-sm bg-white">
        <table className="text-sm border-collapse min-w-max">
          <thead>
            <tr className="bg-gray-50">
              <th className="sticky left-0 bg-gray-50 px-3 py-2 text-left font-semibold text-gray-700 border-b border-r border-gray-200 min-w-[160px] z-10">
                Сотрудник
              </th>
              {days.map((date) => {
                const type = getDayType(date);
                const hdr =
                  type === 'holiday' ? 'bg-blue-50 text-blue-700' :
                  type === 'weekend' ? 'bg-gray-100 text-gray-500' :
                  'bg-gray-50 text-gray-700';
                return (
                  <th
                    key={formatDate(date)}
                    className={`px-1 py-2 text-center font-medium border-b border-r border-gray-200 min-w-[42px] ${hdr}`}
                  >
                    <div className="text-xs">{format(date, 'EE', { locale: ru }).slice(0, 2)}</div>
                    <div>{format(date, 'd')}</div>
                  </th>
                );
              })}
              <th className="px-3 py-2 text-center font-semibold text-gray-700 border-b border-r border-gray-200 bg-gray-50 min-w-[80px]">Часов</th>
              <th className="px-3 py-2 text-center font-semibold text-gray-700 border-b border-r border-gray-200 bg-gray-50 min-w-[60px]">Дней</th>
              <th className="px-3 py-2 text-center font-semibold text-gray-700 border-b border-gray-200 bg-gray-50 min-w-[120px]">Оклад (план)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.user.ID} className="hover:bg-gray-50 transition-colors">
                <td className="sticky left-0 bg-white px-3 py-2 font-medium text-gray-800 border-b border-r border-gray-200 z-10">
                  {row.user.LAST_NAME} {row.user.NAME}
                </td>
                {row.days.map((cell) => (
                  <td
                    key={cell.dayStr}
                    className={`px-1 py-2 text-center border-b border-r border-gray-200 text-xs font-medium transition-colors
                      ${cellBg(cell.type, cell.hours)}
                      ${isAdmin && cell.type === 'workday' ? 'cursor-pointer hover:ring-2 hover:ring-blue-400' : ''}
                    `}
                    title={isAdmin ? 'Нажмите для редактирования' : undefined}
                    onClick={() => isAdmin && cell.type === 'workday' && handleCellClick(row.user.ID, cell.dayStr, cell.hours)}
                  >
                    {cell.hours > 0 ? cell.hours.toFixed(1) : '—'}
                  </td>
                ))}
                <td className="px-3 py-2 text-center font-bold text-gray-800 border-b border-r border-gray-200">
                  {row.totalHours.toFixed(1)}
                </td>
                <td className="px-3 py-2 text-center text-gray-700 border-b border-r border-gray-200">
                  {row.totalDays}
                </td>
                <td className="px-3 py-2 text-center font-semibold text-green-700 border-b border-gray-200">
                  {fmtMoney(row.salary)}
                </td>
              </tr>
            ))}
            {/* Totals row */}
            {rows.length > 0 && (
              <tr className="bg-gray-100 font-bold">
                <td className="sticky left-0 bg-gray-100 px-3 py-2 text-gray-800 border-b border-r border-gray-200 z-10">
                  Итого по отделу
                </td>
                {days.map((date) => (
                  <td key={formatDate(date)} className="px-1 py-2 text-center text-xs text-gray-600 border-b border-r border-gray-200">
                    {rows.reduce((s, r) => {
                      const d = r.days.find((dd) => dd.dayStr === formatDate(date));
                      return s + (d?.hours || 0);
                    }, 0).toFixed(1).replace('.0', '') || '—'}
                  </td>
                ))}
                <td className="px-3 py-2 text-center text-gray-800 border-b border-r border-gray-200">
                  {rows.reduce((s, r) => s + r.totalHours, 0).toFixed(1)}
                </td>
                <td className="px-3 py-2 text-center text-gray-800 border-b border-r border-gray-200">
                  —
                </td>
                <td className="px-3 py-2 text-center text-green-700 border-b border-gray-200">
                  {fmtMoney(rows.reduce((s, r) => s + r.salary, 0))}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Edit modal */}
      {editCell && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 shadow-xl w-80">
            <h3 className="text-lg font-bold mb-1 text-gray-800">Корректировка часов</h3>
            <p className="text-sm text-gray-500 mb-4">
              {rows.find((r) => r.user.ID === editCell.userId)?.user.LAST_NAME}{' '}
              / {editCell.dateStr}
            </p>
            <input
              type="number"
              min={0}
              max={MAX_HOURS_PER_DAY}
              step={0.5}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-lg text-center mb-4 focus:outline-none focus:ring-2 focus:ring-blue-400"
              autoFocus
            />
            <div className="text-xs text-gray-400 mb-4 text-center">
              Максимум: {MAX_HOURS_PER_DAY} ч
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setEditCell(null)}
                className="flex-1 px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
              >
                Отмена
              </button>
              <button
                onClick={handleSaveEdit}
                disabled={saving}
                className="flex-1 px-4 py-2 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? 'Сохранение...' : 'Сохранить'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
