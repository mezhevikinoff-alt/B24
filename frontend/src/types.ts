export interface BX24User {
  ID: string;
  NAME: string;
  LAST_NAME: string;
  SECOND_NAME?: string;
  IS_ADMIN?: boolean;
  UF_DEPARTMENT?: number[];
  ACTIVE?: boolean;
  EMAIL?: string;
  PERSONAL_PHOTO?: string;
}

export interface TimeRecord {
  userId: string;
  date: string; // YYYY-MM-DD
  duration: number; // seconds from Bitrix24
  hoursRaw: number; // raw hours
  hoursCapped: number; // capped at 10.5
}

export interface HourCorrection {
  [userId: string]: {
    [date: string]: number; // corrected hours
  };
}

export interface Lead {
  ID: string;
  TITLE: string;
  NAME?: string;
  LAST_NAME?: string;
  SECOND_NAME?: string;
  DATE_CREATE: string;
  DATE_CONVERT?: string | null;
  STATUS_ID: string;
  ASSIGNED_BY_ID: string;
  CATEGORY_ID?: string;
  OPPORTUNITY?: string;
  SOURCE_ID?: string;
}

export interface Deal {
  ID: string;
  TITLE: string;
  LEAD_ID?: string;
  CATEGORY_ID: string;
  DATE_CREATE: string;
  ASSIGNED_BY_ID: string;
}

export interface DealCategory {
  ID: string;
  NAME: string;
}

export type Pipeline = 'sales' | 'bankruptcy';

export interface JointWork {
  [leadId: string]: {
    secondManagerId: string;
  };
}

export interface ConversionEntry {
  lead: Lead;
  dealId?: string;
  pipeline: Pipeline;
  processingHours: number; // hours from creation to conversion
  baseFund: number; // 200 or 300
  primaryManagerId: string;
  secondManagerId?: string;
  primaryAmount: number; // fund × primaryShare
  secondaryAmount: number; // fund × secondaryShare
}

export interface ManagerMonth {
  userId: string;
  user: BX24User;
  // Schedule
  totalHours: number;
  totalDays: number;
  salaryBase: number; // hours × 445
  // Leads
  totalLeadsInWork: number;
  totalConverted: number;
  conversionRate: number;
  // Sales 300 (≤18h)
  sales300Count: number;
  sales300Fund: number;
  sales300Coeff: number;
  sales300Total: number;
  // Sales 200 (>18h)
  sales200Count: number;
  sales200Fund: number;
  sales200Coeff: number;
  sales200Total: number;
  // Bankruptcy
  bankruptcyCount: number;
  bankruptcyFund: number;
  // Summary
  totalBonus: number;
  totalSalary: number;
}
