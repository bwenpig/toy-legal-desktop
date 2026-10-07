"use strict";
var __TG_DB__ = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // desktop/db/index.ts
  var index_exports = {};
  __export(index_exports, {
    SCHEMA_V2_SQL: () => SCHEMA_V2_SQL,
    initDatabase: () => initDatabase,
    loadPayload: () => loadPayload,
    migrateFromPayload: () => migrateFromPayload,
    persistPayload: () => persistPayload,
    seedFresh: () => seedFresh
  });

  // desktop/db/schema.ts
  var SCHEMA_V2_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY, -- \u7531 1 \u958B\u59CB\uFF1Bv2 = \u95DC\u806F\u5F0F schema
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
  type                   TEXT NOT NULL, -- '\u8CC7\u7522' | '\u8CA0\u50B5' | '\u6B0A\u76CA' | '\u6536\u5165' | '\u6210\u672C' | '\u8CBB\u7528'
  side                   TEXT NOT NULL, -- 'dr' | 'cr'
  balance_cents          INTEGER NOT NULL,
  imported_balance_cents INTEGER NOT NULL,
  -- \u4EE5\u4E0B\u56DB\u6B04\uFF1Aoptional\uFF0C\u7F3A\u5E2D\u6642\u5B58 NULL\uFF0C\u91CD\u5EFA\u6642\u7701\u7565\uFF08\u5514\u8F38\u51FA undefined\uFF09
  custom                 INTEGER, -- NULL=\u7F3A\u5E2D\uFF1B0/1=boolean
  original_name          TEXT,    -- NULL=\u7F3A\u5E2D
  edited                 INTEGER, -- NULL=\u7F3A\u5E2D\uFF1B0/1=boolean
  created_fiscal_key     TEXT     -- NULL=\u7F3A\u5E2D\uFF08\u523B\u610F\u5514\u52A0 FK\uFF0C\u898B\u6A94\u982D\u8A3B\uFF09
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
  -- \u7531 voucher date \u5C0D fiscal_years \u63A8\u5C0E\uFF1B\u5C0D\u5514\u4E0A\u4EFB\u4F55\u8CA1\u5E74\u6642\u5B58 NULL\uFF08\u4FDD\u63D2\u5165\u6210\u529F\uFF09
  fiscal_key         TEXT REFERENCES fiscal_years(key),
  supporting_path    TEXT, -- NULL=\u7F3A\u5E2D
  supporting_mime    TEXT, -- NULL=\u7F3A\u5E2D\uFF08glue \u5C64\u53EF\u586B\uFF0CJSON key: supportingMime\uFF09
  seq                INTEGER NOT NULL DEFAULT 0 -- JSON \u9663\u5217\u9806\u5E8F
);

CREATE TABLE IF NOT EXISTS voucher_lines (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_no   TEXT NOT NULL REFERENCES vouchers(no) ON DELETE CASCADE,
  line_index   INTEGER NOT NULL,
  account_name TEXT NOT NULL, -- \u7528 name\uFF08JSON \u4FC2 name-keyed\uFF0C\u4FDD\u771F\uFF09\uFF1B\u523B\u610F\u5514\u52A0 FK
  debit_cents  INTEGER NOT NULL,
  credit_cents INTEGER NOT NULL,
  detail       TEXT NOT NULL DEFAULT '',
  UNIQUE (voucher_no, line_index)
);

CREATE TABLE IF NOT EXISTS attachments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_no TEXT NOT NULL REFERENCES vouchers(no) ON DELETE CASCADE,
  seq        INTEGER NOT NULL DEFAULT 0, -- \u9644\u4EF6\u9663\u5217\u9806\u5E8F
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL DEFAULT 'application/octet-stream',
  path       TEXT, -- v2 \u820A\u5236\uFF1A\u9644\u4EF6\u6A94\u76F8\u5C0D\u8DEF\u5F91\uFF1Bv3 \u8D77\u65B0\u9644\u4EF6\u5514\u518D\u843D\u6A94\uFF0C\u53EA\u505A fallback
  data_b64   TEXT  -- v3 \u8D77\uFF1A\u9644\u4EF6\u5167\u5BB9 base64 \u5B58 SQLite\uFF08NULL=\u7121\u5167\u5BB9\uFF09\uFF1B\u55AE\u6A94\u5099\u4EFD\u3001\u5514\u6015\u5B64\u5152\u6A94
);

