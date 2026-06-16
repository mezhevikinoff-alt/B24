import { getDaysInMonth, getDay, format, parseISO, differenceInHours } from 'date-fns';

// Russian federal holidays (non-working days)
// Format: MM-DD
const RUSSIAN_HOLIDAYS: string[] = [
  '01-01','01-02','01-03','01-04','01-05','01-06','01-07','01-08',
  '02-23',
  '03-08',
  '05-01','05-09',
  '06-12',
  '11-04',
  '12-31',
];

export function isWeekend(date: Date): boolean {
  const d = getDay(date); // 0=Sun, 6=Sat
  return d === 0 || d === 6;
}

export function isHoliday(date: Date): boolean {
  const key = format(date, 'MM-dd');
  return RUSSIAN_HOLIDAYS.includes(key);
}

export function isNonWorking(date: Date): boolean {
  return isWeekend(date) || isHoliday(date);
}

export function getDayType(date: Date): 'holiday' | 'weekend' | 'workday' {
  if (isHoliday(date)) return 'holiday';
  if (isWeekend(date)) return 'weekend';
  return 'workday';
}

export function getMonthDays(year: number, month: number): Date[] {
  const days: Date[] = [];
  const total = getDaysInMonth(new Date(year, month - 1, 1));
  for (let d = 1; d <= total; d++) {
    days.push(new Date(year, month - 1, d));
  }
  return days;
}

export function formatDate(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

export function formatDateRu(date: Date): string {
  return format(date, 'dd.MM.yyyy');
}

export function formatMonthRu(year: number, month: number): string {
  const months = [
    'Январь','Февраль','Март','Апрель','Май','Июнь',
    'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь',
  ];
  return `${months[month - 1]} ${year}`;
}

export function getMonthRange(year: number, month: number): { from: string; to: string } {
  const from = format(new Date(year, month - 1, 1), 'yyyy-MM-dd') + 'T00:00:00';
  const to = format(new Date(year, month, 1), 'yyyy-MM-dd') + 'T00:00:00';
  return { from, to };
}

export function calcProcessingHours(dateCreate: string, dateConvert: string): number {
  const start = parseISO(dateCreate);
  const end = parseISO(dateConvert);
  return Math.max(0, differenceInHours(end, start));
}

export const MAX_HOURS_PER_DAY = 10.5;
export const RATE_PER_HOUR = 445;
export const FUND_FAST = 300; // ≤ 18h
export const FUND_SLOW = 200; // > 18h
export const FUND_BANKRUPTCY = 200;
export const THRESHOLD_HOURS = 18;
export const PRIMARY_SHARE = 0.7;
export const SECONDARY_SHARE = 0.3;
