/**
 * 金額以「分」整數存儲（方案2）。
 *
 * ============================================================
 * 四捨五入規則（全系統唯一規則，寫死喺度）：
 * 1. 內部一律整數分：一切加減（合計、對銷、結餘、差額）皆為整數運算，
 *    永不產生小數 → 「合計的分」恆等於「各分項分之和」，差 1 分都不可能。
 * 2. 四捨五入只發生在一個地方：用戶輸入字串 → toCents（第三位小數 half-up，
 *    即 10.005 → 1001 分；負數對稱，-10.005 → -1001 分）。
 * 3. 顯示（fromCents / formatMoney）對整數分是精確的，不做任何捨入。
 * 4. 舊數據（float 美元，如 v1 備份）還原時經 dollarsToCents 轉分：
 *    先經 String 還原十進制原意再按規則 2 處理（比 Math.round(x*100) 更準，
 *    例如 2.675 → 268 分而非 267 分），轉換會被記錄（見 backup.ts）。
 * ============================================================
 *
 * Cents 為 branded type：編譯期防止把「元」浮點數誤當「分」用。
 * 邊界只有三個：toCents（入）、fromCents／formatMoney（出）、
 * dollarsToCents（舊數據／demo 常數，一次性）。
 */

import type { BackupData, InvoiceRow, Voucher } from './types';

/** 整數分（branded number，運行時就是 number） */
export type Cents = number & { readonly __centsBrand: unique symbol };

/** 內部用：把已確保為整數的 number 標為 Cents */
const asCents = (n: number): Cents => n as Cents;

/**
 * 用戶輸入字串 → 分。絕對唔用 parseFloat(x)*100（19.99*100=1998.999…）。
 * 按字串 split '.' 處理：最多兩位小數，第三位起 half-up；負數對稱。
 * 非法／空字串 → 0（沿用舊 Number(x)||0 語義）。
 * 容忍千分位逗號、空白、HK$ 前綴；科學記數法等怪字串 fallback 舊 float 路徑。
 */
export function toCents(input: string | number | null | undefined): Cents {
  let s = String(input ?? '').trim().replace(/[,\s]/g, '');
  s = s.replace(/^(?:HK)?\$/i, '');
  if (!s) return asCents(0);
  let neg = false;
  if (s[0] === '-') { neg = true; s = s.slice(1); }
  else if (s[0] === '+') { s = s.slice(1); }
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m) {
    // 怪字串（科學記數法等）：沿用舊語義 Math.round(Number*100)，非法 → 0
    const f = Number(s);
    return asCents(Number.isFinite(f) ? Math.round(f * 100) : 0);
  }
  const intPart = m[1] || '0';
  let frac = m[2] || '';
  let roundUp = false;
  if (frac.length > 2) {
    roundUp = frac[2] >= '5'; // 第三位四捨五入（half-up）
    frac = frac.slice(0, 2);
  }
  frac = (frac + '00').slice(0, 2);
  let cents = parseInt(intPart, 10) * 100 + parseInt(frac, 10);
  if (roundUp) cents += 1;
  return asCents(neg ? -cents : cents);
}

/**
 * 美元浮點 → 分（經 String 還原十進制原意，精確）。
 * 只用於：demo 常數、BS/P&L 預設值、舊備份還原。
 * 精確的原因：JS 的 Number→String 保證 shortest round-trip，
 * 源碼字面量如 15564.22 轉字串必為 "15564.22"，再經 toCents 即精確。
 */
export function dollarsToCents(dollars: number): Cents {
  if (!Number.isFinite(dollars)) return asCents(0);
  return toCents(String(dollars));
}

/** 分 → "19.99"（精確，負數如 "-5.00"）。給輸入框回填用。 */
export function fromCents(cents: number): string {
  const c = Math.trunc(cents); // 防禦：確保整數
  const neg = c < 0;
  const abs = Math.abs(c);
  return (neg ? '-' : '') + Math.floor(abs / 100) + '.' + String(abs % 100).padStart(2, '0');
}