CREATE TABLE IF NOT EXISTS opening_balances (
  fiscal_key      TEXT NOT NULL REFERENCES fiscal_years(key),
  account_name    TEXT NOT NULL,
  debit_cents     INTEGER NOT NULL,
  credit_cents    INTEGER NOT NULL,
  -- \u5F62\u72C0\u539F\u6A23\u4FDD\u7559\uFF1A1=\u820A\u5F62\u72C0 plain number\uFF08\u8A9E\u7FA9=debit\uFF09\uFF0C0={debit,credit} \u7269\u4EF6
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
  seq          INTEGER NOT NULL DEFAULT 0 -- \u671F\u521D\u767C\u7968\u9663\u5217\u9806\u5E8F
);

CREATE TABLE IF NOT EXISTS invoices (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL, -- 'sales' | 'purchase'
  date         TEXT NOT NULL,
  invoice_no   TEXT NOT NULL,
  party        TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL,
  e4           TEXT, -- InvoiceRow[4]\uFF08\u4F86\u6E90\uFF09\uFF1BNULL=\u7F3A\u5E2D
  e5           TEXT, -- InvoiceRow[5]\uFF08\u4F86\u6E90 voucher \u865F\uFF09\uFF1BNULL=\u7F3A\u5E2D
  e6           TEXT, -- InvoiceRow[6]\uFF08\u660E\u7D30\uFF09\uFF1BNULL=\u7F3A\u5E2D
  seq          INTEGER NOT NULL DEFAULT 0,
  UNIQUE (kind, invoice_no)
  -- \u91CD\u5EFA tuple \u6642\u5C3E\u90E8 NULL \u622A\u65B7\uFF0C\u4FDD\u6301\u539F\u9577\u5EA6
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
  manual       INTEGER, -- NULL=\u6B04\u4F4D\u7F3A\u5E2D\uFF1B0/1=boolean
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
  suppressed INTEGER NOT NULL DEFAULT 0 -- 0=staffNames\uFF0C1=suppressedStaffNames
);

CREATE TABLE IF NOT EXISTS deleted_data_years (
  fiscal_key TEXT PRIMARY KEY
  -- \u523B\u610F\u5514\u52A0 FK \u2192 fiscal_years\uFF1A\u5DF2\u522A\u9664\u8CA1\u5E74\u672C\u8EAB\u53EF\u80FD\u5DF2\u4E0D\u5728 fiscal_years\uFF0C
  -- \u4F46 deletedDataYears \u4ECD\u8981\u4FDD\u7559\u4F62\u500B key\u3002\u898B\u6A94\u982D\u8A3B\u3002
);

CREATE TABLE IF NOT EXISTS balance_adjustments (
  fiscal_key   TEXT NOT NULL REFERENCES fiscal_years(key),
  account_name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  PRIMARY KEY (fiscal_key, account_name)
);

