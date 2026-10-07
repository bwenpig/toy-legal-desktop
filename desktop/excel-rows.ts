/**
 * 桌面版 Excel 匯出用的報表行數據。
 *
 * 鏡像 web-src/reports.ts `exportCSV()` 的起行邏輯（同一組 exported helpers、
 * 同一篩選語義），差別只在金額欄：CSV 用 `csvDollars()` 字串，
 * 呢度出美元數字（`cents / 100`），等 Excel 格保持為數值（`#,##0.00`）。
 *
 * 維護注意：如果 web 版 `exportCSV()` 的行結構有變，呢度要同步跟。
 * smoke test 會將 Excel 行數／總額同 CSV 內容對拍。
 */
import {
  store,
  dateInFiscalYear,
  invoiceMatches,
  allocatedTotal,
} from '../web-src/state';
import {
  reportTransactionRows,
  invoiceVoucherText,
  salesChannel,
} from '../web-src/reports';
import { fiscalAccounts, accountSignedBalance } from '../web-src/ledger';
import { salesChannels } from '../web-src/ui';
import type { Cents } from '../web-src/money';

export type ExcelCell = string | number;
export type ExcelRows = ExcelCell[][];

/** 分 → 美元數字（Excel 數值格用；沿用舊版 buildReportRows 語義）。 */
const dollars = (cents: Cents | number): number => (cents as number) / 100;

export function buildReportRows(key: string): ExcelRows {
  const prevReport = store.report;
  store.report = key;
  try {
    let rows: ExcelRows;
    if (key === 'sales' || key === 'purchase') {
      const isPurchase = key === 'purchase';
      const source = reportTransactionRows(isPurchase).filter(
        (r) =>
          (store.reportState.month === null ||
            r.date.slice(0, 7) === store.reportState.month.key) &&
          (!store.reportState.nameQuery ||
            String(r.name)
              .toLowerCase()
              .includes(store.reportState.nameQuery.toLowerCase())) &&
          (!store.reportState.invoiceQuery ||
            String(r.invoice)
              .toLowerCase()
              .includes(store.reportState.invoiceQuery.toLowerCase())),
      );
      rows = isPurchase
        ? [
            ['Date', 'Invoice number', 'Voucher Number', 'Name', 'Amount', 'Remark'],
            ...source.map(
              (r): ExcelCell[] => [
                r.date,
                r.invoice,
                r.voucherText,
                r.name,
                dollars(r.amount),
                r.remark,
              ],
            ),
          ]
        : [
            [
              'Channel',
              'Date',
              'Invoice number',
              'Voucher Number',
              'Name',
              'Amount',
              'Remark',
            ],
            ...source
              .sort(
                (a, b) =>
                  salesChannels.findIndex((c) => c.key === salesChannel(a)) -
                    salesChannels.findIndex((c) => c.key === salesChannel(b)) ||
                  a.name.localeCompare(b.name) ||
                  a.date.localeCompare(b.date),
              )
              .map(
                (r): ExcelCell[] => [
                  (salesChannels.find((c) => c.key === salesChannel(r)) || {})
                    .label || '',
                  r.date,
                  r.invoice,
                  r.voucherText,
                  r.name,
                  dollars(r.amount),
                  r.remark,
                ],
              ),
          ];
    } else if (key === 'ar' || key === 'ap') {
      const kind = key === 'ar' ? 'AR' : 'AP';
      const parties = store.accounts
        .filter((a) =>
          a.name.startsWith(
            key === 'ar'
              ? 'Accounts Receivable of '
              : 'Accounts Payable of ',
          ),
        )
        .map((a) => a.name.replace(/^Accounts (Receivable|Payable) of /, ''));
      const seenInv = new Set<string>();
      const source = parties
        .flatMap((p) => invoiceMatches(kind, p))
        .filter((r) => {
          const k = r[0] + '|' + String(r[1] || '').trim().toLowerCase();
          if (seenInv.has(k)) return false;
          seenInv.add(k);
          return true;
        });
      rows = [
        [
          'Date',
          'Invoice number',
          'Voucher Number',
          key === 'ar' ? 'Customer' : 'Supplier',
          'Invoice amount',
          'Paid',
          'Outstanding',
        ],
        ...source
          .filter(
            (r) =>
              (r[4] === 'opening' || dateInFiscalYear(r[0])) &&
              (store.reportState.month === null ||
                r[0].slice(0, 7) === store.reportState.month.key),
          )
          .map((r) => {
            const paid = allocatedTotal(kind, r[1]);
            return [
              r[0],
              r[1],
              invoiceVoucherText(kind, r[1], r[4]),
              r[2],
              dollars(r[3]),
              dollars(paid),
              dollars(Math.max(0, (r[3] as number) - (paid as number))),
            ] as ExcelCell[];
          }),
      ];
    } else if (key === 'journal') {
      rows = [
        ['Date', 'Voucher No.', 'Account', 'Particulars', 'Debit', 'Credit'],
        ...store.vouchers
          .filter(
            (v) =>
              dateInFiscalYear(v.date) &&
              (store.reportState.month === null ||
                v.date.slice(0, 7) === store.reportState.month.key),
          )
          .flatMap((v) =>
            v.lines.map((line, lineIndex) => ({
              date: v.date,
              no: v.no,
              account: line.account,
              particulars: line.detail || v.desc,
              debit: line.debit,
              credit: line.credit,
              lineIndex,
            })),
          )
          .sort(
            (a, b) =>
              a.date.localeCompare(b.date) ||
              a.no.localeCompare(b.no) ||
              a.lineIndex - b.lineIndex,
          )
          .map(
            (row): ExcelCell[] => [
              row.date,
              row.no,
              row.account,
              row.particulars,
              row.debit ? dollars(row.debit) : '',
              row.credit ? dollars(row.credit) : '',
            ],
          ),
      ];
    } else if (key === 'register') {
      rows = [
        [
          'Date',
          'Voucher',
          'Type',
          'Description',
          'Amount',
          'Made by',
          'Checked by',
          'Approved by',
        ],
        ...store.vouchers
          .filter(
            (v) =>
              dateInFiscalYear(v.date) &&
              (store.reportState.month === null ||
                v.date.slice(0, 7) === store.reportState.month.key),
          )
          .map(
            (v): ExcelCell[] => [
              v.date,
              v.no,
              v.type,
              v.desc,
              dollars(v.lines.reduce((s, l) => s + (l.debit as number), 0)),
              v.madeBy || '',
              v.checkedBy || '',
              v.approvedBy || '',
            ],
          ),
      ];
    } else {
      rows = [
        ['Account', 'Debit', 'Credit'],
        ...fiscalAccounts()
          .filter((a) => accountSignedBalance(a))
          .map((a) => {
            const signed = accountSignedBalance(a) as number;
            return [
              a.name,
              signed > 0 ? dollars(signed) : '',
              signed < 0 ? dollars(Math.abs(signed)) : '',
            ] as ExcelCell[];
          }),
      ];
    }
    return rows;
  } finally {
    store.report = prevReport;
  }
}
