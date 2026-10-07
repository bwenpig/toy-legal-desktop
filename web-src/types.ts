/**
 * 共用型別 —— 由現行 v3.15 數據形狀推斷。
 * 全部模組引用此處型別；不得在此引入 DOM 以外的運行依賴。
 */

import type { Cents } from './money';

/** 借貸方向 */
export type DrCr = 'dr' | 'cr';

/** AR / AP */
export type ARAPKind = 'AR' | 'AP';

/** 財年 */
export interface FiscalYear {
  start: number;
  key: string;
  label: string;
  from: string; // 'YYYY-04-01'
  to: string;   // 'YYYY-03-31'
}

/** 科目 */
export interface Account {
  code: string;
  name: string;
  type: string; // '資產' | '負債' | '權益' | '收入' | '成本' | '費用'
  balance: Cents;
  importedBalance: Cents;
  side: DrCr;
  /** 改名前的原名（用户改名后才出现） */
  originalName?: string;
  /** 用户新增/修改过的科目标记 */
  custom?: boolean;
  /** 用户编辑过（与 custom 语义相近，沿用原 script 字段） */
  edited?: boolean;
  /** 新增科目時的財年 key（原 script 寫入的運行時標記） */
  createdFiscalKey?: string;
}

/** Voucher 分錄行 */
export interface VoucherLine {
  account: string;
  debit: Cents;
  credit: Cents;
  detail: string;
}

/** 附件 */
export interface Attachment {
  name: string;
  type: string;
  dataURL: string;
}

/** Voucher（其餘未列欄位以可選形式保留，避免 strict 下存取報錯） */
export interface Voucher {
  no: string;
  type: string;
  date: string; // 'YYYY-MM-DD'
  desc: string;
  lines: VoucherLine[];
  madeBy: string;
  checkedBy: string;
  approvedBy: string;
  allocationInvoice: string;
  attachments: Attachment[];
  // 舊單相容／運行時附加欄位
  supportingFile?: File | null;
  supportingName?: string;
  supportingPath?: string;
  supportingAttachment?: { name?: string; type?: string; data?: string } | null;
  numberManual?: boolean;
}

/** 對銷記錄 */
export interface Allocation {
  kind: ARAPKind;
  invoiceNo: string;
  party: string;
  date: string;
  amount: Cents;
  voucher: string;
  source: string; // 'FIFO' | '指定發票' | 'Sales Report 備註' | ...
  /** 人工在核對 modal 加的記錄（原 script 寫入的運行時標記） */
  manual?: boolean;
}

/** 待核對項目 */
export interface AllocationReview {
  voucher: string;
  kind: ARAPKind;
  party: string;
  amount: Cents;
  reason: string;
}

/** 發票列（tuple）：
 *  [日期, 發票號, 對方, 金額, 來源, 來源voucher號?, 明細?]，
 *  來源 = 'opening' | 'voucher' | undefined（登記冊）
 */
export type InvoiceRow = [string, string, string, Cents, string?, string?, string?];

/** 期初餘額 entry */
export interface OpeningEntry {
  debit: Cents;
  credit: Cents;
}

/** 期初發票明細項目 */
export interface OpeningInvoiceItem {
  date: string;
  invoiceNo: string;
  amount: Cents;
}

/** 期初發票狀態 */
export interface OpeningInvoiceStatus {
  state: 'unsplit' | 'complete' | 'pending';
  items: OpeningInvoiceItem[];
  expected: Cents;
  total: Cents;
  difference: Cents;
}

/** 純函數共用 ctx（取代原 script 的全域變量） */
export interface CoreCtx {
  vouchers: Voucher[];
  accounts: Account[];
  salesInvoices: InvoiceRow[];
  purchaseInvoices: InvoiceRow[];
  openingBalances: Record<string, Record<string, number | OpeningEntry>>;
  openingInvoiceDetails: Record<string, Record<string, OpeningInvoiceItem[]>>;
  deletedDataYears: Set<string>;
  allocations: Allocation[];
}

/** applyAllocation 回傳 */
export interface AllocationResult {
  newAllocations: Allocation[];
  reviews: AllocationReview[];
  needsReview: boolean;
}

/** AR/AP 核對確認記錄 */
export interface ReconciliationConfirmation {
  confirmedBy: string;
  date: string;
  note: string;
  invoiceOutstanding: Cents;
  accountBalance: Cents;
  difference: Cents;
}

/** 核對 modal 發票草稿列 */
export interface ReconcileInvoiceDraftItem {
  date: string;
  invoiceNo: string;
  amount: Cents;
  origin: string;
}

