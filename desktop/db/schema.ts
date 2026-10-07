/**
 * Toys Gallery 會計系統桌面版 — SQLite 關聯式 schema v2。
 *
 * 設計要點：
 * - 金額一律 INTEGER（分，Cents）；絕不存浮點。
 * - 陣列順序用 seq / line_index / rowid 保留（見 convert.ts）。
 * - 附件只存 metadata {name, mime, path}，唔存 dataURL（檔案由 glue 層經
 *   @tauri-apps/plugin-fs 負責讀寫，見 SCHEMA.md §4）。
 * - account_name 刻意唔加 FK：JSON 係 name-keyed，科目改名由 app 層
 *   moveNamedKey 處理，呢層只做忠實存取。
 * - fiscal_key 欄（vouchers / opening_balances / opening_invoices /
 *   balance_adjustments）有 FK → fiscal_years(key)；deleted_data_years 例外
 *   （見下註），唔加 FK。
 * - SQL 一律用 `?` 做 placeholder（唔用 `$1`），同時兼容 Tauri plugin-sql
 *  （rusqlite）同 node:sqlite。
 */

/**
 * 全部 DDL，一個字串。呼叫方逐句 split（`;`）執行。
 * schema_version 表沿用 v1 舊定義（SCHEMA.md §1），版本由 1 起跳。
 */
export const SCHEMA_V2_SQL: string = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY, -- 由 1 開始；v2 = 關聯式 schema
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fiscal_years (
  key       TEXT PRIMARY KEY,
  start     INTEGER NOT NULL,
  label     TEXT NOT NULL,
  date_from TEXT NOT NULL, -- 'YYYY-04-01'
  date_to   TEXT NOT NULL  -- 'YYYY-03-31'
);

CREATE TABLE IF NOT EXISTS accounts (
  code                   TEXT PRIMARY KEY,
  name                   TEXT NOT NULL UNIQUE,
  type                   TEXT NOT NULL, -- '資產' | '負債' | '權益' | '收入' | '成本' | '費用'
  side                   TEXT NOT NULL, -- 'dr' | 'cr'
  balance_cents          INTEGER NOT NULL,
  imported_balance_cents INTEGER NOT NULL,
  -- 以下四欄：optional，缺席時存 NULL，重建時省略（唔輸出 undefined）
  custom                 INTEGER, -- NULL=缺席；0/1=boolean
  original_name          TEXT,    -- NULL=缺席
  edited                 INTEGER, -- NULL=缺席；0/1=boolean
  created_fiscal_key     TEXT     -- NULL=缺席（刻意唔加 FK，見檔頭註）
);

CREATE TABLE IF NOT EXISTS vouchers (
  no                 TEXT PRIMARY KEY,
  type               TEXT NOT NULL,
  number_manual      INTEGER NOT NULL DEFAULT 0,
  date               TEXT NOT NULL, -- 'YYYY-MM-DD'
  description        TEXT NOT NULL DEFAULT '',
  allocation_invoice TEXT NOT NULL DEFAULT '',
  made_by            TEXT NOT NULL DEFAULT '',
  checked_by         TEXT NOT NULL DEFAULT '',
  approved_by        TEXT NOT NULL DEFAULT '',
  -- 由 voucher date 對 fiscal_years 推導；對唔上任何財年時存 NULL（保插入成功）
  fiscal_key         TEXT REFERENCES fiscal_years(key),
  supporting_path    TEXT, -- NULL=缺席
  supporting_mime    TEXT, -- NULL=缺席（glue 層可填，JSON key: supportingMime）
  seq                INTEGER NOT NULL DEFAULT 0 -- JSON 陣列順序
);

CREATE TABLE IF NOT EXISTS voucher_lines (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_no   TEXT NOT NULL REFERENCES vouchers(no) ON DELETE CASCADE,
  line_index   INTEGER NOT NULL,
  account_name TEXT NOT NULL, -- 用 name（JSON 係 name-keyed，保真）；刻意唔加 FK
  debit_cents  INTEGER NOT NULL,
  credit_cents INTEGER NOT NULL,
  detail       TEXT NOT NULL DEFAULT '',
  UNIQUE (voucher_no, line_index)
);

CREATE TABLE IF NOT EXISTS attachments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_no TEXT NOT NULL REFERENCES vouchers(no) ON DELETE CASCADE,
  seq        INTEGER NOT NULL DEFAULT 0, -- 附件陣列順序
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL DEFAULT 'application/octet-stream',
  path       TEXT, -- v2 舊制：附件檔相對路徑；v3 起新附件唔再落檔，只做 fallback
  data_b64   TEXT  -- v3 起：附件內容 base64 存 SQLite（NULL=無內容）；單檔備份、唔怕孤兒檔
);

