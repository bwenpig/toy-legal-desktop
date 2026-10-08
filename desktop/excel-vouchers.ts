/**
 * 桌面版 Voucher Excel 批量匯入。
 *
 * 流程：範本下載（glue 經 XLSX 寫檔）→ 用戶填寫 → glue 讀回 AOA →
 * parseVoucherImport(AOA) 逐行驗證＋分組 → 預覽＋錯誤清單 →
 * 用戶揀「只匯入有效」→ importVouchers(drafts) transaction 寫入。
 *
 * 欄位 spec（每行 = 一條分錄行；voucher 層欄位重複）：
 * | A 日期 Date | B Voucher No.（吉=自動編號） | C 類型 Type（B=銀行/T=轉賬） |
 * | D 摘要 Description | E 借方科目 Debit Account | F 借方金額 Debit Amount |
 * | G 貸方科目 Credit Account | H 貸方金額 Credit Amount | I 明細 Detail |
 * | J 製表 Made By | K 覆核 Checked By | L 批核 Approved By |
 *
 * 分組規則：按 B 欄 Voucher No. 分組；B 欄吉嘅行，按「連續＋(日期,類型,摘要)相同」
 * 併做一張 voucher（自動編號 B040124 格式：類型+MM+序號+年份）。
 * 金額一律經 toCents（字串解析，唔經 float）。
 */
import { store, applyAllocation } from '../web-src/state';
import { resolveAccount, applyVoucherBalance } from '../web-src/vouchers';
import { fiscalYearForDate } from '../web-src/core/fiscal';
import { toCents, fromCents } from '../web-src/money';
import type { Cents } from '../web-src/money';
import type { Voucher, VoucherLine } from '../web-src/types';
import {
  renderVoucherList,
  renderInvoiceNumberList,
} from '../web-src/vouchers';
import { renderLedger } from '../web-src/ledger';
import { renderReport, renderKPIs } from '../web-src/reports';
import { renderAccounts } from '../web-src/accounts';

export type ExcelCell = string | number;
export type ExcelRows = ExcelCell[][];

export const VOUCHER_TEMPLATE_HEADERS = [
  '日期 Date',
  'Voucher No.（吉=自動編號）',
  '類型 Type（B=銀行 / T=轉賬）',
  '摘要 Description',
  '借方科目 Debit Account',
  '借方金額 Debit Amount',
  '貸方科目 Credit Account',
  '貸方金額 Credit Amount',
  '明細 Detail',
  '製表 Made By',
  '覆核 Checked By',
  '批核 Approved By',
  '附件 Attachment（檔案路徑，多個用 ; 分隔）',
];

/** 範本 AOA（含「說明」＋「範本」兩個 sheet 嘅資料，由 glue 分別寫 sheet） */
export function buildVoucherTemplateHelp(): ExcelRows {
  return [
    ['Toys Gallery 會計系統 — Voucher 批量匯入說明（桌面版獨有）'],
    [''],
    ['1. 「範本」sheet 每行 = 一條分錄行；同一張 voucher 嘅行，B 欄填同一個 Voucher No.。'],
    ['2. B 欄吉唔填 = 自動編號（B040124 格式：類型+月份+序號+年份）；吉欄嘅行會按「連續＋日期／類型／摘要相同」自動併做一張 voucher。'],
    ['3. C 欄類型填 B（銀行）或 T（轉賬），也可填「銀行」／「轉賬」。'],
    ['4. 每行只可以填借方或貸方其中一邊；一張 voucher 嘅借方總額必須等於貸方總額。'],
    ['5. 科目填編號或名稱（必須已喺系統存在）。金額填美元數字（例如 1999.99）。'],
    ['6. 日期格式 YYYY-MM-DD，且必須屬於已喺系統開咗嘅財年。'],
    ['7. 製表／覆核／批核三個都要填（同系統入賬規則一致）。'],
    ['8. M 欄「附件」：填附件檔案路徑，多個用 ; 分隔。相對路徑以呢個 Excel 檔所在目錄為準。'],
    ['   例：receipt1.pdf;receipt2.jpg 或 /Users/xxx/Documents/invoice.pdf。匯入時自動讀檔存入數據庫。'],
    ['9. 第一行係標題列，請保留；下面嘅示例行請刪除後再填。'],
    ['10. 匯入時會逐行驗證，有錯嘅行會列出，可揀「只匯入有效行」。'],
  ];
}

