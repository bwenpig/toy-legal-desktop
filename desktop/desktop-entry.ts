/**
 * 桌面版 entry。
 *
 * 1. `import '../web-src/main'` —— 執行 web app 本體（DOM wiring＋首次 render），
 *    web-src 一字不改。
 * 2. 喺 `window.__TG__` 暴露桌面版橋接 API 俾 `tauri-glue.js` 用。
 *    全部函數都係由 web-src 模組直接 import 的真正實現，
 *    唔再靠字串抽取／surgical transplant。
 */
import '../web-src/main';

import { APP_VERSION } from '../web-src/version';
import { store, selectedFiscalYear, dateInFiscalYear } from '../web-src/state';
import { currentFiscalStart } from '../web-src/ui';
import { makeFiscalYear } from '../web-src/core/fiscal';
import {
  createBackupPayload,
  validateBackup,
  prepareRestore,
  applyPreparedRestore,
  renderRestoreModal,
  restoreModal,
  replaceArray,
  replaceObject,
  replaceSet,
} from '../web-src/backup';
import { reportBody, renderReport, renderKPIs } from '../web-src/reports';
import type { InvoiceRow } from '../web-src/types';
import { invoiceMatches } from '../web-src/core/invoices';
import { allocatedTotal } from '../web-src/core/allocation';
import { renderAccounts, sortAccounts } from '../web-src/accounts';
import { renderVoucherList, renderInvoiceNumberList, attachmentButtonHTML, bindAttachmentButtons, openAttachmentList, applyVoucherBalance, clearVoucherAllocations, createNewVoucher } from '../web-src/vouchers';
import { renderLedger, accountBalance } from '../web-src/ledger';
import { navigate, renderStaffNames } from '../web-src/ui';
import { dollarsToCents, toCents } from '../web-src/money';
import { previewRollover as corePreviewRollover, executeRollover as coreExecuteRollover } from '../web-src/rollover';
import type { RolloverPreview, RolloverAccountPreview, RolloverInvoicePreview } from '../web-src/rollover';
import type { Cents } from '../web-src/money';
import type {
  BackupData,
  BackupPayload,
  OpeningEntry,
} from '../web-src/types';
import { buildReportRows } from './excel-rows';
import { polishXlsx } from './xlsx-polish';
import {
  buildVoucherTemplateHelp,
  buildVoucherTemplateExample,
  parseVoucherImport,
  importVouchers,
  nextVoucherNumberFor,
} from './excel-vouchers';
import type { ParsedVoucherImport, VoucherImportResult } from './excel-vouchers';
import { buildVoucherExport } from './excel-export';
import type { VoucherExportResult } from './excel-export';
import type { NativeDownloadFn } from './shims/ui';

/** 報表 HTML（俾 Excel 匯出解析 P&L／BS 用；還原 store.report）。 */
function reportHTML(key: string): string {
  const prev = store.report;
  store.report = key;
  try {
    return reportBody();
  } finally {
    store.report = prev;
  }
}

/**
 * 空白賬套啟動（沿用舊 __tgBlankStart 語義：手動清 store＋render，
 * 唔經 applyPreparedRestore——後者喺零科目時會觸發 createNewVoucher 而炸）。
 */
function blankStart(): void {
  const fy = makeFiscalYear(currentFiscalStart);
  replaceArray(store.vouchers, []);
  replaceArray(store.accounts, []);
  replaceArray(store.salesInvoices, []);
  replaceArray(store.purchaseInvoices, []);
  replaceObject(store.invoiceRemarks as unknown as Record<string, unknown>, {});
  replaceArray(store.allocations, []);
  replaceArray(store.allocationReview, []);
  replaceObject(store.balanceAdjustments as unknown as Record<string, unknown>, {});
  replaceObject(store.openingBalances as unknown as Record<string, unknown>, {});
  replaceObject(store.openingInvoiceDetails as unknown as Record<string, unknown>, {});
  replaceObject(store.reconciliationConfirmations as unknown as Record<string, unknown>, {});
  replaceSet(store.deletedDataYears, []);
  replaceSet(store.staffNames, []);
  replaceSet(store.suppressedStaffNames, []);
  replaceObject(store.lastVoucherDates as unknown as Record<string, unknown>, {});
  replaceObject(store.reportState as unknown as Record<string, unknown>, {
    month: null, date: '', nameQuery: '', invoiceQuery: '',
  });
  store.fiscalYears = [fy];
  store.selectedFiscalKey = fy.key;
  store.report = 'trial';
  store.editingIndex = null;
  navigate('dashboard');
  renderInvoiceNumberList();
  renderVoucherList();
  renderLedger();
  renderReport();
  renderAccounts();
  renderKPIs();
  renderStaffNames();
}