CREATE TABLE IF NOT EXISTS opening_balances (
  fiscal_key      TEXT NOT NULL REFERENCES fiscal_years(key),
  account_name    TEXT NOT NULL,
  debit_cents     INTEGER NOT NULL,
  credit_cents    INTEGER NOT NULL,
  -- 形狀原樣保留：1=舊形狀 plain number（語義=debit），0={debit,credit} 物件
  is_plain_number INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (fiscal_key, account_name)
);

CREATE TABLE IF NOT EXISTS opening_invoices (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  fiscal_key   TEXT NOT NULL REFERENCES fiscal_years(key),
  account_name TEXT NOT NULL,
  invoice_no   TEXT NOT NULL,
  invoice_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  seq          INTEGER NOT NULL DEFAULT 0 -- 期初發票陣列順序
);

CREATE TABLE IF NOT EXISTS invoices (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL, -- 'sales' | 'purchase'
  date         TEXT NOT NULL,
  invoice_no   TEXT NOT NULL,
  party        TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL,
  e4           TEXT, -- InvoiceRow[4]（來源）；NULL=缺席
  e5           TEXT, -- InvoiceRow[5]（來源 voucher 號）；NULL=缺席
  e6           TEXT, -- InvoiceRow[6]（明細）；NULL=缺席
  seq          INTEGER NOT NULL DEFAULT 0,
  UNIQUE (kind, invoice_no)
  -- 重建 tuple 時尾部 NULL 截斷，保持原長度
);

CREATE TABLE IF NOT EXISTS invoice_remarks (
  invoice_no TEXT PRIMARY KEY,
  remark     TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS allocations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL, -- 'AR' | 'AP'
  voucher_no   TEXT NOT NULL,
  invoice_no   TEXT NOT NULL,
  party        TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL,
  date         TEXT NOT NULL DEFAULT '',
  source       TEXT NOT NULL DEFAULT '',
  manual       INTEGER, -- NULL=欄位缺席；0/1=boolean
  seq          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS allocation_reviews (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_no   TEXT NOT NULL,
  kind         TEXT NOT NULL, -- 'AR' | 'AP'
  party        TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL,
  reason       TEXT NOT NULL DEFAULT '',
  seq          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS reconciliation_confirmations (
  account_key               TEXT PRIMARY KEY,
  confirmed_by              TEXT NOT NULL DEFAULT '',
  confirmed_date            TEXT NOT NULL DEFAULT '',
  note                      TEXT NOT NULL DEFAULT '',
  invoice_outstanding_cents INTEGER NOT NULL,
  account_balance_cents     INTEGER NOT NULL,
  difference_cents          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS staff_names (
  name       TEXT PRIMARY KEY,
  suppressed INTEGER NOT NULL DEFAULT 0 -- 0=staffNames，1=suppressedStaffNames
);

CREATE TABLE IF NOT EXISTS deleted_data_years (
  fiscal_key TEXT PRIMARY KEY
  -- 刻意唔加 FK → fiscal_years：已刪除財年本身可能已不在 fiscal_years，
  -- 但 deletedDataYears 仍要保留佢個 key。見檔頭註。
);

CREATE TABLE IF NOT EXISTS balance_adjustments (
  fiscal_key   TEXT NOT NULL REFERENCES fiscal_years(key),
  account_name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  PRIMARY KEY (fiscal_key, account_name)
);

CREATE TABLE IF NOT EXISTS app_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL -- JSON 字串；全部 key 統一 JSON 編碼（含純文字）
  -- keys: selected_fiscal_key / last_voucher_dates / report_state / report /
  --       current_route / editing_index / working_voucher
);

-- v4: MCP／Codex 待匯入 voucher（手寫單相片識別後經 create_voucher 入）。
-- 唔直接寫 vouchers 表：app 嘅 persist 係全表重寫，直接寫會被覆蓋；
-- 經呢個 inbox，由用戶喺桌面版一鍵匯入（行正常驗證＋過賬）。
CREATE TABLE IF NOT EXISTS pending_vouchers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  source       TEXT NOT NULL DEFAULT 'mcp', -- 來源：mcp/codex
  status       TEXT NOT NULL DEFAULT 'pending', -- pending/imported/rejected
  voucher_no   TEXT, -- 建議編號（可空；匯入時自動編）
  payload_json TEXT NOT NULL, -- {date,type,desc,madeBy,checkedBy,approvedBy,lines:[{account,debit_cents,credit_cents,detail}],attachments:[{name,mime,dataB64}]}
  note         TEXT -- 識別備註／確認記錄
);
`;
