/**
 * desktop/db v2 測試（node --test 可跑）。
 *
 * 用 esbuild 將 index.ts（含 convert.ts + schema.ts，連同 web-src/version.ts
 * 同 web-src/money.ts 一齊）bundle 成 CJS，再經 node:sqlite（DatabaseSync）
 * 實作 DbPort 做測試。bundle 寫去 /tmp，唔污染 workspace。
 *
 * 測試：
 * 1. migration：fake v1 風格 payload（已正規化 v2 形狀）→ migrateFromPayload
 *    → 逐表對筆數＋抽查值（含期初數 plain number／{debit,credit} 形狀、附件
 *    metadata、manual 對銷、核對確認、人名 suppressed 合併）
 * 2. round-trip：同一 payload → persistPayload → loadPayload →
 *    assert.deepStrictEqual（排除 exportedAt）——必須零差異
 * 3. 空 payload（全新空白賬套形狀）round-trip；真空庫 loadPayload → null
 * 4. 附件 {name,mime,path} 存取；attachments 表內無 'data:' 字串殘留
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** 完整 fixture：v2 正規化形狀（整數分），模擬 v1 備份經 prepareRestore 後嘅數據 */
function makePayload() {
  return {
    backupFormat: 'toys-gallery-accounting',
    schemaVersion: 2,
    appVersion: '3.15.1',
    exportedAt: '2026-10-07T00:00:00.000Z',
    data: {
      vouchers: [
        {
          no: 'B040124',
          type: 'B',
          numberManual: false,
          date: '2024-04-05',
          desc: '收 Toy Hunters 貨款',
          lines: [
            { account: 'Bank - HSBC', debit: 100000, credit: 0, detail: '支票 123456' },
            { account: 'Accounts Receivable of Toy Hunters', debit: 0, credit: 100000, detail: 'INV-2024-001' },
          ],
          madeBy: 'Bin',
          checkedBy: 'KK',
          approvedBy: 'Boss',
          allocationInvoice: 'INV-2024-001',
          attachments: [
            { name: 'cheque.jpg', mime: 'image/jpeg', path: 'attachments/B040124/cheque.jpg' },
          ],
          supportingPath: 'attachments/B040124/cheque.jpg',
        },
        {
          no: 'T040224',
          type: 'T',
          numberManual: true,
          date: '2024-04-12',
          desc: '辦公室租金',
          lines: [
            { account: 'Rent', debit: 1500000, credit: 0, detail: '4月租金' },
            { account: 'Bank - HSBC', debit: 0, credit: 1500000, detail: '' },
          ],
          madeBy: 'Bin',
          checkedBy: '',
          approvedBy: '',
          allocationInvoice: '',
          attachments: [],
        },
      ],
      accounts: [
        { code: '1000', name: 'Bank - HSBC', type: '資產', balance: 5000000, importedBalance: 0, side: 'dr' },
        { code: '1100', name: 'Accounts Receivable of Toy Hunters', type: '資產', balance: 9910000, importedBalance: 10010000, side: 'dr', custom: true },
        { code: '3100', name: 'Capital', type: '權益', balance: -20000000, importedBalance: 0, side: 'cr', originalName: 'Share Capital', edited: true, createdFiscalKey: 'FY2023' },
      ],
      salesInvoices: [
        ['2024-04-01', 'INV-2024-001', 'Toy Hunters', 100000, 'voucher', 'B040124'],
        ['2024-04-02', 'INV-2024-002', 'Toy Hunters', 25000],
      ],
      purchaseInvoices: [
        ['2024-04-03', 'PO-100', 'Supplier A', 50000, 'opening'],
      ],
      invoiceRemarks: { 'INV-2024-001': '已收', 'PO-100': '待付' },
      allocations: [
        { kind: 'AR', invoiceNo: 'INV-2024-001', party: 'Toy Hunters', date: '2024-04-05', amount: 100000, voucher: 'B040124', source: '指定發票', manual: true },
        { kind: 'AR', invoiceNo: 'INV-2024-002', party: 'Toy Hunters', date: '2024-04-06', amount: 25000, voucher: 'B040226', source: 'FIFO' },
      ],
      allocationReview: [
        { voucher: 'B040326', kind: 'AP', party: 'Supplier A', amount: 50000, reason: '對唔上發票' },
      ],
      fiscalYears: [
        { start: 2024, key: 'FY2024', label: '2024/25', from: '2024-04-01', to: '2025-03-31' },
        { start: 2023, key: 'FY2023', label: '2023/24', from: '2023-04-01', to: '2024-03-31' },
      ],
      deletedDataYears: ['FY2022'], // FY2022 已不在 fiscalYears（測 FK 例外）
      balanceAdjustments: { FY2024: { 'Bank - HSBC': 500 } },
      openingBalances: {
        FY2024: {
          'Bank - HSBC': 5000000, // plain number 形狀（語義=debit）
          Capital: { debit: 0, credit: 20000000 }, // {debit,credit} 形狀
        },
      },
      openingInvoiceDetails: {
        FY2024: {
          'Accounts Receivable of Toy Hunters': [
            { date: '2024-03-28', invoiceNo: 'INV-OLD-9', amount: 10010000 },
          ],
        },
      },
      reconciliationConfirmations: {
        'Accounts Receivable of Toy Hunters': {
          confirmedBy: 'Bin',
          date: '2024-04-30',
          note: 'ok',
          invoiceOutstanding: 9910000,
          accountBalance: 9910000,
          difference: 0,
        },
      },
      staffNames: ['Bin', 'KK'],
      suppressedStaffNames: ['Old Staff'], // 同 staffNames 唔重疊（app 刪除人名時會由 staffNames 移除）
      settings: {
        selectedFiscalKey: 'FY2024',
        lastVoucherDates: { FY2024: '2024-04-12' },
        reportState: { month: { key: '2024-04' }, date: '', nameQuery: '', invoiceQuery: '' },
        report: 'trial',
        currentRoute: 'dashboard',
        editingIndex: 1,
      },
      workingVoucher: null,
    },
  };
}

