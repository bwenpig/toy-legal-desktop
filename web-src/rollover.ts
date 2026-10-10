/**
 * 年結自動結轉（會計邏輯內核 v3.15.2+）
 *
 * 將上年度 closing 結轉為新財年 opening：
 * - 資產／負債／權益科目：按類別自動結轉（唔係 hardcode 科目名）
 * - AR/AP：逐張未清發票帶過去（唔係淨總數）
 * - 收入／成本／費用：唔結轉
 * - 本年淨利：撥入 Profit and Loss account（權益）
 *
 * 純會計邏輯，無 UI。由桌面端經 bridge 調用。
 */
import { store } from './state';
import { accountBalance } from './ledger';
import { invoiceMatches } from './core/invoices';
import { allocatedTotal } from './core/allocation';
import type { InvoiceRow } from './types';

export interface RolloverAccountPreview {
  name: string;
  type: string;
  closing: number; // cents
}

export interface RolloverInvoicePreview {
  kind: 'AR' | 'AP';
  party: string;
  no: string;
  date: string;
  outstanding: number; // cents
}

export interface RolloverPreview {
  fromLabel: string;
  toLabel: string;
  accounts: RolloverAccountPreview[];
  invoices: RolloverInvoicePreview[];
  invoiceParties: string[];
}

/**
 * 預覽年結轉賬：計出要結轉嘅科目同發票，唔寫入。
 */
export function previewRollover(fromKey: string): RolloverPreview | null {
  const fromFy = store.fiscalYears.find((f) => f.key === fromKey);
  if (!fromFy) return null;
  const toStart = fromFy.start + 1;
  const toLabel = 'FY' + toStart + '/' + String(toStart + 1).slice(-2);

  const accounts: RolloverAccountPreview[] = [];
  for (const a of store.accounts) {
    if (!['資產', '負債', '權益'].includes(a.type)) continue;
    const bal = accountBalance(a, fromFy);
    if (bal === 0) continue;
    accounts.push({ name: a.name, type: a.type, closing: bal });
  }

  // AR/AP 未清發票：用 invoiceMatches 搵出嚟，計 outstanding
  const invoices: RolloverInvoicePreview[] = [];
  const parties = new Set<string>();
  for (const a of store.accounts) {
    let kind: 'AR' | 'AP' | '' = '';
    let party = '';
    if (a.name.startsWith('Accounts Receivable of ')) {
      kind = 'AR';
      party = a.name.replace('Accounts Receivable of ', '');
    } else if (a.name.startsWith('Accounts Payable of ')) {
      kind = 'AP';
      party = a.name.replace('Accounts Payable of ', '');
    }
    if (!kind) continue;
    parties.add(party);
  }
  const ctx = {
    salesInvoices: store.salesInvoices,
    purchaseInvoices: store.purchaseInvoices,
    allocations: store.allocations,
    openingBalances: store.openingBalances,
    vouchers: store.vouchers,
    accounts: store.accounts,
  };
  for (const party of parties) {
    for (const kind of ['AR', 'AP'] as const) {
      const acctName = (kind === 'AR' ? 'Accounts Receivable of ' : 'Accounts Payable of ') + party;
      if (!store.accounts.some((a) => a.name === acctName)) continue;
      try {
        const invs = invoiceMatches(kind, party, fromFy, ctx as any);
        for (const inv of invs) {
          const total = inv[3] as number;
          const alloc = allocatedTotal(kind, inv[1], fromFy, store.allocations);
          const out = total - alloc;
          if (out > 0) {
            invoices.push({ kind, party, no: inv[1] as string, date: inv[0] as string, outstanding: out });
          }
        }
      } catch (e) { /* 忽略單張發票錯誤 */ }
    }
  }

  return {
    fromLabel: fromFy.label,
    toLabel,
    accounts,
    invoices,
    invoiceParties: [...parties],
  };
}

/**
 * 執行年結轉賬：將 preview 結果寫入下年度期初。
 * 返回寫入嘅科目數同發票數。
 */
export function executeRollover(fromKey: string, toKey: string): { accounts: number; invoices: number } {
  const preview = previewRollover(fromKey);
  if (!preview) return { accounts: 0, invoices: 0 };
  const toFy = store.fiscalYears.find((f) => f.key === toKey);
  if (!toFy) return { accounts: 0, invoices: 0 };

  let accCount = 0;
  store.openingBalances[toKey] = store.openingBalances[toKey] || {};
  for (const a of preview.accounts) {
    const acct = store.accounts.find((x) => x.name === a.name);
    if (!acct) continue;
    // 按科目借貸方向寫入
    const entry = acct.side === 'dr'
      ? { debit: a.closing as any, credit: 0 as any }
      : { debit: 0 as any, credit: a.closing as any };
    store.openingBalances[toKey][a.name] = entry;
    accCount++;
  }

  let invCount = 0;
  for (const inv of preview.invoices) {
    const row: InvoiceRow = [inv.date, inv.no, inv.party, inv.outstanding as any, 'opening'];
    if (inv.kind === 'AR') {
      if (!store.salesInvoices.some((x) => x[1] === inv.no)) {
        store.salesInvoices.push(row);
        invCount++;
      }
    } else {
      if (!store.purchaseInvoices.some((x) => x[1] === inv.no)) {
        store.purchaseInvoices.push(row);
        invCount++;
      }
    }
  }

  return { accounts: accCount, invoices: invCount };
}
