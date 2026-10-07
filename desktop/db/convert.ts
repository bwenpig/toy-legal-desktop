/**
 * Toys Gallery 會計系統桌面版 — JSON ↔ 關聯式雙向轉換層（schema v2）。
 *
 * 交換標準 = app 嘅 createBackupPayload()（見 web-src/backup.ts）：
 * payload 頂層 {backupFormat, schemaVersion, appVersion, exportedAt, data}，
 * data 欄位順序：vouchers、accounts、salesInvoices、purchaseInvoices、
 * invoiceRemarks、allocations、allocationReview、fiscalYears、deletedDataYears、
 * balanceAdjustments、openingBalances、openingInvoiceDetails、
 * reconciliationConfirmations、staffNames、suppressedStaffNames、settings、
 * workingVoucher。loadPayload() 重建時欄位順序同佢一致。
 *
 * Import 限制（node 測試要過，唔掂 DOM）：
 * - web-src/types：type-only（會被 erase）
 * - web-src/version：runtime（APP_VERSION）
 * - web-src/money：runtime（Cents 型別），無 DOM
 * 唔可以 import 其他 web-src 模組。
 *
 * 前提假設：
 * - payload.data 係 app 已正規化嘅 v2 數據（glue 層先經 prepareRestore，
 *   金額已係整數分，附件已由 glue 轉做 {name, mime, path} metadata）。
 * - migrateFromPayload / persistPayload 之前，glue 已呼叫 initDatabase()
 *   建表；migrate 前 glue 負責做 .db 檔備份（呢層唔做）。
 */

import type {
  Account,
  Allocation,
  AllocationReview,
  BackupData,
  BackupPayload,
  BackupSettings,
  FiscalYear,
  InvoiceRow,
  OpeningEntry,
  OpeningInvoiceItem,
  ReconciliationConfirmation,
  Voucher,
  VoucherLine,
} from '../../web-src/types.js';
import type { Cents } from '../../web-src/money.js';
import { APP_VERSION } from '../../web-src/version.js';
import { SCHEMA_V2_SQL } from './schema.js';

/** 資料庫埠：browser 經 Tauri invoke 實現，node 測試經 node:sqlite 實現。 */
export interface DbPort {
  execute(query: string, values?: unknown[]): Promise<void>;
  select<T = Record<string, unknown>>(query: string, values?: unknown[]): Promise<T[]>;
}

/** initDatabase 回傳 */
export interface InitResult {
  /** schema_version 最大值；無記錄時為 0 */
  version: number;
  /** true = 舊 v1（kv_store）庫，需要 migrateFromPayload */
  needsMigration: boolean;
  /** true = v2 庫（附件仲係檔案制），要轉附件入 SQLite（v3） */
  needsBlobMigration: boolean;
  /** true = 全新空庫（連 kv_store 都無） */
  isFresh: boolean;
}

/** 每表筆數（migrateFromPayload / persistPayload 回傳，供驗證） */
export type TableCounts = Record<string, number>;

// ---------------------------------------------------------------------------
// 內部 helpers
// ---------------------------------------------------------------------------

/** 將多句 SQL 字串 split 做逐句（呼叫方逐句 execute；values 只可用於單句）。 */
function splitStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function str(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  if (typeof v === 'string') return v;
  if (v == null) return '';
  return String(v);
}