/** 全新空白賬套形狀（有財年、其餘全空） */
function makeEmptyPayload() {
  return {
    backupFormat: 'toys-gallery-accounting',
    schemaVersion: 2,
    appVersion: '3.15.1',
    exportedAt: '2026-10-07T00:00:00.000Z',
    data: {
      vouchers: [],
      accounts: [],
      salesInvoices: [],
      purchaseInvoices: [],
      invoiceRemarks: {},
      allocations: [],
      allocationReview: [],
      fiscalYears: [
        { start: 2024, key: 'FY2024', label: '2024/25', from: '2024-04-01', to: '2025-03-31' },
      ],
      deletedDataYears: [],
      balanceAdjustments: {},
      openingBalances: {},
      openingInvoiceDetails: {},
      reconciliationConfirmations: {},
      staffNames: [],
      suppressedStaffNames: [],
      settings: {
        selectedFiscalKey: 'FY2024',
        lastVoucherDates: {},
        reportState: {},
        report: 'trial',
        currentRoute: 'dashboard',
        editingIndex: 0,
      },
      workingVoucher: null,
    },
  };
}

/** node:sqlite 實作 DbPort（:memory:，每 test 獨立） */
function makePort() {
  const db = new DatabaseSync(':memory:');
  const split = (sql) =>
    sql.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
  return {
    db,
    execute: async (query, values = []) => {
      const stmts = split(query);
      if (values.length && stmts.length > 1) {
        throw new Error('multi-statement execute with values is not supported');
      }
      for (const s of stmts) {
        const stmt = db.prepare(s);
        // PRAGMA 回傳列，用 get() 唔用 run()
        if (/^\s*pragma/i.test(s)) stmt.get(...values);
        else stmt.run(...values);
      }
    },
    select: async (query, values = []) => db.prepare(query).all(...values),
  };
}

const stripExportedAt = (payload) => {
  const { exportedAt: _drop, ...rest } = payload;
  return rest;
};

/** node:sqlite 回傳 null-prototype 列；轉 plain object 先至同字面量比較 */
const plain = (value) => JSON.parse(JSON.stringify(value));

