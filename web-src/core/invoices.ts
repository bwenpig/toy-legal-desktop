/**
 * 發票來源純函數 —— 零 DOM、零全域變量。
 * 由 lib/invoices.js 直轉，邏輯一字不改，只加型別；
 * 原版讀全域變量，此處全部改為顯式 ctx 參數。
 */
import type {
  Account,
  ARAPKind,
  CoreCtx,
  FiscalYear,
  InvoiceRow,
  OpeningEntry,
} from '../types';
import type { Cents } from '../money';
import { dateInFiscalYear } from './fiscal';
import { normalParty } from './party';

export function openingEntry(
  fy: FiscalYear,
  name: string,
  openingBalances: CoreCtx['openingBalances'],
): OpeningEntry {
  const rec = openingBalances[fy.key]?.[name];
  if (rec == null) return { debit: 0 as Cents, credit: 0 as Cents };
  // 純 number 為舊形狀；store 不變量係分，還原時已轉換（見 backup.ts）
  if (typeof rec === 'number') return { debit: rec as Cents, credit: 0 as Cents };
  return { debit: rec.debit, credit: rec.credit };
}

export function openingInvoiceRows(
  kind: ARAPKind,
  party: string,
  fy: FiscalYear,
  ctx: CoreCtx,
): InvoiceRow[] {
  const prefix = kind === 'AR' ? 'Accounts Receivable of ' : 'Accounts Payable of ';
  const target = normalParty(party);
  const storeMap = ctx.openingInvoiceDetails[fy.key] || {};
  return Object.entries(storeMap).flatMap(([accountName, items]): InvoiceRow[] => {
    if (!accountName.startsWith(prefix) || normalParty(accountName.slice(prefix.length)) !== target)
      return [];
    const entry = openingEntry(fy, accountName, ctx.openingBalances);
    const expected = kind === 'AR' ? entry.debit : entry.credit;
    const total = items.reduce((sum, item) => sum + item.amount, 0) as Cents;
    if (!items.length || expected !== total) return [];
    return items.map(
      (item): InvoiceRow => [item.date, item.invoiceNo, party, item.amount, 'opening'],
    );
  });
}

export function accountHasFiscalActivity(
  account: Account | undefined,
  fy: FiscalYear,
  ctx: CoreCtx,
): boolean {
  if (!account || !fy) return false;
  if (fy.start === 2023 && !ctx.deletedDataYears.has(fy.key) && account.importedBalance !== 0)
    return true;
  const opening = openingEntry(fy, account.name, ctx.openingBalances);
  if (opening.debit !== 0 || opening.credit !== 0) return true;
  return ctx.vouchers.some(
    (v) =>
      dateInFiscalYear(v.date, fy) &&
      v.lines.some(
        (line) => line.account === account.name && (line.debit || line.credit),
      ),
  );
}

export function voucherDerivedInvoices(kind: ARAPKind, fy: FiscalYear, ctx: CoreCtx): InvoiceRow[] {
  const isAR = kind === 'AR';
  const partyPrefix = isAR ? 'Accounts Receivable of ' : 'Accounts Payable of ';
  return ctx.vouchers
    .filter((v) => dateInFiscalYear(v.date, fy))
    .flatMap((v): InvoiceRow[] => {
      const hasCounterpart = v.lines.some((line) => {
        const account = ctx.accounts.find((a) => a.name === line.account);
        return (
          account &&
          accountHasFiscalActivity(account, fy, ctx) &&
          (isAR
            ? account.type === '收入' && /sales/i.test(account.name) && line.credit > 0
            : account.type === '成本' && /purchase/i.test(account.name) && line.debit > 0)
        );
      });
      if (!hasCounterpart) return [];
      return v.lines
        .filter(
          (line) =>
            line.account.startsWith(partyPrefix) && (isAR ? line.debit > 0 : line.credit > 0),
        )
        .map((line): InvoiceRow => {
          const match = String(line.detail || '').match(/inv#?\s*([a-z0-9-]+)/i);
          const invoiceNo = match ? match[0].replace(/#|\s/g, '').toUpperCase() : v.no;
          const party = line.account.slice(partyPrefix.length);
          const amount: Cents = isAR ? line.debit : line.credit;
          return [v.date, invoiceNo, party, amount, 'voucher', v.no, line.detail || ''];
        });
    });
}

export function invoiceMatches(
  kind: ARAPKind,
  party: string,
  fy: FiscalYear,
  ctx: CoreCtx,
): InvoiceRow[] {
  const source = kind === 'AR' ? ctx.salesInvoices : ctx.purchaseInvoices;
  const p = normalParty(party);
  // 注意：登記冊行是 4 元 tuple [日期, 發票號, 對方, 金額]，r[4]/r[5] 為 undefined；
  // 下游以此判別來源（undefined → '來源未提供'），故不做 remap，保持與原版一致。
  const base = (source as unknown as InvoiceRow[]).filter((r) => {
    const x = normalParty(r[2]);
    return dateInFiscalYear(r[0], fy) && (x === p || x.includes(p) || p.includes(x));
  }).concat(openingInvoiceRows(kind, party, fy, ctx));
  const known = new Set(base.map((r) => String(r[1] || '').trim().toLowerCase()));
  const derived = voucherDerivedInvoices(kind, fy, ctx).filter((r) => {
    const x = normalParty(r[2]);
    return (
      (x === p || x.includes(p) || p.includes(x)) &&
      !known.has(String(r[1] || '').trim().toLowerCase())
    );
  });
  return base.concat(derived).sort((a, b) => a[0].localeCompare(b[0]));
}