/** 核對 modal 收/付款草稿列 */
export interface ReconcilePaymentDraftItem {
  date: string;
  voucher: string;
  invoiceNo: string;
  amount: Cents;
  source: string;
}

/** JSON 備份 payload（createBackupPayload 寫入的形狀） */
export interface BackupSettings {
  selectedFiscalKey: string;
  lastVoucherDates: Record<string, string>;
  reportState: Record<string, unknown>;
  report: string;
  currentRoute: string;
  editingIndex: number;
}
export interface BackupData {
  accounts: Account[];
  vouchers: Voucher[];
  fiscalYears: FiscalYear[];
  salesInvoices: InvoiceRow[];
  purchaseInvoices: InvoiceRow[];
  allocations: Allocation[];
  allocationReview: AllocationReview[];
  staffNames: string[];
  suppressedStaffNames: string[];
  deletedDataYears: string[];
  balanceAdjustments: Record<string, Record<string, Cents>>;
  openingBalances: Record<string, Record<string, number | OpeningEntry>>;
  openingInvoiceDetails: Record<string, Record<string, OpeningInvoiceItem[]>>;
  invoiceRemarks: Record<string, string>;
  reconciliationConfirmations: Record<string, ReconciliationConfirmation>;
  settings: BackupSettings;
  workingVoucher?: Voucher | null;
  [key: string]: unknown;
}
export interface BackupPayload {
  backupFormat: string;
  schemaVersion: number;
  appVersion: string;
  exportedAt: string;
  data: BackupData;
}

/** 報表月份（fiscalMonths 回傳列） */
export interface FiscalMonth {
  key: string; // 'YYYY-MM'
  short: string;
  long: string;
  end: string;
}

/** 銷售／採購報表交易行 */
export interface TransactionRow {
  date: string;
  invoice: string;
  voucherHtml: string;
  voucherText: string;
  name: string;
  amount: Cents;
  remark: string;
  source: string; // 'invoice' | 'voucher'
}

/** 全域 store 形狀（src/state.ts） */
export interface Store {
  fiscalYears: FiscalYear[];
  selectedFiscalKey: string;
  deleteFiscalCandidate: FiscalYear | null | undefined;
  deleteFiscalStep: number;
  deletedDataYears: Set<string>;
  balanceAdjustments: Record<string, Record<string, Cents>>;
  openingBalances: Record<string, Record<string, number | OpeningEntry>>;
  openingInvoiceDetails: Record<string, Record<string, OpeningInvoiceItem[]>>;
  accounts: Account[];
  salesInvoices: InvoiceRow[];
  purchaseInvoices: InvoiceRow[];
  invoiceRemarks: Record<string, string>;
  allocations: Allocation[];
  allocationReview: AllocationReview[];
  vouchers: Voucher[];
  currentType: string;
  rows: VoucherLine[];
  report: string;
  editingIndex: number | null;
  numberManuallyEdited: boolean;
  currentAttachments: Attachment[];
  lastVoucherDates: Record<string, string>;
  staffNames: Set<string>;
  suppressedStaffNames: Set<string>;
  reportState: { month: { key: string } | null; date: string; nameQuery: string; invoiceQuery: string };
  reconciliationConfirmations: Record<string, ReconciliationConfirmation>;
  reconciliationContext: ReconciliationContext | null;
  reconcileInvoiceDraft: ReconcileInvoiceDraftItem[];
  reconcilePaymentDraft: ReconcilePaymentDraftItem[];
  editingAccount: Account | null | undefined;
  accountEditStep: number;
  deletingAccount: Account | null | undefined;
  deleteAccountStep: number;
  deleteAccountUsage: unknown[];
  openingInvoiceAccount: string;
  openingInvoiceDraft: OpeningInvoiceItem[];
  pendingRestore: PendingRestore | null;
  restoreStep: number;
}

/** 核對 modal 上下文（形狀複雜，保留 unknown 欄位漸進收緊） */
export interface ReconciliationContext {
  kind: ARAPKind;
  accountName: string;
  party: string;
  month: { key: string } | null;
  openingWasDisplayed: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any; // 理由：核對上下文欄位多且動態增減，逐一列型別風險高於收益；後續重構再收緊
}

/** 還原暫存 */
export interface PendingRestore {
  fileName: string;
  payload: BackupPayload;
  prepared: BackupData;
  /** 舊版（schema v1）備份還原時轉為分的欄數（v2 為 0） */
  legacyConverted?: number;
}

