/**
 * 對銷純函數 —— 零 DOM、零全域變量。
 * 由 lib/allocation.js 直轉，邏輯一字不改，只加型別。
 *
 * 語義保留（與原版一致）：
 * - 原版直接 push 全域 allocations/allocationReview；此處改為回傳
 *   {newAllocations, reviews, needsReview}，由呼叫方決定寫入
 * - 同一張 voucher 內先處理的行所產生的對銷，後處理的行可見
 *   （原版靠即時 push 全域；此處用內部 workingAllocs 副本實現）
 * - fy 只算一次傳入（原版用 invoiceMatches(kind,party,fiscalYearForDate(v.date))，值相同）
 */
import type {
  Allocation,
  AllocationResult,
  AllocationReview,
  ARAPKind,
  CoreCtx,
  FiscalYear,
  OpeningInvoiceStatus,
  Voucher,
} from '../types';
import type { Cents } from '../money';
import { dateInFiscalYear, fiscalYearForDate } from './fiscal';
import { invoiceMatches, openingEntry } from './invoices';

export function allocatedTotal(
  kind: ARAPKind,
  invoiceNo: string,
  fy: FiscalYear,
  allocations: Allocation[],
): Cents {
  return allocations
    .filter((x) => x.kind === kind && x.invoiceNo === invoiceNo && dateInFiscalYear(x.date, fy))
    .reduce((s, x) => s + x.amount, 0) as Cents;
}

export function openingInvoiceStatus(
  accountName: string,
  fy: FiscalYear,
  ctx: CoreCtx,
  expectedOverride: Cents | null = null,
): OpeningInvoiceStatus {
  const items = (ctx.openingInvoiceDetails[fy.key] || {})[accountName] || [];
  const kind: ARAPKind | '' = accountName.startsWith('Accounts Receivable of ')
    ? 'AR'
    : accountName.startsWith('Accounts Payable of ')
      ? 'AP'
      : '';
  const entry = openingEntry(fy, accountName, ctx.openingBalances);
  const expected: Cents =
    expectedOverride === null ? (kind === 'AR' ? entry.debit : entry.credit) : expectedOverride;
  const total = items.reduce((sum, item) => sum + item.amount, 0) as Cents;
  const difference = (expected - total) as Cents;
  // 整數分：差 1 分都唔叫完成（舊版 Math.abs(difference)<0.005 已無需要）
  const state = !items.length ? 'unsplit' : difference === 0 ? 'complete' : 'pending';
  return { state, items, expected, total, difference };
}

export function applyAllocation(v: Voucher, ctx: CoreCtx): AllocationResult {
  const priorAllocs: Allocation[] = ctx.allocations || [];
  const newAllocations: Allocation[] = [];
  const reviews: AllocationReview[] = [];
  const workingAllocs: Allocation[] = priorAllocs.slice();
  let needsReview = false;
  const fy = fiscalYearForDate(v.date);
  v.lines.forEach((line) => {
    let kind: ARAPKind | '' = '';
    let amount = 0 as Cents;
    let party = '';
    if (line.account.startsWith('Accounts Receivable of ')) {
      kind = 'AR';
      amount = (line.credit - line.debit) as Cents;
      party = line.account.replace('Accounts Receivable of ', '');
    } else if (line.account.startsWith('Accounts Payable of ')) {
      kind = 'AP';
      amount = (line.debit - line.credit) as Cents;
      party = line.account.replace('Accounts Payable of ', '');
    }
    if (!kind || amount <= 0) return;
    const openingStatus = openingInvoiceStatus(line.account, fy, ctx);
    if (openingStatus.state === 'pending') {
      reviews.push({
        voucher: v.no,
        kind,
        party,
        amount,
        reason: '期初發票明細待完成，收／付款維持總額處理',
      });
      needsReview = true;
      return;
    }
    let invoices = invoiceMatches(kind, party, fy, ctx);
    let remaining: Cents = amount;
    if (v.allocationInvoice) {
      const target = invoices.find((r) => r[1] === v.allocationInvoice);
      if (!target) {
        reviews.push({
          voucher: v.no,
          kind,
          party,
          amount,
          reason: '指定發票號與此客戶／供應商不符',
        });
        needsReview = true;
        return;
      }
      invoices = [target];
    }
    for (const inv of invoices) {
      const available = Math.max(0, inv[3] - allocatedTotal(kind, inv[1], fy, workingAllocs)) as Cents;
      if (available <= 0) continue;
      const applied = Math.min(available, remaining) as Cents;
      const rec: Allocation = {
        kind,
        invoiceNo: inv[1],
        party: inv[2],
        date: v.date,
        amount: applied,
        voucher: v.no,
        source: v.allocationInvoice ? '指定發票' : 'FIFO',
      };
      newAllocations.push(rec);
      workingAllocs.push(rec);
      remaining = (remaining - applied) as Cents;
      if (remaining <= 0) break;
    }
    if (remaining > 0) {
      reviews.push({
        voucher: v.no,
        kind,
        party,
        amount: remaining,
        reason: v.allocationInvoice ? '指定發票結欠不足' : '找不到足夠未清發票',
      });
      needsReview = true;
    }
  });
  return { newAllocations, reviews, needsReview };
}