function num(row: Record<string, unknown>, key: string): number {
  const v = row[key];
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** optional 文字：null/undefined → NULL（重建時省略），其餘原樣（包括空字串）。 */
function optText(v: unknown): string | null {
  if (v == null) return null;
  return String(v);
}

/** optional boolean → 0/1；缺席 → NULL（重建時省略）。 */
function optBool(v: boolean | undefined | null): number | null {
  if (v == null) return null;
  return v ? 1 : 0;
}

/** voucher 額外 optional 欄（glue 層可加，如 supportingMime）：經 unknown 讀取。 */
function extraField(v: Voucher, key: string): unknown {
  return (v as unknown as Record<string, unknown>)[key];
}

async function tableExists(db: DbPort, name: string): Promise<boolean> {
  const rows = await db.select(
    "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    [name],
  );
  return rows.length > 0;
}

async function transaction(db: DbPort, fn: () => Promise<void>): Promise<void> {
  await db.execute('BEGIN IMMEDIATE');
  try {
    await fn();
  } catch (err) {
    try {
      await db.execute('ROLLBACK');
    } catch {
      // rollback 失敗都唔好掩蓋原本嘅錯
    }
    throw err;
  }
  await db.execute('COMMIT');
}

/** 由 voucher date 推導 fiscal_key；對唔上任何財年 → NULL（保插入成功）。 */
function fiscalKeyForDate(date: string, years: FiscalYear[]): string | null {
  for (const fy of years) {
    if (date >= fy.from && date <= fy.to) return fy.key;
  }
  return null;
}

/** 附件正規化 → {name, mime, path}。永遠唔存 dataURL（glue 負責落檔）。 */
interface DbAttachment {
  name: string;
  mime: string;
  path: string | null;
  /** v3：附件內容 base64（存 SQLite）；null = 無內容 */
  dataB64: string | null;
}
function normalizeAttachment(a: unknown): DbAttachment {
  const rec = (a ?? {}) as Record<string, unknown>;
  const rawName = rec['name'];
  const rawMime = rec['mime'] ?? rec['type'];
  const rawPath = rec['path'];
  const rawB64 = rec['dataB64'] ?? rec['data_b64'];
  return {
    name: typeof rawName === 'string' && rawName ? rawName : 'attachment',
    mime: typeof rawMime === 'string' && rawMime ? rawMime : 'application/octet-stream',
    path: rawPath == null ? null : String(rawPath),
    dataB64: typeof rawB64 === 'string' && rawB64 ? rawB64 : null,
  };
}

// ---------------------------------------------------------------------------
// init / seed
// ---------------------------------------------------------------------------

/**
 * 建表（IF NOT EXISTS）＋ PRAGMAs（foreign_keys=ON、journal_mode=WAL、
 * synchronous=NORMAL），然後判讀庫狀態：
 * - schema_version ≥ 3 → 正常
 * - schema_version = 2 → needsBlobMigration（附件檔案轉入 SQLite）
 * - schema_version = 1（或無記錄但 kv_store 有 app_state）→ needsMigration（v1）
 * - 連 kv_store 都無 → isFresh
 */
export async function initDatabase(db: DbPort): Promise<InitResult> {
  await db.execute('PRAGMA foreign_keys = ON');
  await db.execute('PRAGMA journal_mode = WAL');
  await db.execute('PRAGMA synchronous = NORMAL');
  for (const stmt of splitStatements(SCHEMA_V2_SQL)) {
    await db.execute(stmt);
  }
  const verRows = await db.select(
    'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1',
  );
  const version = verRows.length ? num(verRows[0], 'version') : 0;
  if (version >= 3) return { version, needsMigration: false, needsBlobMigration: false, isFresh: false };
  if (version === 2) return { version, needsMigration: false, needsBlobMigration: true, isFresh: false };
  if (version >= 1) return { version, needsMigration: true, needsBlobMigration: false, isFresh: false };
  if (await tableExists(db, 'kv_store')) {
    const appState = await db.select(
      'SELECT value FROM kv_store WHERE key = ? LIMIT 1',
      ['app_state'],
    );
    if (appState.length) return { version: 0, needsMigration: true, needsBlobMigration: false, isFresh: false };
  }
  return { version: 0, needsMigration: false, needsBlobMigration: false, isFresh: true };
}

/** 空庫 seed：INSERT schema_version(3)。 */
export async function seedFresh(db: DbPort): Promise<void> {
  await db.execute('INSERT OR IGNORE INTO schema_version(version) VALUES (3)');
}

// ---------------------------------------------------------------------------
// JSON → 關聯式（寫入）
// ---------------------------------------------------------------------------

/** 全量寫入所有表（DELETE 全表後 INSERT；子表先刪，fiscal_years 最後刪、最先插）。 */
async function writeAllTables(db: DbPort, data: BackupData): Promise<TableCounts> {
  const counts: TableCounts = {};
  const countTable = async (table: string): Promise<void> => {
    // 表名係內部常數，唔係用戶輸入；values 一律參數化
    const rows = await db.select(`SELECT COUNT(*) AS c FROM ${table}`);
    counts[table] = rows.length ? num(rows[0], 'c') : 0;
  };

  const fiscalYears: FiscalYear[] = data.fiscalYears ?? [];

  // ---- DELETE（子表先） ----
  for (const t of [
    'voucher_lines',
    'attachments',
    'vouchers',
    'accounts',
    'invoices',
    'invoice_remarks',
    'allocations',
    'allocation_reviews',
    'opening_balances',
    'opening_invoices',
    'balance_adjustments',
    'reconciliation_confirmations',
    'staff_names',
    'deleted_data_years',
    'app_state',
    'fiscal_years',
  ]) {
    await db.execute(`DELETE FROM ${t}`);
  }

  // ---- fiscal_years（FK 目標，最先插） ----
  for (const fy of fiscalYears) {
    await db.execute(
      'INSERT INTO fiscal_years(key, start, label, date_from, date_to) VALUES (?, ?, ?, ?, ?)',
      [fy.key, fy.start, fy.label, fy.from, fy.to],
    );
  }
  await countTable('fiscal_years');

  // ---- accounts ----
  for (const a of data.accounts ?? []) {
    await db.execute(
      `INSERT INTO accounts(code, name, type, side, balance_cents, imported_balance_cents,
        custom, original_name, edited, created_fiscal_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        a.code,
        a.name,
        a.type,
        a.side,
        a.balance,
        a.importedBalance,
        optBool(a.custom),
        optText(a.originalName),
        optBool(a.edited),
        optText(a.createdFiscalKey),
      ],
    );
  }
  await countTable('accounts');

  // ---- vouchers + lines + attachments ----
  {
    let seq = 0;
    for (const v of data.vouchers ?? []) {
      await db.execute(
        `INSERT INTO vouchers(no, type, number_manual, date, description, allocation_invoice,
          made_by, checked_by, approved_by, fiscal_key, supporting_path, supporting_mime, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          v.no,
          v.type,
          v.numberManual ? 1 : 0,
          v.date,
          v.desc ?? '',
          v.allocationInvoice ?? '',
          v.madeBy ?? '',
          v.checkedBy ?? '',
          v.approvedBy ?? '',
          fiscalKeyForDate(v.date, fiscalYears),
          optText(v.supportingPath),
          optText(extraField(v, 'supportingMime')),
          seq,
        ],
      );
      for (let lineIndex = 0; lineIndex < v.lines.length; lineIndex++) {
        const line = v.lines[lineIndex];
        await db.execute(
          `INSERT INTO voucher_lines(voucher_no, line_index, account_name, debit_cents, credit_cents, detail)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [v.no, lineIndex, line.account, line.debit, line.credit, line.detail ?? ''],
        );
      }
      let aseq = 0;
      for (const raw of v.attachments ?? []) {
        const att = normalizeAttachment(raw);
        await db.execute(
          'INSERT INTO attachments(voucher_no, seq, name, mime, path, data_b64) VALUES (?, ?, ?, ?, ?, ?)',
          [v.no, aseq, att.name, att.mime, att.path, att.dataB64],
        );
        aseq++;
      }
      seq++;
    }
    await countTable('vouchers');
    await countTable('voucher_lines');
    await countTable('attachments');
  }

  // ---- invoices（sales / purchase） ----
  const writeInvoices = async (kind: 'sales' | 'purchase', rows: InvoiceRow[] | undefined): Promise<void> => {
    let seq = 0;
    for (const r of rows ?? []) {
      await db.execute(
        `INSERT INTO invoices(kind, date, invoice_no, party, amount_cents, e4, e5, e6, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [kind, r[0], r[1], r[2] ?? '', r[3], optText(r[4]), optText(r[5]), optText(r[6]), seq],
      );
      seq++;
    }
  };
  await writeInvoices('sales', data.salesInvoices);
  await writeInvoices('purchase', data.purchaseInvoices);
  await countTable('invoices');

  // ---- invoice_remarks ----
  for (const [invoiceNo, remark] of Object.entries(data.invoiceRemarks ?? {})) {
    await db.execute('INSERT INTO invoice_remarks(invoice_no, remark) VALUES (?, ?)', [
      invoiceNo,
      remark ?? '',
    ]);
  }
  await countTable('invoice_remarks');

  // ---- allocations ----
  {
    let seq = 0;
    for (const a of data.allocations ?? []) {
      await db.execute(
        `INSERT INTO allocations(kind, voucher_no, invoice_no, party, amount_cents, date, source, manual, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          a.kind,
          a.voucher,
          a.invoiceNo,
          a.party ?? '',
          a.amount,
          a.date ?? '',
          a.source ?? '',
          optBool(a.manual),
          seq,
        ],
      );
      seq++;
    }
    await countTable('allocations');
  }

  // ---- allocation_reviews ----
  {
    let seq = 0;
    for (const r of data.allocationReview ?? []) {
      await db.execute(
        `INSERT INTO allocation_reviews(voucher_no, kind, party, amount_cents, reason, seq)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [r.voucher, r.kind, r.party ?? '', r.amount, r.reason ?? '', seq],
      );
      seq++;
    }
    await countTable('allocation_reviews');
  }

  // ---- opening_balances（形狀原樣保留） ----
  for (const [fyKey, byAccount] of Object.entries(data.openingBalances ?? {})) {
    for (const [accountName, entry] of Object.entries(byAccount ?? {})) {
      if (typeof entry === 'number') {
        // 舊形狀 plain number，語義 = debit
        await db.execute(
          `INSERT INTO opening_balances(fiscal_key, account_name, debit_cents, credit_cents, is_plain_number)
           VALUES (?, ?, ?, 0, 1)`,
          [fyKey, accountName, entry],
        );
      } else {
        const e: OpeningEntry = entry;
        await db.execute(
          `INSERT INTO opening_balances(fiscal_key, account_name, debit_cents, credit_cents, is_plain_number)
           VALUES (?, ?, ?, ?, 0)`,
          [fyKey, accountName, e.debit, e.credit],
        );
      }
    }
  }
  await countTable('opening_balances');

  // ---- opening_invoices ----
  {
    let seq = 0;
    for (const [fyKey, byAccount] of Object.entries(data.openingInvoiceDetails ?? {})) {
      for (const [accountName, items] of Object.entries(byAccount ?? {})) {
        for (const it of items ?? []) {
          await db.execute(
            `INSERT INTO opening_invoices(fiscal_key, account_name, invoice_no, invoice_date, amount_cents, seq)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [fyKey, accountName, it.invoiceNo, it.date, it.amount, seq],
          );
          seq++;
        }
      }
    }
    await countTable('opening_invoices');
  }

  // ---- balance_adjustments ----
  for (const [fyKey, byAccount] of Object.entries(data.balanceAdjustments ?? {})) {
    for (const [accountName, amount] of Object.entries(byAccount ?? {})) {
      await db.execute(
        'INSERT INTO balance_adjustments(fiscal_key, account_name, amount_cents) VALUES (?, ?, ?)',
        [fyKey, accountName, amount],
      );
    }
  }
  await countTable('balance_adjustments');

  // ---- reconciliation_confirmations ----
  // 明確標註型別：?? {} 會令 Object.entries 推斷 T=unknown
  const confirmations: Record<string, ReconciliationConfirmation> =
    data.reconciliationConfirmations ?? {};
  for (const [accountKey, r] of Object.entries(confirmations)) {
    await db.execute(
      `INSERT INTO reconciliation_confirmations(account_key, confirmed_by, confirmed_date, note,
        invoice_outstanding_cents, account_balance_cents, difference_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        accountKey,
        r.confirmedBy ?? '',
        r.date ?? '',
        r.note ?? '',
        r.invoiceOutstanding,
        r.accountBalance,
        r.difference,
      ],
    );
  }
  await countTable('reconciliation_confirmations');

  // ---- staff_names（staffNames + suppressedStaffNames 二合一；重疊時 suppressed 贏） ----
  for (const name of data.staffNames ?? []) {
    await db.execute('INSERT INTO staff_names(name, suppressed) VALUES (?, 0)', [name]);
  }
  for (const name of data.suppressedStaffNames ?? []) {
    await db.execute('INSERT OR REPLACE INTO staff_names(name, suppressed) VALUES (?, 1)', [name]);
  }
  await countTable('staff_names');

  // ---- deleted_data_years ----
  for (const fyKey of data.deletedDataYears ?? []) {
    await db.execute('INSERT INTO deleted_data_years(fiscal_key) VALUES (?)', [fyKey]);
  }
  await countTable('deleted_data_years');

  // ---- app_state（全部 JSON 編碼） ----
  const settings: Partial<BackupSettings> = data.settings ?? {};
  const putState = async (key: string, value: unknown): Promise<void> => {
    await db.execute('INSERT INTO app_state(key, value) VALUES (?, ?)', [key, JSON.stringify(value)]);
  };
  await putState('selected_fiscal_key', settings.selectedFiscalKey ?? '');
  await putState('last_voucher_dates', settings.lastVoucherDates ?? {});
  await putState('report_state', settings.reportState ?? {});
  await putState('report', settings.report ?? '');
  await putState('current_route', settings.currentRoute ?? '');
  await putState('editing_index', settings.editingIndex ?? null);
  await putState('working_voucher', data.workingVoucher ?? null);
  await countTable('app_state');

  return counts;
}

/**
 * v1（kv_store）→ v2/v3 遷移。payload.data 必須係 app 已正規化嘅 v2 數據
 * （glue 先經 prepareRestore；金額已係整數分）。
 * 單一 transaction：寫全部表 → DROP TABLE kv_store → INSERT schema_version(3)。
 * （附件經 glue extractAttachments 已轉 dataB64，所以直接係 v3。）
 * 注意：唔做 .db 檔備份，嗰個係 glue 層責任（見 SCHEMA.md §4 backupDbFile）。
 * 回傳每表筆數供驗證。
 */
export async function migrateFromPayload(
  db: DbPort,
  payload: BackupPayload,
): Promise<TableCounts> {
  let counts: TableCounts = {};
  await transaction(db, async () => {
    counts = await writeAllTables(db, payload.data);
    await db.execute('DROP TABLE IF EXISTS kv_store');
    await db.execute('INSERT INTO schema_version(version) VALUES (3)');
  });
  return counts;
}

/**
 * 全量重寫：單一 transaction（BEGIN IMMEDIATE…COMMIT），DELETE 全表後 INSERT。
 * vouchers 等用 INSERT 語義（先 DELETE 全表，子表先刪），唔依賴 OR REPLACE。
 * 回傳每表筆數供驗證。
 */
export async function persistPayload(
  db: DbPort,
  payload: BackupPayload,
): Promise<TableCounts> {
  let counts: TableCounts = {};
  await transaction(db, async () => {
    counts = await writeAllTables(db, payload.data);
    await db.execute('INSERT OR IGNORE INTO schema_version(version) VALUES (2)');
  });
  return counts;
}

// ---------------------------------------------------------------------------
// 關聯式 → JSON（讀出）
// ---------------------------------------------------------------------------

async function loadStateMap(db: DbPort): Promise<Map<string, unknown>> {
  const rows = await db.select('SELECT key, value FROM app_state');
  const map = new Map<string, unknown>();
  for (const r of rows) {
    const key = str(r, 'key');
    const raw = str(r, 'value');
    try {
      map.set(key, JSON.parse(raw));
    } catch {
      map.set(key, raw);
    }
  }
  return map;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asObject(v: unknown): Record<string, unknown> {
  if (v != null && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return {};
}

/** InvoiceRow 重建：e4/e5/e6 尾部 NULL 截斷，保持原長度。 */
function rebuildInvoiceRow(r: Record<string, unknown>): InvoiceRow {
  const head: [string, string, string, Cents] = [
    str(r, 'date'),
    str(r, 'invoice_no'),
    str(r, 'party'),
    num(r, 'amount_cents') as Cents, // DB 存 INTEGER；Cents 運行時就係 number
  ];
  const tail: unknown[] = [r['e4'], r['e5'], r['e6']];
  let len = 0;
  for (let i = 0; i < tail.length; i++) {
    if (tail[i] != null) len = i + 1;
  }
  const extras: Array<string | null> = [];
  for (let i = 0; i < len; i++) {
    extras.push(tail[i] == null ? null : String(tail[i]));
  }
  // 運行時形狀保證正確（見上截斷邏輯），cast 係為咗滿足 tuple 型別
  return [...head, ...extras] as unknown as InvoiceRow;
}

/**
 * 重建 BackupPayload。fiscal_years 空即回 null（未初始化／空庫）。
 * data 欄位順序同 createBackupPayload 一致；exportedAt 係新嘅、
 * appVersion = APP_VERSION。
 */
export async function loadPayload(db: DbPort): Promise<BackupPayload | null> {
  const fyRows = await db.select(
    'SELECT key, start, label, date_from, date_to FROM fiscal_years ORDER BY rowid',
  );
  if (!fyRows.length) return null;
  const fiscalYears: FiscalYear[] = fyRows.map((r) => ({
    start: num(r, 'start'),
    key: str(r, 'key'),
    label: str(r, 'label'),
    from: str(r, 'date_from'),
    to: str(r, 'date_to'),
  }));

  const accountRows = await db.select(
    `SELECT code, name, type, side, balance_cents, imported_balance_cents,
       custom, original_name, edited, created_fiscal_key
     FROM accounts ORDER BY rowid`,
  );
  const accounts: Account[] = accountRows.map((r) => {
    const a: Account = {
      code: str(r, 'code'),
      name: str(r, 'name'),
      type: str(r, 'type'),
      balance: num(r, 'balance_cents') as Cents,
      importedBalance: num(r, 'imported_balance_cents') as Cents,
      side: str(r, 'side') as Account['side'], // 本層寫入，值域受控
    };
    if (r['custom'] != null) a.custom = num(r, 'custom') !== 0;
    if (r['original_name'] != null) a.originalName = str(r, 'original_name');
    if (r['edited'] != null) a.edited = num(r, 'edited') !== 0;
    if (r['created_fiscal_key'] != null) a.createdFiscalKey = str(r, 'created_fiscal_key');
    return a;
  });

  const voucherRows = await db.select(
    `SELECT no, type, number_manual, date, description, allocation_invoice,
       made_by, checked_by, approved_by, supporting_path, supporting_mime
     FROM vouchers ORDER BY seq`,
  );
  const vouchers: Voucher[] = [];
  for (const r of voucherRows) {
    const no = str(r, 'no');
    const lineRows = await db.select(
      `SELECT account_name, debit_cents, credit_cents, detail
       FROM voucher_lines WHERE voucher_no = ? ORDER BY line_index`,
      [no],
    );
    const lines: VoucherLine[] = lineRows.map((lr) => ({
      account: str(lr, 'account_name'),
      debit: num(lr, 'debit_cents') as Cents,
      credit: num(lr, 'credit_cents') as Cents,
      detail: str(lr, 'detail'),
    }));
    const attRows = await db.select(
      'SELECT name, mime, path, data_b64 FROM attachments WHERE voucher_no = ? ORDER BY seq',
      [no],
    );
    const attachments: DbAttachment[] = attRows.map((ar) => ({
      name: str(ar, 'name'),
      mime: str(ar, 'mime'),
      path: ar['path'] == null ? null : String(ar['path']),
      dataB64: ar['data_b64'] == null ? null : String(ar['data_b64']),
    }));
    const v: Voucher = {
      no,
      type: str(r, 'type'),
      numberManual: num(r, 'number_manual') !== 0,
      date: str(r, 'date'),
      desc: str(r, 'description'),
      lines,
      madeBy: str(r, 'made_by'),
      checkedBy: str(r, 'checked_by'),
      approvedBy: str(r, 'approved_by'),
      allocationInvoice: str(r, 'allocation_invoice'),
      attachments: attachments as unknown as Voucher['attachments'],
    };
    if (r['supporting_path'] != null) v.supportingPath = str(r, 'supporting_path');
    if (r['supporting_mime'] != null) {
      (v as unknown as Record<string, unknown>)['supportingMime'] = str(r, 'supporting_mime');
    }
    vouchers.push(v);
  }

  const salesInvoiceRows = await db.select(
    "SELECT date, invoice_no, party, amount_cents, e4, e5, e6 FROM invoices WHERE kind = 'sales' ORDER BY seq",
  );
  const purchaseInvoiceRows = await db.select(
    "SELECT date, invoice_no, party, amount_cents, e4, e5, e6 FROM invoices WHERE kind = 'purchase' ORDER BY seq",
  );
  const salesInvoices: InvoiceRow[] = salesInvoiceRows.map(rebuildInvoiceRow);
  const purchaseInvoices: InvoiceRow[] = purchaseInvoiceRows.map(rebuildInvoiceRow);

  const remarkRows = await db.select('SELECT invoice_no, remark FROM invoice_remarks ORDER BY rowid');
  const invoiceRemarks: Record<string, string> = {};
  for (const r of remarkRows) invoiceRemarks[str(r, 'invoice_no')] = str(r, 'remark');

  const allocRows = await db.select(
    `SELECT kind, voucher_no, invoice_no, party, amount_cents, date, source, manual
     FROM allocations ORDER BY seq`,
  );
  const allocations: Allocation[] = allocRows.map((r) => {
    const a: Allocation = {
      kind: str(r, 'kind') as Allocation['kind'],
      invoiceNo: str(r, 'invoice_no'),
      party: str(r, 'party'),
      date: str(r, 'date'),
      amount: num(r, 'amount_cents') as Cents,
      voucher: str(r, 'voucher_no'),
      source: str(r, 'source'),
    };
    if (r['manual'] != null) a.manual = num(r, 'manual') !== 0;
    return a;
  });

  const reviewRows = await db.select(
    'SELECT voucher_no, kind, party, amount_cents, reason FROM allocation_reviews ORDER BY seq',
  );
  const allocationReview: AllocationReview[] = reviewRows.map((r) => ({
    voucher: str(r, 'voucher_no'),
    kind: str(r, 'kind') as AllocationReview['kind'],
    party: str(r, 'party'),
    amount: num(r, 'amount_cents') as Cents,
    reason: str(r, 'reason'),
  }));

  const ddRows = await db.select('SELECT fiscal_key FROM deleted_data_years ORDER BY rowid');
  const deletedDataYears: string[] = ddRows.map((r) => str(r, 'fiscal_key'));

  const baRows = await db.select(
    'SELECT fiscal_key, account_name, amount_cents FROM balance_adjustments ORDER BY rowid',
  );
  const balanceAdjustments: Record<string, Record<string, Cents>> = {};
  for (const r of baRows) {
    const fy = str(r, 'fiscal_key');
    (balanceAdjustments[fy] ??= {})[str(r, 'account_name')] = num(r, 'amount_cents') as Cents;
  }

  const obRows = await db.select(
    `SELECT fiscal_key, account_name, debit_cents, credit_cents, is_plain_number
     FROM opening_balances ORDER BY rowid`,
  );
  const openingBalances: Record<string, Record<string, number | OpeningEntry>> = {};
  for (const r of obRows) {
    const fy = str(r, 'fiscal_key');
    const accountName = str(r, 'account_name');
    const value: number | OpeningEntry =
      num(r, 'is_plain_number') !== 0
        ? num(r, 'debit_cents')
        : { debit: num(r, 'debit_cents') as Cents, credit: num(r, 'credit_cents') as Cents };
    (openingBalances[fy] ??= {})[accountName] = value;
  }

  const oiRows = await db.select(
    `SELECT fiscal_key, account_name, invoice_no, invoice_date, amount_cents
     FROM opening_invoices ORDER BY seq`,
  );
  const openingInvoiceDetails: Record<string, Record<string, OpeningInvoiceItem[]>> = {};
  for (const r of oiRows) {
    const fy = str(r, 'fiscal_key');
    const accountName = str(r, 'account_name');
    const item: OpeningInvoiceItem = {
      date: str(r, 'invoice_date'),
      invoiceNo: str(r, 'invoice_no'),
      amount: num(r, 'amount_cents') as Cents,
    };
    ((openingInvoiceDetails[fy] ??= {})[accountName] ??= []).push(item);
  }

  const rcRows = await db.select(
    `SELECT account_key, confirmed_by, confirmed_date, note,
       invoice_outstanding_cents, account_balance_cents, difference_cents
     FROM reconciliation_confirmations ORDER BY rowid`,
  );
  const reconciliationConfirmations: Record<string, ReconciliationConfirmation> = {};
  for (const r of rcRows) {
    reconciliationConfirmations[str(r, 'account_key')] = {
      confirmedBy: str(r, 'confirmed_by'),
      date: str(r, 'confirmed_date'),
      note: str(r, 'note'),
      invoiceOutstanding: num(r, 'invoice_outstanding_cents') as Cents,
      accountBalance: num(r, 'account_balance_cents') as Cents,
      difference: num(r, 'difference_cents') as Cents,
    };
  }

  const staffRows = await db.select('SELECT name, suppressed FROM staff_names ORDER BY rowid');
  const staffNames: string[] = [];
  const suppressedStaffNames: string[] = [];
  for (const r of staffRows) {
    if (num(r, 'suppressed') !== 0) suppressedStaffNames.push(str(r, 'name'));
    else staffNames.push(str(r, 'name'));
  }

  const state = await loadStateMap(db);
  // editingIndex 運行時可為 null（見 Store.editingIndex: number | null），
  // 型別沿用 BackupSettings（註明 number），此處如實還原。
  const editingIndexRaw = state.get('editing_index');
  const settings = {
    selectedFiscalKey: asString(state.get('selected_fiscal_key')),
    lastVoucherDates: asObject(state.get('last_voucher_dates')) as Record<string, string>,
    reportState: asObject(state.get('report_state')),
    report: asString(state.get('report')),
    currentRoute: asString(state.get('current_route')),
    editingIndex: (editingIndexRaw == null ? null : Number(editingIndexRaw)) as unknown as number,
  } as BackupSettings;
  const workingVoucherRaw = state.get('working_voucher');
  const workingVoucher: Voucher | null =
    workingVoucherRaw == null ? null : (workingVoucherRaw as Voucher);

  return {
    backupFormat: 'toys-gallery-accounting',
    schemaVersion: 2,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    data: {
      vouchers,
      accounts,
      salesInvoices,
      purchaseInvoices,
      invoiceRemarks,
      allocations,
      allocationReview,
      fiscalYears,
      deletedDataYears,
      balanceAdjustments,
      openingBalances,
      openingInvoiceDetails,
      reconciliationConfirmations,
      staffNames,
      suppressedStaffNames,
      settings,
      workingVoucher,
    },
  };
}