const groupThousands = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** 分 → 絕對值顯示 "1,234.56"（千分位＋兩位小數，與舊 fmt 一致） */
export function formatCentsAbs(cents: unknown): string {
  const c = Math.trunc(Number(cents) || 0);
  const abs = Math.abs(c);
  return groupThousands(String(Math.floor(abs / 100))) + '.' + String(abs % 100).padStart(2, '0');
}

/** 分 → 帶符號顯示 "-1,234.56"（與舊 signedFmt 一致） */
export function formatCentsSigned(cents: unknown): string {
  const c = Math.trunc(Number(cents) || 0);
  return (c < 0 ? '-' : '') + formatCentsAbs(c);
}

/** 分 → "HK$ 1,234.56"（與舊 money() 一致：'HK$ ' + signedFmt） */
export function formatMoney(cents: unknown): string {
  return 'HK$ ' + formatCentsSigned(cents);
}

/**
 * CSV 專用：還原舊版「JS 數字轉字串」格式（5000→"5000"，19.9→"19.9"），
 * 令下載內容與舊版一字不差。顯示專用，唔做計算。
 */
export function csvDollars(cents: number): string {
  return String(Math.trunc(cents) / 100);
}
/**
 * schemaVersion 決定（方案2）：
 * - v2（本版起）：金額一律整數分，直接可用。
 * - v1（舊版）：金額為美元浮點，還原時逐欄經 dollarsToCents 轉分
 *   （經字串還原十進制原意，比 Math.round(x*100) 更準；例如 2.675→268 分）。
 *   轉換欄數會被記錄並顯示於還原摘要，舊數據一個都唔會唔見。
 * 用版本號而唔用 heuristic 嗅探：明確、無歧義。
 */

/**
 * 舊版備份（schema v1，美元浮點）→ 整數分。逐欄經 dollarsToCents 轉換
 * （經字串還原十進制原意，比 Math.round(x*100) 更準；例如 2.675→268 分），
 * 回傳轉換欄數（記低轉換，顯示於還原摘要）。就地修改 data。
 */
export function convertLegacyMoneyToCents(data: BackupData): number{
  let n=0;
  const c=(v: unknown): Cents=>{n++;return dollarsToCents(Number(v)||0)};
  const voucherLines=(v: Voucher)=>v.lines.forEach(l=>{l.debit=c(l.debit);l.credit=c(l.credit)});
  data.vouchers.forEach(voucherLines);
  if(data.workingVoucher)voucherLines(data.workingVoucher);
  data.accounts.forEach(a=>{a.balance=c(a.balance);a.importedBalance=c(a.importedBalance)});
  const invoiceRow=(r: InvoiceRow)=>{r[3]=c(r[3])};
  (data.salesInvoices||[]).forEach(invoiceRow);
  (data.purchaseInvoices||[]).forEach(invoiceRow);
  (data.allocations||[]).forEach(x=>{x.amount=c(x.amount)});
  (data.allocationReview||[]).forEach(x=>{x.amount=c(x.amount)});
  Object.values(data.balanceAdjustments||{}).forEach(year=>{if(year)Object.keys(year).forEach(k=>{year[k]=c(year[k])})});
  Object.values(data.openingBalances||{}).forEach(year=>{if(!year)return;Object.keys(year).forEach(k=>{const e=year[k];if(typeof e==='number')year[k]={debit:c(e),credit:0 as Cents};else{e.debit=c(e.debit);e.credit=c(e.credit)}})});
  Object.values(data.openingInvoiceDetails||{}).forEach(year=>{if(!year)return;Object.values(year).forEach(items=>items.forEach(it=>{it.amount=c(it.amount)}))});
  Object.values(data.reconciliationConfirmations||{}).forEach(r=>{r.invoiceOutstanding=c(r.invoiceOutstanding);r.accountBalance=c(r.accountBalance);r.difference=c(r.difference)});
  return n;
}