export function buildVoucherTemplateExample(): ExcelRows {
  return [
    VOUCHER_TEMPLATE_HEADERS,
    // 示例 voucher 1：指定編號，兩行，有附件
    ['2024-04-05', 'B040124', 'B', '收到 Toy Hunters 貨款', 'Bank Saving Account', 5000, '', '', 'INV2024040026', '阿Bin', '阿May', '老闆', 'receipt1.pdf;receipt2.jpg'],
    ['2024-04-05', 'B040124', 'B', '收到 Toy Hunters 貨款', '', '', 'Accounts Receivable of Toy Hunters', 5000, 'INV2024040026', '阿Bin', '阿May', '老闆', ''],
    // 示例 voucher 2：吉編號（自動），兩行
    ['2024-04-06', '', 'T', '付供應商訂金', 'Prepayment to Supplier', 1200.5, '', '', '', '阿Bin', '阿May', '老闆', ''],
    ['2024-04-06', '', 'T', '付供應商訂金', '', '', 'Bank Saving Account', 1200.5, '', '阿Bin', '阿May', '老闆', ''],
  ];
}

export interface VoucherImportLine {
  account: string;
  debit: Cents;
  credit: Cents;
  detail: string;
}

export interface VoucherDraft {
  /** 分組 key（有編號用編號，否則 auto-N） */
  key: string;
  voucherNo: string; // 吉 = 待自動編號
  date: string;
  type: 'B' | 'T';
  desc: string;
  madeBy: string;
  checkedBy: string;
  approvedBy: string;
  lines: VoucherImportLine[];
  rowNums: number[]; // Excel 行號（1-based，含標題行）
  /** 附件檔案路徑（Excel 第 13 欄，; 分隔；匯入時由 glue 讀檔） */
  attachmentPaths: string[];
}

export interface RowError {
  rowNum: number;
  message: string;
}

export interface ParsedVoucherImport {
  drafts: VoucherDraft[];
  errors: RowError[];
  /** 無任何錯誤行嘅 draft（可匯入） */
  validDrafts: VoucherDraft[];
}