CREATE TABLE IF NOT EXISTS app_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL -- JSON \u5B57\u4E32\uFF1B\u5168\u90E8 key \u7D71\u4E00 JSON \u7DE8\u78BC\uFF08\u542B\u7D14\u6587\u5B57\uFF09
  -- keys: selected_fiscal_key / last_voucher_dates / report_state / report /
  --       current_route / editing_index / working_voucher
);
`;

  // web-src/version.ts
  var APP_VERSION = "3.15.1";

  // desktop/db/convert.ts
  function splitStatements(sql) {
    return sql.split(";").map((s) => s.trim()).filter((s) => s.length > 0);
  }
  function str(row, key) {
    const v = row[key];
    if (typeof v === "string") return v;
    if (v == null) return "";
    return String(v);
  }
  function num(row, key) {
    const v = row[key];
    if (typeof v === "number") return v;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  function optText(v) {
    if (v == null) return null;
    return String(v);
  }
  function optBool(v) {
    if (v == null) return null;
    return v ? 1 : 0;
  }
  function extraField(v, key) {
    return v[key];
  }
  async function tableExists(db, name) {
    const rows = await db.select(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      [name]
    );
    return rows.length > 0;
  }
  async function transaction(db, fn) {
    await db.execute("BEGIN IMMEDIATE");
    try {
      await fn();
    } catch (err) {
      try {
        await db.execute("ROLLBACK");
      } catch {
      }
      throw err;
    }
    await db.execute("COMMIT");
  }
  function fiscalKeyForDate(date, years) {
    for (const fy of years) {
      if (date >= fy.from && date <= fy.to) return fy.key;
    }
    return null;
  }
  function normalizeAttachment(a) {
    const rec = a ?? {};
    const rawName = rec["name"];
    const rawMime = rec["mime"] ?? rec["type"];
    const rawPath = rec["path"];
    const rawB64 = rec["dataB64"] ?? rec["data_b64"];
    return {
      name: typeof rawName === "string" && rawName ? rawName : "attachment",
      mime: typeof rawMime === "string" && rawMime ? rawMime : "application/octet-stream",
      path: rawPath == null ? null : String(rawPath),
      dataB64: typeof rawB64 === "string" && rawB64 ? rawB64 : null
    };
  }
  async function initDatabase(db) {
    await db.execute("PRAGMA foreign_keys = ON");
    await db.execute("PRAGMA journal_mode = WAL");
    await db.execute("PRAGMA synchronous = NORMAL");
    for (const stmt of splitStatements(SCHEMA_V2_SQL)) {
      await db.execute(stmt);
    }
    const verRows = await db.select(
      "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1"
    );
    const version = verRows.length ? num(verRows[0], "version") : 0;
    if (version >= 3) return { version, needsMigration: false, needsBlobMigration: false, isFresh: false };
    if (version === 2) return { version, needsMigration: false, needsBlobMigration: true, isFresh: false };
    if (version >= 1) return { version, needsMigration: true, needsBlobMigration: false, isFresh: false };
    if (await tableExists(db, "kv_store")) {
      const appState = await db.select(
        "SELECT value FROM kv_store WHERE key = ? LIMIT 1",
        ["app_state"]
      );
      if (appState.length) return { version: 0, needsMigration: true, needsBlobMigration: false, isFresh: false };
    }
    return { version: 0, needsMigration: false, needsBlobMigration: false, isFresh: true };
  }
  async function seedFresh(db) {
    await db.execute("INSERT OR IGNORE INTO schema_version(version) VALUES (3)");
  }
  async function writeAllTables(db, data) {
    const counts = {};
    const countTable = async (table) => {
      const rows = await db.select(`SELECT COUNT(*) AS c FROM ${table}`);
      counts[table] = rows.length ? num(rows[0], "c") : 0;
    };
    const fiscalYears = data.fiscalYears ?? [];
    for (const t of [
      "voucher_lines",
      "attachments",
      "vouchers",
      "accounts",
      "invoices",
      "invoice_remarks",
      "allocations",
      "allocation_reviews",
      "opening_balances",
      "opening_invoices",
      "balance_adjustments",
      "reconciliation_confirmations",
      "staff_names",
      "deleted_data_years",
      "app_state",
      "fiscal_years"
    ]) {
      await db.execute(`DELETE FROM ${t}`);
    }
    for (const fy of fiscalYears) {
      await db.execute(
        "INSERT INTO fiscal_years(key, start, label, date_from, date_to) VALUES (?, ?, ?, ?, ?)",
        [fy.key, fy.start, fy.label, fy.from, fy.to]
      );
    }
    await countTable("fiscal_years");
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
          optText(a.createdFiscalKey)
        ]
      );
    }
    await countTable("accounts");
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
            v.desc ?? "",
            v.allocationInvoice ?? "",
            v.madeBy ?? "",
            v.checkedBy ?? "",
            v.approvedBy ?? "",
            fiscalKeyForDate(v.date, fiscalYears),
            optText(v.supportingPath),
            optText(extraField(v, "supportingMime")),
            seq
          ]
        );
        for (let lineIndex = 0; lineIndex < v.lines.length; lineIndex++) {
          const line = v.lines[lineIndex];
          await db.execute(
            `INSERT INTO voucher_lines(voucher_no, line_index, account_name, debit_cents, credit_cents, detail)
           VALUES (?, ?, ?, ?, ?, ?)`,
            [v.no, lineIndex, line.account, line.debit, line.credit, line.detail ?? ""]
          );
        }
        let aseq = 0;
        for (const raw of v.attachments ?? []) {
          const att = normalizeAttachment(raw);
          await db.execute(
            "INSERT INTO attachments(voucher_no, seq, name, mime, path, data_b64) VALUES (?, ?, ?, ?, ?, ?)",
            [v.no, aseq, att.name, att.mime, att.path, att.dataB64]
          );
          aseq++;
        }
        seq++;
      }
      await countTable("vouchers");
      await countTable("voucher_lines");
      await countTable("attachments");
    }
    const writeInvoices = async (kind, rows) => {
      let seq = 0;
      for (const r of rows ?? []) {
        await db.execute(
          `INSERT INTO invoices(kind, date, invoice_no, party, amount_cents, e4, e5, e6, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [kind, r[0], r[1], r[2] ?? "", r[3], optText(r[4]), optText(r[5]), optText(r[6]), seq]
        );
        seq++;
      }
    };
    await writeInvoices("sales", data.salesInvoices);
    await writeInvoices("purchase", data.purchaseInvoices);
    await countTable("invoices");
    for (const [invoiceNo, remark] of Object.entries(data.invoiceRemarks ?? {})) {
      await db.execute("INSERT INTO invoice_remarks(invoice_no, remark) VALUES (?, ?)", [
        invoiceNo,
        remark ?? ""
      ]);
    }
    await countTable("invoice_remarks");
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
            a.party ?? "",
            a.amount,
            a.date ?? "",
            a.source ?? "",
            optBool(a.manual),
            seq
          ]
        );
        seq++;
      }
      await countTable("allocations");
    }
    {
      let seq = 0;
      for (const r of data.allocationReview ?? []) {
        await db.execute(
          `INSERT INTO allocation_reviews(voucher_no, kind, party, amount_cents, reason, seq)
         VALUES (?, ?, ?, ?, ?, ?)`,
          [r.voucher, r.kind, r.party ?? "", r.amount, r.reason ?? "", seq]
        );
        seq++;
      }
      await countTable("allocation_reviews");
    }
    for (const [fyKey, byAccount] of Object.entries(data.openingBalances ?? {})) {
      for (const [accountName, entry] of Object.entries(byAccount ?? {})) {
        if (typeof entry === "number") {
          await db.execute(
            `INSERT INTO opening_balances(fiscal_key, account_name, debit_cents, credit_cents, is_plain_number)
           VALUES (?, ?, ?, 0, 1)`,
            [fyKey, accountName, entry]
          );
        } else {
          const e = entry;
          await db.execute(
            `INSERT INTO opening_balances(fiscal_key, account_name, debit_cents, credit_cents, is_plain_number)
           VALUES (?, ?, ?, ?, 0)`,
            [fyKey, accountName, e.debit, e.credit]
          );
        }
      }
    }
    await countTable("opening_balances");
    {
      let seq = 0;
      for (const [fyKey, byAccount] of Object.entries(data.openingInvoiceDetails ?? {})) {
        for (const [accountName, items] of Object.entries(byAccount ?? {})) {
          for (const it of items ?? []) {
            await db.execute(
              `INSERT INTO opening_invoices(fiscal_key, account_name, invoice_no, invoice_date, amount_cents, seq)
             VALUES (?, ?, ?, ?, ?, ?)`,
              [fyKey, accountName, it.invoiceNo, it.date, it.amount, seq]
            );
            seq++;
          }
        }
      }
      await countTable("opening_invoices");
    }
    for (const [fyKey, byAccount] of Object.entries(data.balanceAdjustments ?? {})) {
      for (const [accountName, amount] of Object.entries(byAccount ?? {})) {
        await db.execute(
          "INSERT INTO balance_adjustments(fiscal_key, account_name, amount_cents) VALUES (?, ?, ?)",
          [fyKey, accountName, amount]
        );
      }
    }
    await countTable("balance_adjustments");
    const confirmations = data.reconciliationConfirmations ?? {};
    for (const [accountKey, r] of Object.entries(confirmations)) {
      await db.execute(
        `INSERT INTO reconciliation_confirmations(account_key, confirmed_by, confirmed_date, note,
        invoice_outstanding_cents, account_balance_cents, difference_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          accountKey,
          r.confirmedBy ?? "",
          r.date ?? "",
          r.note ?? "",
          r.invoiceOutstanding,
          r.accountBalance,
          r.difference
        ]
      );
    }
    await countTable("reconciliation_confirmations");
    for (const name of data.staffNames ?? []) {
      await db.execute("INSERT INTO staff_names(name, suppressed) VALUES (?, 0)", [name]);
    }
    for (const name of data.suppressedStaffNames ?? []) {
      await db.execute("INSERT OR REPLACE INTO staff_names(name, suppressed) VALUES (?, 1)", [name]);
    }
    await countTable("staff_names");
    for (const fyKey of data.deletedDataYears ?? []) {
      await db.execute("INSERT INTO deleted_data_years(fiscal_key) VALUES (?)", [fyKey]);
    }
    await countTable("deleted_data_years");
    const settings = data.settings ?? {};
    const putState = async (key, value) => {
      await db.execute("INSERT INTO app_state(key, value) VALUES (?, ?)", [key, JSON.stringify(value)]);
    };
    await putState("selected_fiscal_key", settings.selectedFiscalKey ?? "");
    await putState("last_voucher_dates", settings.lastVoucherDates ?? {});
    await putState("report_state", settings.reportState ?? {});
    await putState("report", settings.report ?? "");
    await putState("current_route", settings.currentRoute ?? "");
    await putState("editing_index", settings.editingIndex ?? null);
    await putState("working_voucher", data.workingVoucher ?? null);
    await countTable("app_state");
    return counts;
  }
  async function migrateFromPayload(db, payload) {
    let counts = {};
    await transaction(db, async () => {
      counts = await writeAllTables(db, payload.data);
      await db.execute("DROP TABLE IF EXISTS kv_store");
      await db.execute("INSERT INTO schema_version(version) VALUES (3)");
    });
    return counts;
  }
  async function persistPayload(db, payload) {
    let counts = {};
    await transaction(db, async () => {
      counts = await writeAllTables(db, payload.data);
      await db.execute("INSERT OR IGNORE INTO schema_version(version) VALUES (2)");
    });
    return counts;
  }
  async function loadStateMap(db) {
    const rows = await db.select("SELECT key, value FROM app_state");
    const map = /* @__PURE__ */ new Map();
    for (const r of rows) {
      const key = str(r, "key");
      const raw = str(r, "value");
      try {
        map.set(key, JSON.parse(raw));
      } catch {
        map.set(key, raw);
      }
    }
    return map;
  }
  function asString(v) {
    return typeof v === "string" ? v : "";
  }
  function asObject(v) {
    if (v != null && typeof v === "object" && !Array.isArray(v)) {
      return v;
    }
    return {};
  }
  function rebuildInvoiceRow(r) {
    const head = [
      str(r, "date"),
      str(r, "invoice_no"),
      str(r, "party"),
      num(r, "amount_cents")
      // DB 存 INTEGER；Cents 運行時就係 number
    ];
    const tail = [r["e4"], r["e5"], r["e6"]];
    let len = 0;
    for (let i = 0; i < tail.length; i++) {
      if (tail[i] != null) len = i + 1;
    }
    const extras = [];
    for (let i = 0; i < len; i++) {
      extras.push(tail[i] == null ? null : String(tail[i]));
    }
    return [...head, ...extras];
  }
  async function loadPayload(db) {
    var _a;
    const fyRows = await db.select(
      "SELECT key, start, label, date_from, date_to FROM fiscal_years ORDER BY rowid"
    );
    if (!fyRows.length) return null;
    const fiscalYears = fyRows.map((r) => ({
      start: num(r, "start"),
      key: str(r, "key"),
      label: str(r, "label"),
      from: str(r, "date_from"),
      to: str(r, "date_to")
    }));
    const accountRows = await db.select(
      `SELECT code, name, type, side, balance_cents, imported_balance_cents,
       custom, original_name, edited, created_fiscal_key
     FROM accounts ORDER BY rowid`
    );
    const accounts = accountRows.map((r) => {
      const a = {
        code: str(r, "code"),
        name: str(r, "name"),
        type: str(r, "type"),
        balance: num(r, "balance_cents"),
        importedBalance: num(r, "imported_balance_cents"),
        side: str(r, "side")
        // 本層寫入，值域受控
      };
      if (r["custom"] != null) a.custom = num(r, "custom") !== 0;
      if (r["original_name"] != null) a.originalName = str(r, "original_name");
      if (r["edited"] != null) a.edited = num(r, "edited") !== 0;
      if (r["created_fiscal_key"] != null) a.createdFiscalKey = str(r, "created_fiscal_key");
      return a;
    });
    const voucherRows = await db.select(
      `SELECT no, type, number_manual, date, description, allocation_invoice,
       made_by, checked_by, approved_by, supporting_path, supporting_mime
     FROM vouchers ORDER BY seq`
    );
    const vouchers = [];
    for (const r of voucherRows) {
      const no = str(r, "no");
      const lineRows = await db.select(
        `SELECT account_name, debit_cents, credit_cents, detail
       FROM voucher_lines WHERE voucher_no = ? ORDER BY line_index`,
        [no]
      );
      const lines = lineRows.map((lr) => ({
        account: str(lr, "account_name"),
        debit: num(lr, "debit_cents"),
        credit: num(lr, "credit_cents"),
        detail: str(lr, "detail")
      }));
      const attRows = await db.select(
        "SELECT name, mime, path, data_b64 FROM attachments WHERE voucher_no = ? ORDER BY seq",
        [no]
      );
      const attachments = attRows.map((ar) => ({
        name: str(ar, "name"),
        mime: str(ar, "mime"),
        path: ar["path"] == null ? null : String(ar["path"]),
        dataB64: ar["data_b64"] == null ? null : String(ar["data_b64"])
      }));
      const v = {
        no,
        type: str(r, "type"),
        numberManual: num(r, "number_manual") !== 0,
        date: str(r, "date"),
        desc: str(r, "description"),
        lines,
        madeBy: str(r, "made_by"),
        checkedBy: str(r, "checked_by"),
        approvedBy: str(r, "approved_by"),
        allocationInvoice: str(r, "allocation_invoice"),
        attachments
      };
      if (r["supporting_path"] != null) v.supportingPath = str(r, "supporting_path");
      if (r["supporting_mime"] != null) {
        v["supportingMime"] = str(r, "supporting_mime");
      }
      vouchers.push(v);
    }
    const salesInvoiceRows = await db.select(
      "SELECT date, invoice_no, party, amount_cents, e4, e5, e6 FROM invoices WHERE kind = 'sales' ORDER BY seq"
    );
    const purchaseInvoiceRows = await db.select(
      "SELECT date, invoice_no, party, amount_cents, e4, e5, e6 FROM invoices WHERE kind = 'purchase' ORDER BY seq"
    );
    const salesInvoices = salesInvoiceRows.map(rebuildInvoiceRow);
    const purchaseInvoices = purchaseInvoiceRows.map(rebuildInvoiceRow);
    const remarkRows = await db.select("SELECT invoice_no, remark FROM invoice_remarks ORDER BY rowid");
    const invoiceRemarks = {};
    for (const r of remarkRows) invoiceRemarks[str(r, "invoice_no")] = str(r, "remark");
    const allocRows = await db.select(
      `SELECT kind, voucher_no, invoice_no, party, amount_cents, date, source, manual
     FROM allocations ORDER BY seq`
    );
    const allocations = allocRows.map((r) => {
      const a = {
        kind: str(r, "kind"),
        invoiceNo: str(r, "invoice_no"),
        party: str(r, "party"),
        date: str(r, "date"),
        amount: num(r, "amount_cents"),
        voucher: str(r, "voucher_no"),
        source: str(r, "source")
      };
      if (r["manual"] != null) a.manual = num(r, "manual") !== 0;
      return a;
    });
    const reviewRows = await db.select(
      "SELECT voucher_no, kind, party, amount_cents, reason FROM allocation_reviews ORDER BY seq"
    );
    const allocationReview = reviewRows.map((r) => ({
      voucher: str(r, "voucher_no"),
      kind: str(r, "kind"),
      party: str(r, "party"),
      amount: num(r, "amount_cents"),
      reason: str(r, "reason")
    }));
    const ddRows = await db.select("SELECT fiscal_key FROM deleted_data_years ORDER BY rowid");
    const deletedDataYears = ddRows.map((r) => str(r, "fiscal_key"));
    const baRows = await db.select(
      "SELECT fiscal_key, account_name, amount_cents FROM balance_adjustments ORDER BY rowid"
    );
    const balanceAdjustments = {};
    for (const r of baRows) {
      const fy = str(r, "fiscal_key");
      (balanceAdjustments[fy] ?? (balanceAdjustments[fy] = {}))[str(r, "account_name")] = num(r, "amount_cents");
    }
    const obRows = await db.select(
      `SELECT fiscal_key, account_name, debit_cents, credit_cents, is_plain_number
     FROM opening_balances ORDER BY rowid`
    );
    const openingBalances = {};
    for (const r of obRows) {
      const fy = str(r, "fiscal_key");
      const accountName = str(r, "account_name");
      const value = num(r, "is_plain_number") !== 0 ? num(r, "debit_cents") : { debit: num(r, "debit_cents"), credit: num(r, "credit_cents") };
      (openingBalances[fy] ?? (openingBalances[fy] = {}))[accountName] = value;
    }
    const oiRows = await db.select(
      `SELECT fiscal_key, account_name, invoice_no, invoice_date, amount_cents
     FROM opening_invoices ORDER BY seq`
    );
    const openingInvoiceDetails = {};
    for (const r of oiRows) {
      const fy = str(r, "fiscal_key");
      const accountName = str(r, "account_name");
      const item = {
        date: str(r, "invoice_date"),
        invoiceNo: str(r, "invoice_no"),
        amount: num(r, "amount_cents")
      };
      ((_a = openingInvoiceDetails[fy] ?? (openingInvoiceDetails[fy] = {}))[accountName] ?? (_a[accountName] = [])).push(item);
    }
    const rcRows = await db.select(
      `SELECT account_key, confirmed_by, confirmed_date, note,
       invoice_outstanding_cents, account_balance_cents, difference_cents
     FROM reconciliation_confirmations ORDER BY rowid`
    );
    const reconciliationConfirmations = {};
    for (const r of rcRows) {
      reconciliationConfirmations[str(r, "account_key")] = {
        confirmedBy: str(r, "confirmed_by"),
        date: str(r, "confirmed_date"),
        note: str(r, "note"),
        invoiceOutstanding: num(r, "invoice_outstanding_cents"),
        accountBalance: num(r, "account_balance_cents"),
        difference: num(r, "difference_cents")
      };
    }
    const staffRows = await db.select("SELECT name, suppressed FROM staff_names ORDER BY rowid");
    const staffNames = [];
    const suppressedStaffNames = [];
    for (const r of staffRows) {
      if (num(r, "suppressed") !== 0) suppressedStaffNames.push(str(r, "name"));
      else staffNames.push(str(r, "name"));
    }
    const state = await loadStateMap(db);
    const editingIndexRaw = state.get("editing_index");
    const settings = {
      selectedFiscalKey: asString(state.get("selected_fiscal_key")),
      lastVoucherDates: asObject(state.get("last_voucher_dates")),
      reportState: asObject(state.get("report_state")),
      report: asString(state.get("report")),
      currentRoute: asString(state.get("current_route")),
      editingIndex: editingIndexRaw == null ? null : Number(editingIndexRaw)
    };
    const workingVoucherRaw = state.get("working_voucher");
    const workingVoucher = workingVoucherRaw == null ? null : workingVoucherRaw;
    return {
      backupFormat: "toys-gallery-accounting",
      schemaVersion: 2,
      appVersion: APP_VERSION,
      exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
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
        workingVoucher
      }
    };
  }
  return __toCommonJS(index_exports);
})();
