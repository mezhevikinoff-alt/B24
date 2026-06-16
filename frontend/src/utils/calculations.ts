import { FUND_FAST, FUND_SLOW, FUND_BANKRUPTCY, THRESHOLD_HOURS } from './dates';

// Coefficient tables by conversion rate
// Keys represent upper bound (exclusive) of conversion rate
// The last entry covers > 0.25

interface CoeffEntry { maxRate: number; coeff: number }

const COEFF_200: CoeffEntry[] = [
  { maxRate: 0.20, coeff: 1.0 },
  { maxRate: 0.21, coeff: 1.6875 },
  { maxRate: 0.22, coeff: 1.7722 },
  { maxRate: 0.23, coeff: 1.8563 },
  { maxRate: 0.24, coeff: 1.9413 },
  { maxRate: 0.25, coeff: 2.025 },
  { maxRate: Infinity, coeff: 2.025 },
];

const COEFF_300: CoeffEntry[] = [
  { maxRate: 0.20, coeff: 1.0 },
  { maxRate: 0.21, coeff: 1.75 },
  { maxRate: 0.22, coeff: 1.838 },
  { maxRate: 0.23, coeff: 1.925 },
  { maxRate: 0.24, coeff: 2.013 },
  { maxRate: 0.25, coeff: 2.1 },
  { maxRate: Infinity, coeff: 2.1 },
];

export function getCoeff200(rate: number): number {
  for (const entry of COEFF_200) {
    if (rate <= entry.maxRate) return entry.coeff;
  }
  return 2.025;
}

export function getCoeff300(rate: number): number {
  for (const entry of COEFF_300) {
    if (rate <= entry.maxRate) return entry.coeff;
  }
  return 2.1;
}

export function calcBaseFund(pipeline: 'sales' | 'bankruptcy', processingHours: number): number {
  if (pipeline === 'bankruptcy') return FUND_BANKRUPTCY;
  return processingHours <= THRESHOLD_HOURS ? FUND_FAST : FUND_SLOW;
}

export function calcConversionRate(converted: number, totalFiltered: number): number {
  if (totalFiltered === 0) return 0;
  return converted / totalFiltered;
}

export function calcManagerSalary(
  hours: number,
  sales300Fund: number, // total 300-fund for manager
  sales200Fund: number, // total 200-fund for manager
  bankruptcyFund: number,
  conversionRate: number,
): {
  salaryBase: number;
  sales300Total: number;
  sales200Total: number;
  sales300Coeff: number;
  sales200Coeff: number;
  totalBonus: number;
  totalSalary: number;
} {
  const salaryBase = hours * 445;
  const coeff300 = getCoeff300(conversionRate);
  const coeff200 = getCoeff200(conversionRate);
  const sales300Total = sales300Fund * coeff300;
  const sales200Total = sales200Fund * coeff200;
  const totalBonus = sales300Total + sales200Total + bankruptcyFund;
  return {
    salaryBase,
    sales300Total,
    sales200Total,
    sales300Coeff: coeff300,
    sales200Coeff: coeff200,
    totalBonus,
    totalSalary: salaryBase + totalBonus,
  };
}

export function fmtMoney(n: number): string {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(n) + ' ₽';
}

export function fmtPct(n: number): string {
  return (n * 100).toFixed(1) + '%';
}