function cellStr(v: ExcelCell | undefined): string {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function normType(raw: string): 'B' | 'T' | null {
  const t = raw.trim().toLowerCase();
  if (t === 'b' || t === '銀行' || t === 'bank') return 'B';
  if (t === 't' || t === '轉賬' || t === '转账' || t === 'transfer') return 'T';
  return null;
}

function isValidDateStr(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** 自動編號：沿用 web 版 nextVoucherNumber 語義（類型+MM+序號2位+年份），避開 taken */
export function nextVoucherNumberFor(
  date: string,
  type: 'B' | 'T',
  taken: Set<string>,
): string {
  const yy = date.slice(2, 4);
  const mm = date.slice(5, 7);
  if (!/^\d{2}$/.test(yy) || !/^\d{2}$/.test(mm)) return '';
  const pattern = new RegExp('^' + type + mm + '(\\d{2})' + yy + '$', 'i');
  let max = 0;
  taken.forEach((no) => {
    const m = String(no).match(pattern);
    if (m) max = Math.max(max, Number(m[1]) || 0);
  });
  let seq = max + 1;
  let no = '';
  do {
    no = type + mm + String(seq++).padStart(2, '0') + yy;
  } while (taken.has(no.toLowerCase()));
  taken.add(no.toLowerCase());
  return no;
}

export function parseVoucherImport(allRows: ExcelRows): ParsedVoucherImport {
  const errors: RowError[] = [];
  const drafts: VoucherDraft[] = [];
  if (!allRows.length) return { drafts, errors, validDrafts: [] };

  // 搵標題行（頭 10 行內搵到「日期」＋「借方科目」）
  let hi = -1;
  for (let i = 0; i < Math.min(allRows.length, 10); i++) {
    const r = (allRows[i] || []).map(cellStr).join('|');
    if (/日期/.test(r) && /借方科目/.test(r)) {
      hi = i;
      break;
    }
  }
  if (hi < 0) {
    errors.push({ rowNum: 0, message: '搵唔到標題行（要有「日期」「借方科目」欄）。請用範本下載嘅檔案。' });
    return { drafts, errors, validDrafts: [] };
  }

  const fyKeys = new Set(store.fiscalYears.map((f) => f.key));
  const existingNos = new Set(store.vouchers.map((v) => String(v.no).toLowerCase()));
  const draftByKey = new Map<string, VoucherDraft>();
  let autoGroup = 0;

  const getDraft = (
    rowNum: number,
    voucherNo: string,
    date: string,
    type: 'B' | 'T',
    desc: string,
    madeBy: string,
    checkedBy: string,
    approvedBy: string,
    attachmentPaths: string[],
  ): VoucherDraft | null => {
    let key: string;
    if (voucherNo) {
      key = 'no:' + voucherNo.toLowerCase();
    } else {
      // 吉編號：同上一行「連續＋(日期,類型,摘要)相同」就併埋，否則開新組
      const prev = drafts[drafts.length - 1];
      if (
        prev &&
        !prev.voucherNo &&
        prev.date === date &&
        prev.type === type &&
        prev.desc === desc &&
        prev.rowNums[prev.rowNums.length - 1] === rowNum - 1
      ) {
        return prev;
      }
      autoGroup++;
      key = 'auto:' + autoGroup;
    }
    let d = draftByKey.get(key);
    if (!d) {
      d = {
        key, voucherNo, date, type, desc, madeBy, checkedBy, approvedBy,
        lines: [], rowNums: [], attachmentPaths: [...attachmentPaths],
      };
      draftByKey.set(key, d);
      drafts.push(d);
    } else {
      // 同一編號但 voucher 層欄位唔一致 → 記錯（用第一行嘅為準）
      if (d.date !== date || d.type !== type) {
        errors.push({ rowNum, message: '同一 Voucher No. 嘅日期／類型唔一致（' + d.date + '/' + d.type + ' vs ' + date + '/' + type + '）。' });
        return null;
      }
      // 合併附件路徑（去重）
      for (const p of attachmentPaths) {
        if (p && !d.attachmentPaths.includes(p)) d.attachmentPaths.push(p);
      }
    }
    return d;
  };

  for (let i = hi + 1; i < allRows.length; i++) {
    const rowNum = i + 1;
    const r = allRows[i] || [];
    if (r.every((c) => cellStr(c as ExcelCell) === '')) continue; // 吉行跳過
    const c = (idx: number) => cellStr(r[idx] as ExcelCell);
    const date = c(0), voucherNo = c(1), typeRaw = c(2), desc = c(3) || '—';
    const drAcctRaw = c(4), drAmtRaw = cellStr(r[5] as ExcelCell);
    const crAcctRaw = c(6), crAmtRaw = cellStr(r[7] as ExcelCell);
    const detail = c(8), madeBy = c(9), checkedBy = c(10), approvedBy = c(11);
    // 第 13 欄：附件路徑（; ／ ； ／換行分隔；相對路徑以 Excel 檔所在目錄為準）
    const attachmentPaths = c(12).split(/[;；\n\r]+/).map(s => s.trim()).filter(Boolean);
    let rowOk = true;
    const err = (msg: string) => { errors.push({ rowNum, message: msg }); rowOk = false; };

    if (!isValidDateStr(date)) { err('日期格式唔啱（要 YYYY-MM-DD）：' + (date || '（吉）')); continue; }
    const fyKey = fiscalYearForDate(date).key;
    if (!fyKeys.has(fyKey)) { err('日期 ' + date + ' 唔屬於任何已開立嘅財年，請先新增財年。'); continue; }
    const type = normType(typeRaw);
    if (!type) { err('類型唔啱（要 B=銀行 / T=轉賬）：' + (typeRaw || '（吉）')); continue; }
    if (voucherNo) {
      // 同一編號嘅行會併做一張 voucher（getDraft 按編號分組），所以呢度只驗系統已存在
      if (existingNos.has(voucherNo.toLowerCase())) err('Voucher No. 已存在：' + voucherNo);
    }
    if (!madeBy || !checkedBy || !approvedBy) err('製表／覆核／批核三個都要填（同系統入賬規則一致）。');

    // 金額：只可以填一邊
    const drAmt = drAmtRaw === '' ? (0 as Cents) : toCents(drAmtRaw);
    const crAmt = crAmtRaw === '' ? (0 as Cents) : toCents(crAmtRaw);
    const drFilled = drAmtRaw !== '' && drAmt > 0;
    const crFilled = crAmtRaw !== '' && crAmt > 0;
    if (drFilled && crFilled) err('一行只可以填借方或貸方其中一邊。');
    else if (!drFilled && !crFilled) err('請填借方或貸方金額（必須大於 0）。');
    if (drAmtRaw !== '' && drAmt <= 0) err('借方金額唔係有效正數：' + drAmtRaw);
    if (crAmtRaw !== '' && crAmt <= 0) err('貸方金額唔係有效正數：' + crAmtRaw);
    const acctRaw = drFilled ? drAcctRaw : crAcctRaw;
    const acct = resolveAccount(acctRaw);
    if (!acctRaw) err('請填' + (drFilled ? '借方' : '貸方') + '科目。');
    else if (!acct) err('科目唔存在：' + acctRaw + '（填編號或名稱，必須已喺系統存在）。');

    if (!rowOk) continue;
    const d = getDraft(rowNum, voucherNo, date, type as 'B' | 'T', desc, madeBy, checkedBy, approvedBy, attachmentPaths);
    if (!d) continue;
    d.lines.push({
      account: (acct as { name: string }).name,
      debit: drFilled ? drAmt : (0 as Cents),
      credit: crFilled ? crAmt : (0 as Cents),
      detail,
    });
    d.rowNums.push(rowNum);
  }

  // voucher 層驗證：借貸平衡
  const badDraftKeys = new Set<string>();
  errors.forEach((e) => {
    // 將行錯誤映射返去 draft（行號對應）
    for (const d of drafts) if (d.rowNums.includes(e.rowNum)) badDraftKeys.add(d.key);
  });
  for (const d of drafts) {
    const dr = d.lines.reduce((s, l) => s + (l.debit as number), 0);
    const cr = d.lines.reduce((s, l) => s + (l.credit as number), 0);
    if (d.lines.length === 0) {
      // 全行都有錯嘅 draft
      badDraftKeys.add(d.key);
      continue;
    }
    if (!(dr > 0 && dr === cr)) {
      const label = d.voucherNo || ('自動編號組（第 ' + d.rowNums[0] + ' 行起）');
      errors.push({ rowNum: d.rowNums[0], message: '借貸不平：借方 ' + fromCents(dr) + ' vs 貸方 ' + fromCents(cr) + '（' + label + '）。' });
      badDraftKeys.add(d.key);
    }
  }
  const validDrafts = drafts.filter((d) => !badDraftKeys.has(d.key) && d.lines.length > 0);
  return { drafts, errors, validDrafts };
}

export interface VoucherImportResult {
  imported: number;
  skipped: number;
  needsReview: number;
  voucherNos: string[];
}

/**
 * 匯入有效 draft：逐張起 voucher（沿用 app 入賬語義：過賬＋對銷＋人名＋render）。
 * 唔經 DOM，直接寫 store（同 postBtn handler 同等效果）。
 */
export function importVouchers(drafts: VoucherDraft[]): VoucherImportResult {
  const taken = new Set(store.vouchers.map((v) => String(v.no).toLowerCase()));
  const voucherNos: string[] = [];
  let needsReview = 0;

  for (const d of drafts) {
    const no = d.voucherNo || nextVoucherNumberFor(d.date, d.type, taken);
    if (!no) continue;
    const v: Voucher = {
      no,
      type: d.type,
      numberManual: Boolean(d.voucherNo),
      date: d.date,
      desc: d.desc,
      allocationInvoice: '',
      madeBy: d.madeBy,
      checkedBy: d.checkedBy,
      approvedBy: d.approvedBy,
      attachments: [],
      lines: d.lines.map((l): VoucherLine => ({
        account: l.account,
        debit: l.debit,
        credit: l.credit,
        detail: l.detail,
      })),
    };
    store.vouchers.push(v);
    applyVoucherBalance(v, 1);
    if (applyAllocation(v)) needsReview++;
    for (const name of [v.madeBy, v.checkedBy, v.approvedBy]) {
      if (name && !store.suppressedStaffNames.has(name)) store.staffNames.add(name);
    }
    try {
      store.lastVoucherDates[fiscalYearForDate(v.date).key] = v.date;
    } catch (e) { /* 財年一定存在（parse 已驗） */ }
    voucherNos.push(no);
  }

  // 同 postBtn 一樣重繪
  renderInvoiceNumberList();
  renderVoucherList();
  renderLedger();
  renderReport();
  renderAccounts();
  renderKPIs();

  return { imported: voucherNos.length, skipped: drafts.length - voucherNos.length, needsReview, voucherNos };
}