/** JSON 備份還原入口（桌面版 dialog 揀檔後調用；沿用 app 雙重確認 modal）。 */
async function beginRestore(
  payload: BackupPayload,
  fileName: string,
): Promise<void> {
  const { prepared, legacyConverted } = await prepareRestore(payload);
  store.pendingRestore = { fileName, payload, prepared, legacyConverted };
  store.restoreStep = 1;
  renderRestoreModal();
  restoreModal.hidden = false;
  (document.getElementById('confirmRestore') as HTMLButtonElement).focus();
}

export interface ExcelImportAccount {
  code: string;
  name: string;
  type: string;
}
export interface ExcelImportOpening {
  fy: string;
  account: string;
  amount: number;
}
export interface ExcelImportInvoice {
  fy: string;
  party: string;
  no: string;
  date: string;
  amount: number;
  kind: string; // AR / AP
}
export interface ExcelImportResult {
  addedAccounts: number;
  skippedAccounts: number;
  setOpening: number;
  openingErrors: number;
  setInvoices: number;
  invoiceErrors: number;
  /** 每個客發票總數同期初數唔啱嘅描述 */
  invoiceMismatch: string[];
}

/**
 * Excel 匯入：科目表＋期初數（桌面版獨有功能）。
 * 金額由 Excel 美元數字經 `dollarsToCents` 轉分；期初按科目借貸方向
 * 寫入 `{debit, credit}`（舊版直存 plain number 語義含糊，新版明確）。
 */