describe('desktop db v2', () => {
  let api;
  before(async () => {
    const outfile = '/tmp/tg-db-test-bundle.cjs';
    await esbuild.build({
      entryPoints: [path.join(dir, 'index.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile,
      logLevel: 'silent',
    });
    api = require(outfile);
  });

  it('initDatabase：全新空庫 → isFresh；seedFresh 後 → 正常', async () => {
    const port = makePort();
    const fresh = await api.initDatabase(port);
    assert.deepEqual(fresh, { version: 0, needsMigration: false, isFresh: true });
    await api.seedFresh(port);
    const after = await api.initDatabase(port);
    assert.deepEqual(after, { version: 2, needsMigration: false, isFresh: false });
    const ver = await port.select('SELECT version FROM schema_version');
    assert.deepEqual(ver.map((r) => r.version), [2]);
    port.db.close();
  });

  it('migration：v1（kv_store）→ v2，筆數＋抽查值', async () => {
    const port = makePort();
    await api.initDatabase(port);
    // 偽造 v1 庫：kv_store + app_state
    await port.execute('CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    await port.execute('INSERT INTO kv_store(key, value) VALUES (?, ?)', [
      'app_state',
      JSON.stringify({ v: 1 }),
    ]);
    const st = await api.initDatabase(port);
    assert.equal(st.needsMigration, true);
    assert.equal(st.isFresh, false);

    const payload = makePayload();
    const counts = await api.migrateFromPayload(port, payload);
    assert.equal(counts.vouchers, 2);
    assert.equal(counts.voucher_lines, 4);
    assert.equal(counts.attachments, 1);
    assert.equal(counts.accounts, 3);
    assert.equal(counts.invoices, 3);
    assert.equal(counts.invoice_remarks, 2);
    assert.equal(counts.allocations, 2);
    assert.equal(counts.allocation_reviews, 1);
    assert.equal(counts.fiscal_years, 2);
    assert.equal(counts.opening_balances, 2);
    assert.equal(counts.opening_invoices, 1);
    assert.equal(counts.balance_adjustments, 1);
    assert.equal(counts.reconciliation_confirmations, 1);
    assert.equal(counts.staff_names, 3); // Bin, KK, Old Staff
    assert.equal(counts.deleted_data_years, 1);
    assert.equal(counts.app_state, 7);

    // kv_store 已 drop，schema_version=2
    const kv = await port.select(
      "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='kv_store'",
    );
    assert.equal(kv.length, 0);
    const ver = await port.select('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1');
    assert.equal(ver[0].version, 2);

    // 抽查：期初數形狀原樣保留
    const ob = await port.select(
      'SELECT account_name, debit_cents, credit_cents, is_plain_number FROM opening_balances ORDER BY account_name',
    );
    assert.deepEqual(
      plain(ob).map((r) => [r.account_name, r.debit_cents, r.credit_cents, r.is_plain_number]),
      [
        ['Bank - HSBC', 5000000, 0, 1],
        ['Capital', 0, 20000000, 0],
      ],
    );
    // 抽查：voucher fiscal_key 由 date 推導
    const vf = await port.select('SELECT no, fiscal_key FROM vouchers ORDER BY no');
    assert.deepEqual(
      plain(vf).map((r) => [r.no, r.fiscal_key]),
      [['B040124', 'FY2024'], ['T040224', 'FY2024']],
    );
    // 抽查：人名 suppressed 合併
    const staff = await port.select('SELECT name, suppressed FROM staff_names ORDER BY name');
    assert.deepEqual(
      plain(staff).map((r) => [r.name, r.suppressed]),
      [['Bin', 0], ['KK', 0], ['Old Staff', 1]],
    );
    // 抽查：allocation manual optional（有→1，無→NULL）
    const al = await port.select('SELECT invoice_no, manual FROM allocations ORDER BY seq');
    assert.deepEqual(
      plain(al).map((r) => [r.invoice_no, r.manual]),
      [['INV-2024-001', 1], ['INV-2024-002', null]],
    );
    // 抽查：invoice tuple 尾部欄
    const inv = await port.select(
      "SELECT invoice_no, e4, e5, e6 FROM invoices WHERE kind='sales' ORDER BY seq",
    );
    assert.deepEqual(
      plain(inv).map((r) => [r.invoice_no, r.e4, r.e5, r.e6]),
      [['INV-2024-001', 'voucher', 'B040124', null], ['INV-2024-002', null, null, null]],
    );

    // migrate 後 loadPayload 同輸入零差異（除 exportedAt）
    const loaded = await api.loadPayload(port);
    assert.ok(loaded);
    assert.deepStrictEqual(stripExportedAt(loaded), stripExportedAt(payload));
    port.db.close();
  });

  it('round-trip：persistPayload → loadPayload 零差異（含 workingVoucher 非 null）', async () => {
    const port = makePort();
    await api.initDatabase(port);
    await api.seedFresh(port);
    const payload = makePayload();
    // workingVoucher 非 null 變體
    payload.data.workingVoucher = structuredClone(payload.data.vouchers[0]);
    const counts = await api.persistPayload(port, payload);
    assert.equal(counts.vouchers, 2);
    const loaded = await api.loadPayload(port);
    assert.ok(loaded);
    assert.equal(loaded.backupFormat, 'toys-gallery-accounting');
    assert.equal(loaded.schemaVersion, 2);
    assert.equal(loaded.appVersion, '3.15.1');
    assert.ok(!Number.isNaN(Date.parse(loaded.exportedAt)));
    assert.deepStrictEqual(stripExportedAt(loaded), stripExportedAt(payload));
    port.db.close();
  });

  it('round-trip：空 payload（全新空白賬套）；真空庫 loadPayload → null', async () => {
    const port = makePort();
    await api.initDatabase(port);
    // 真空庫（未 persist）：fiscal_years 空 → null
    assert.equal(await api.loadPayload(port), null);
    const payload = makeEmptyPayload();
    await api.persistPayload(port, payload);
    const loaded = await api.loadPayload(port);
    assert.ok(loaded);
    assert.deepStrictEqual(stripExportedAt(loaded), stripExportedAt(payload));
    port.db.close();
  });

  it('附件：{name,mime,path} 存取；表內無 dataURL 殘留', async () => {    const port = makePort();
    await api.initDatabase(port);
    await api.persistPayload(port, makePayload());
    const atts = await port.select('SELECT name, mime, path FROM attachments ORDER BY seq');
    assert.deepEqual(plain(atts), [
      { name: 'cheque.jpg', mime: 'image/jpeg', path: 'attachments/B040124/cheque.jpg' },
    ]);
    // 全表掃描：任何值唔可以含 'data:'（dataURL 殘留）
    const all = await port.select('SELECT * FROM attachments');
    const dumped = JSON.stringify(all);
    assert.ok(!dumped.includes('data:'), 'attachments 表內發現 dataURL 殘留');
    assert.ok(!dumped.includes('dataURL'), 'attachments 表內發現 dataURL 殘留');
    port.db.close();
  });

  it('edge：人名兩邊重疊 → suppressed 贏（有損合併，文件註明）', async () => {
    const port = makePort();
    await api.initDatabase(port);
    const payload = makeEmptyPayload();
    payload.data.staffNames = ['A'];
    payload.data.suppressedStaffNames = ['A'];
    await api.persistPayload(port, payload);
    const loaded = await api.loadPayload(port);
    assert.ok(loaded);
    assert.deepEqual(loaded.data.staffNames, []);
    assert.deepEqual(loaded.data.suppressedStaffNames, ['A']);
    port.db.close();
  });

  it('edge：科目缺 side → 由 type 推斷（資產/成本/費用=dr，其餘=cr），唔 rollback', async () => {
    // 2026-10-07 用戶個案：舊／手改備份嘅科目無 side，side NOT NULL 令成個
    // persistPayload transaction rollback，表預覽全 0，重啟後數據消失
    const port = makePort();
    await api.initDatabase(port);
    const payload = makeEmptyPayload();
    payload.data.accounts = [
      { code: '1000', name: 'Bank - HSBC', type: '資產', balance: 5000000, importedBalance: 0 },
      { code: '2000', name: 'Loan', type: '負債', balance: 0, importedBalance: 0 },
      { code: '4000', name: 'Sales', type: '收入', balance: 0, importedBalance: 0 },
      { code: '5000', name: 'COGS', type: '成本', balance: 0, importedBalance: 0 },
      { code: '6000', name: 'Rent', type: '費用', balance: 0, importedBalance: 0, side: 'dr' },
    ];
    const counts = await api.persistPayload(port, payload);
    assert.equal(counts.accounts, 5);
    const rows = await port.select('SELECT name, side FROM accounts ORDER BY code');
    assert.deepEqual(plain(rows), [
      { name: 'Bank - HSBC', side: 'dr' },
      { name: 'Loan', side: 'cr' },
      { name: 'Sales', side: 'cr' },
      { name: 'COGS', side: 'dr' },
      { name: 'Rent', side: 'dr' },
    ]);
    // loadPayload 讀返：side 有值
    const loaded = await api.loadPayload(port);
    assert.ok(loaded);
    assert.deepEqual(
      loaded.data.accounts.map((a) => [a.code, a.side]),
      [['1000', 'dr'], ['2000', 'cr'], ['4000', 'cr'], ['5000', 'dr'], ['6000', 'dr']],
    );
    port.db.close();
  });
});
