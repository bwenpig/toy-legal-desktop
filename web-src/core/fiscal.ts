/**
 * 財年純函數 —— 零 DOM、零全域變量、零瀏覽器 API。
 * 由 lib/fiscal.js 直轉，邏輯一字不改，只加型別。
 */
import type { FiscalYear } from '../types';

export function makeFiscalYear(start: number | string): FiscalYear {
  const s = Number(start);
  return {
    start: s,
    key: String(start),
    label: `FY${start}/${String(s + 1).slice(-2)}`,
    from: `${start}-04-01`,
    to: `${s + 1}-03-31`,
  };
}

export function fiscalYearForDate(date: string): FiscalYear {
  const year = Number(String(date).slice(0, 4));
  const month = Number(String(date).slice(5, 7));
  return makeFiscalYear(month >= 4 ? year : year - 1);
}

export function dateInFiscalYear(date: string, fy: FiscalYear): boolean {
  return Boolean(date && fy && date >= fy.from && date <= fy.to);
}
