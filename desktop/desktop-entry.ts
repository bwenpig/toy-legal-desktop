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
import { store, selectedFiscalYear } from '../web-src/state';
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
import { renderAccounts, sortAccounts } from '../web-src/accounts';
import { renderVoucherList, renderInvoiceNumberList, attachmentButtonHTML, bindAttachmentButtons } from '../web-src/vouchers';
import { renderLedger } from '../web-src/ledger';
import { navigate, renderStaffNames } from '../web-src/ui';
import { dollarsToCents, toCents } from '../web-src/money';
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
export interface ExcelImportResult {
  addedAccounts: number;
  skippedAccounts: number;
  setOpening: number;
  openingErrors: number;
}

/**
 * Excel 匯入：科目表＋期初數（桌面版獨有功能）。
 * 金額由 Excel 美元數字經 `dollarsToCents` 轉分；期初按科目借貸方向
 * 寫入 `{debit, credit}`（舊版直存 plain number 語義含糊，新版明確）。
 */
function importExcelData(imp: {
  accounts?: ExcelImportAccount[];
  opening?: ExcelImportOpening[];
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
  renderAccounts();
  renderReport();
  renderKPIs();
  return { addedAccounts, skippedAccounts, setOpening, openingErrors };
}

declare global {
  interface Window {
    __TG__?: unknown;
  }
}

export interface DesktopBridge {
  desktopVersion: string;
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
  attachmentButtonHTML: typeof attachmentButtonHTML;
  bindAttachmentButtons: typeof bindAttachmentButtons;
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
}

/** 桌面版 bridge（tauri-glue.js 經呢度攞 app 功能）。 */
const bridge: DesktopBridge = {
  desktopVersion: '3.22.0',
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
  attachmentButtonHTML,
  bindAttachmentButtons,
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
};

window.__TG__ = bridge;

// 保證 APP_VERSION 同 web-src 一致（build script 亦會 assert）
if (APP_VERSION !== '3.15.1') {
  console.error('[desktop] APP_VERSION mismatch:', APP_VERSION);
}