function importExcelData(imp: {
  accounts?: ExcelImportAccount[];
  opening?: ExcelImportOpening[];
  invoices?: ExcelImportInvoice[];
}): ExcelImportResult {
  let addedAccounts = 0;
  let skippedAccounts = 0;
  const have = new Set(store.accounts.map((a) => String(a.code).toLowerCase()));
  for (const a of imp.accounts || []) {
    const code = String(a.code || '').trim();
    const name = String(a.name || '').trim();
    const type = String(a.type || '').trim();
    if (
      !code ||
      !name ||
      !['資產', '負債', '權益', '收入', '成本', '費用'].includes(type)
    ) {
      continue;
    }
    if (have.has(code.toLowerCase())) {
      skippedAccounts++;
      continue;
    }
    store.accounts.push({
      code,
      name,
      type,
      balance: 0 as Cents,
      importedBalance: 0 as Cents,
      side: type === '資產' || type === '費用' || type === '成本' ? 'dr' : 'cr',
      custom: true,
      createdFiscalKey: store.selectedFiscalKey,
    });
    have.add(code.toLowerCase());
    addedAccounts++;
  }
  sortAccounts();

  let setOpening = 0;
  let openingErrors = 0;
  for (const r of imp.opening || []) {
    const fy = store.fiscalYears.find((f) => f.key === String(r.fy));
    const acct = fy && store.accounts.find((a) => a.name === String(r.account));
    if (!fy || !acct || !Number.isFinite(Number(r.amount))) {
      openingErrors++;
      continue;
    }
    const cents = dollarsToCents(Number(r.amount));
    const entry: OpeningEntry =
      acct.side === 'dr'
        ? { debit: cents, credit: 0 as Cents }
        : { debit: 0 as Cents, credit: cents };
    store.openingBalances[fy.key] = store.openingBalances[fy.key] || {};
    store.openingBalances[fy.key][String(r.account)] = entry;
    setOpening++;
  }

  // 期初發票：寫入 salesInvoices / purchaseInvoices（來源='opening'）
  let setInvoices = 0;
  let invoiceErrors = 0;
  const invoiceTotals = new Map<string, number>(); // key: fy|kind|party → 總分
  for (const inv of imp.invoices || []) {
    const fyKey = String(inv.fy || '').trim();
    const party = String(inv.party || '').trim();
    const no = String(inv.no || '').trim();
    const date = String(inv.date || '').trim();
    const kind = String(inv.kind || '').trim().toUpperCase();
    const amount = Number(inv.amount);
    const fy = store.fiscalYears.find((f) => f.key === fyKey);
    if (!fy || !party || !no || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(amount) || amount <= 0 || (kind !== 'AR' && kind !== 'AP')) {
      invoiceErrors++;
      continue;
    }
    const cents = dollarsToCents(amount);
    const row: InvoiceRow = [date, no, party, cents, 'opening'];
    if (kind === 'AR') {
      // 去重：同財年同發票號跳過
      if (!store.salesInvoices.some((x) => x[1] === no)) {
        store.salesInvoices.push(row);
        setInvoices++;
      }
    } else {
      if (!store.purchaseInvoices.some((x) => x[1] === no)) {
        store.purchaseInvoices.push(row);
        setInvoices++;
      }
    }
    const tkey = fyKey + '|' + kind + '|' + party;
    invoiceTotals.set(tkey, (invoiceTotals.get(tkey) || 0) + cents);
  }

  // 校驗：每個客嘅發票總數要等於期初數
  const invoiceMismatch: string[] = [];
  for (const [tkey, total] of invoiceTotals) {
    const [fyKey, kind, party] = tkey.split('|');
    const acctName = (kind === 'AR' ? 'Accounts Receivable of ' : 'Accounts Payable of ') + party;
    const obRaw = store.openingBalances[fyKey] && store.openingBalances[fyKey][acctName];
    if (!obRaw) {
      invoiceMismatch.push(party + '（無期初數）');
      continue;
    }
    const ob = obRaw as { debit?: number; credit?: number };
    const obCents = (ob.debit || 0) + (ob.credit || 0);
    if (Math.abs(obCents - total) > 0) {
      invoiceMismatch.push(party + '（發票 ' + (total / 100).toFixed(2) + ' vs 期初 ' + (obCents / 100).toFixed(2) + '）');
    }
  }

  renderAccounts();
  renderReport();
  renderKPIs();
  return { addedAccounts, skippedAccounts, setOpening, openingErrors, setInvoices, invoiceErrors, invoiceMismatch };
}

/* ---------- 年結自動結轉（v3.26.0 桌面首發，v3.15.2 起搬入內核） ----------
 * 會計邏輯喺 web-src/rollover.ts（內核），呢度只係薄 wrapper＋UI refresh。
 * previewRollover(fromKey): 計出上年 closing，預覽下年 opening
 * executeRollover(fromKey, toKey): 寫入下年期初數＋期初發票
 */
// Rollover interfaces 由內核（web-src/rollover.ts）提供，此處 re-export 俾 bridge 用
export type { RolloverPreview, RolloverAccountPreview, RolloverInvoicePreview };

// 年結轉賬：會計邏輯喺內核（web-src/rollover.ts），呢度係薄 wrapper（加 UI refresh）
export function previewRollover(fromKey: string): RolloverPreview | null {
  return corePreviewRollover(fromKey);
}

export function executeRollover(fromKey: string, toKey: string): { accounts: number; invoices: number } {
  const res = coreExecuteRollover(fromKey, toKey);
  // UI refresh（桌面端職責）
  renderAccounts();
  renderReport();
  renderKPIs();
  return res;
}

declare global {
  interface Window {
    __TG__?: unknown;
  }
}

export interface DesktopBridge {
  desktopVersion: string;
  coreVersion: string;
  createBackupPayload: typeof createBackupPayload;
  validateBackup: typeof validateBackup;
  prepareRestore: typeof prepareRestore;
  applyPreparedRestore: typeof applyPreparedRestore;
  buildReportRows: typeof buildReportRows;
  reportHTML: typeof reportHTML;
  blankStart: typeof blankStart;
  beginRestore: typeof beginRestore;
  importExcelData: typeof importExcelData;
  fiscalLabel: () => string;
  setNativeDownload: (fn: NativeDownloadFn) => void;
  toCents: typeof toCents;
  /** xlsx 後期加工（凍結窗格／列印標題／標題加粗），JSZip 由呼叫方傳入 */
  polishWorkbook: (
    xlsxBytes: Uint8Array,
    sheets: { name: string; freezeRows: number; titleRows?: string; boldRows?: number[] }[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    JSZip: any,
  ) => Promise<Uint8Array>;
  /** Voucher Excel 匯入：範本／解析驗證／匯入 */
  buildVoucherTemplateHelp: typeof buildVoucherTemplateHelp;
  buildVoucherTemplateExample: typeof buildVoucherTemplateExample;
  parseVoucherImport: (rows: (string | number)[][]) => ParsedVoucherImport;
  importVouchers: typeof importVouchers;
  renderVoucherList: typeof renderVoucherList;
  /** 年結自動結轉（v3.26.0） */
  previewRollover: typeof previewRollover;
  executeRollover: typeof executeRollover;
  /** 刪除 voucher 前嘅資訊（確認 dialog 用）；搵唔到回 null */
  getVoucherDeleteInfo: (no: string) => {
    no: string; date: string; type: string; desc: string;
    amountCents: number; attachmentCount: number; allocationCount: number;
  } | null;
  /** 按編號攞 voucher 全量 JSON（操作日誌 before/after 用）；搵唔到回 null */
  getVoucher: (no: string) => unknown | null;
  /** 刪除 voucher：反過賬＋清對銷＋移除＋重繪；回傳已刪除快照（audit 用），搵唔到回 null */
  deleteVoucher: (no: string) => unknown | null;
  attachmentButtonHTML: typeof attachmentButtonHTML;
  bindAttachmentButtons: typeof bindAttachmentButtons;
  getAccountNames: () => string[];
  openAttachmentList: typeof openAttachmentList;
  nextVoucherNumberFor: typeof nextVoucherNumberFor;
  /** 待匯入 voucher（MCP）匯入後補附件 */
  setVoucherAttachments: (no: string, atts: { name: string; mime: string; dataURL: string }[]) => boolean;
  /** Voucher Excel 匯出（俾會計師） */
  buildVoucherExport: typeof buildVoucherExport;
  /** 財年清單（匯出範圍 dialog 用） */
  fiscalYears: () => { key: string; label: string; from: string; to: string }[];
  selectedFiscalKey: () => string;
  /** 報表月份標籤（''=全年，否則 'YYYY-MM'），xlsx 標題用 */
  reportPeriodLabel: () => string;
  getJournalVouchers: () => Array<{ no: string; attachments: Array<{ name: string; dataURL?: string; dataB64?: string; mime?: string }> }>;
}

/** 桌面版 bridge（tauri-glue.js 經呢度攞 app 功能）。 */
const bridge: DesktopBridge = {
  desktopVersion: '3.26.4',
  coreVersion: APP_VERSION,
  createBackupPayload,
  validateBackup,
  prepareRestore,
  applyPreparedRestore,
  buildReportRows,
  reportHTML,
  blankStart,
  beginRestore,
  importExcelData,
  fiscalLabel: () => selectedFiscalYear().label,
  setNativeDownload: (fn: NativeDownloadFn) => {
    window.__tgNativeDownload = fn;
  },
  toCents,
  polishWorkbook: (bytes, sheets, JSZip) => polishXlsx(bytes, sheets, JSZip),
  buildVoucherTemplateHelp,
  buildVoucherTemplateExample,
  parseVoucherImport,
  importVouchers,
  nextVoucherNumberFor,
  renderVoucherList,
  previewRollover,
  executeRollover,
  /** v3.25.2：按編號攞 voucher（操作日誌用） */
  getVoucher: (no: string) => {
    const v = store.vouchers.find((x) => x.no === no);
    return v ? JSON.parse(JSON.stringify(v)) : null;
  },
  /** v3.25.2：刪除 voucher 前嘅資訊（確認 dialog 用） */
  getVoucherDeleteInfo: (no: string) => {
    const v = store.vouchers.find((x) => x.no === no);
    if (!v) return null;
    return {
      no: v.no,
      date: v.date,
      type: v.type,
      desc: v.desc,
      amountCents: v.lines.reduce((s, l) => s + l.debit, 0),
      attachmentCount: (v.attachments || []).length,
      allocationCount: store.allocations.filter((a) => a.voucher === no).length,
    };
  },
  /** v3.25.2：刪除 voucher——反過賬＋清對銷＋移除＋重繪；回傳快照（audit 用） */
  deleteVoucher: (no: string) => {
    const idx = store.vouchers.findIndex((x) => x.no === no);
    if (idx < 0) return null;
    const v = store.vouchers[idx];
    applyVoucherBalance(v, -1); // 反過賬：沖銷呢張單對試算表嘅影響
    clearVoucherAllocations(v.no); // 對銷回滾：發票恢復 outstanding
    const snapshot = JSON.parse(JSON.stringify(v));
    const wasEditing = store.editingIndex === idx;
    store.vouchers.splice(idx, 1);
    if (wasEditing) {
      createNewVoucher(); // 刪緊而家編輯緊嗰張：表單重置為新單
    } else if (store.editingIndex !== null && store.editingIndex > idx) {
      store.editingIndex--;
    }
    try {
      (document.getElementById('ledgerCount') as HTMLElement).textContent =
        String(store.vouchers.filter((item) => dateInFiscalYear(item.date)).length);
    } catch { /* 忽略 */ }
    renderVoucherList();
    renderLedger();
    renderReport();
    renderAccounts();
    renderKPIs();
    return snapshot;
  },
  attachmentButtonHTML,
  bindAttachmentButtons,
  openAttachmentList,
  getAccountNames: () => store.accounts.map((a) => a.name),
  setVoucherAttachments: (no, atts) => {
    const v = store.vouchers.find((x) => x.no === no);
    if (!v) return false;
    v.attachments = atts.map((a) => ({ name: a.name, type: a.mime, dataURL: a.dataURL }));
    return true;
  },
  buildVoucherExport,
  fiscalYears: () =>
    store.fiscalYears.map((f) => ({ key: f.key, label: f.label, from: f.from, to: f.to })),
  selectedFiscalKey: () => store.selectedFiscalKey,
  /** 報表月份標籤（''=全年，否則 'YYYY-MM'），xlsx 標題用 */
  reportPeriodLabel: () => {
    const m = store.reportState.month as { key?: string } | null;
    return m && m.key ? String(m.key) : '';
  },
  /** Journal 當前篩選嘅 voucher（供報表匯出附件用） */
  getJournalVouchers: () => {
    const m = store.reportState.month as { key?: string } | null;
    const monthKey = m && m.key ? String(m.key) : null;
    return store.vouchers
      .filter((v) => {
        try {
          if (!dateInFiscalYear(v.date)) return false;
        } catch { return false; }
        if (monthKey && v.date.slice(0, 7) !== monthKey) return false;
        return true;
      })
      .map((v) => ({
        no: v.no,
        attachments: (v.attachments || []).map((a) => ({
          name: a.name,
          dataURL: (a as { dataURL?: string }).dataURL,
          dataB64: (a as { dataB64?: string }).dataB64,
          mime: (a as { mime?: string }).mime || (a as { type?: string }).type,
        })),
      }));
  },
};

window.__TG__ = bridge;

// 保證 APP_VERSION 同 web-src 一致（build script 亦會 assert）
if (APP_VERSION !== '3.15.2') {
  console.error('[desktop] APP_VERSION mismatch:', APP_VERSION);
}
