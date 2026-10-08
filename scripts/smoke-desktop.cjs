#!/usr/bin/env node
/**
 * 桌面版 3.15.1 smoke test。
 *
 * headless Chromium 載入實際 src/index.html，mock __TAURI_INTERNALS__.invoke
 * 接真 SQLite 檔（node:sqlite），驗證：
 *  - badge v3.22.0 / __TG__.desktopVersion / __TG_DB__ 存在
 *  - 啟動：全新 DB → 空白賬套
 *  - importExcelData 匯入科目 → UI 入銷貨 voucher
 *  - 關聯表有數（vouchers / voucher_lines，金額係整數分）
 *  - reload 後由 SQLite 還原
 *  - 報表數字正確、native CSV 下載落地
 *  - 零 pageerror
 *
 * 用法：node scripts/smoke-desktop.cjs [--workdir <dir>]
 * （src/index.html 必須已由 scripts/build-desktop.cjs 產出，含 db-layer.js）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const wi = args.indexOf('--workdir');
const WORK = wi >= 0 ? args[wi + 1] : fs.mkdtempSync(path.join(os.tmpdir(), 'tg-smoke-'));
fs.mkdirSync(WORK, { recursive: true });

const puppeteer = require('/home/hatch/workspace/hk-legal-dora/node_modules/puppeteer-core');
const CHROME = path.join(
  os.homedir(), '.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell');

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra: extra || '' });
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  — ' + extra : ''));
}

// ---- SQLite（mock 後端：支援多 DB 檔，切換數據位置測試用） ----
const dbByPath = new Map();
function resolveDbPath(connStr){
  const p = String(connStr).split(':').slice(1).join(':');
  return p.startsWith('/') ? p : path.join(WORK, 'appconfig', p);
}
function dbFor(connStr){
  const rp = resolveDbPath(connStr);
  if(!dbByPath.has(rp)){
    fs.mkdirSync(path.dirname(rp), { recursive: true });
    dbByPath.set(rp, new DatabaseSync(rp));
  }
  return dbByPath.get(rp);
}
let currentDbPath = null;
function curDb(){ return dbByPath.get(currentDbPath); }
function mockExecute(query, values) {
  values = values || [];
  const q = String(query).trim();
  const db = curDb();
  if (values.length === 0) { db.exec(q); return; }
  db.prepare(q).run(...values);
}
function mockSelect(query, values) {
  values = values || [];
  return curDb().prepare(String(query)).all(...values);
}

let savedDialogPath = null;
const savedFiles = {};
const mockDialogOpenQueue = []; // 測試預設 dialog|open 回傳值
async function mockInvoke(cmd, a, options) {
  a = a || {}; options = options || {};
  if (cmd === 'plugin:sql|load') { currentDbPath = resolveDbPath(a.db); dbFor(a.db); return 1; }
  if (cmd === 'plugin:sql|close') return true;
  if (cmd === 'plugin:sql|execute') { mockExecute(a.query, a.values); return; }
  if (cmd === 'plugin:sql|select') return mockSelect(a.query, a.values);
  if (cmd === 'plugin:dialog|save') {
    savedDialogPath = path.join(WORK, String(a.options.defaultPath || 'out.dat'));
    return savedDialogPath;
  }
  if (cmd === 'plugin:dialog|open') return mockDialogOpenQueue.length ? mockDialogOpenQueue.shift() : null;
  if (cmd === 'plugin:fs|mkdir') { fs.mkdirSync(a.path, { recursive: true }); return; }
  if (cmd === 'plugin:fs|exists') return fs.existsSync(a.path);
  if (cmd === 'plugin:fs|write_file') {
    // glue 調用：invoke('plugin:fs|write_file', data, {headers:{path:encodeURIComponent(path)}})
    // 注意：page.exposeFunction 會把 Uint8Array 序列化成 {0:..,1:..} plain object，要還原
    const p = decodeURIComponent((options.headers && options.headers.path) || '');
    const bytes = (a instanceof Uint8Array) ? a
      : (Array.isArray(a) ? Uint8Array.from(a) : Uint8Array.from(Object.values(a || {})));
    const buf = Buffer.from(bytes);
    savedFiles[p] = buf;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf);
    return;
  }
  if (cmd === 'plugin:fs|read_file') {
    // 注意：真 Tauri 回傳 ArrayBuffer，但 exposeFunction 傳唔到 ArrayBuffer（變 {}），
    // 所以呢度回傳 Array；ArrayBuffer 分支由 U5 在頁內直接構造測試。
    const buf = fs.readFileSync(a.path);
    return Array.from(buf);
  }
  if (cmd === 'plugin:path|resolve_directory') return (a.directory === 13) ? path.join(WORK, 'appconfig') : WORK;
  throw new Error('mock 未處理的 invoke: ' + cmd);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 最小 v1（schemaVersion 1，浮點金額）JSON 備份樣本 */
function makeV1Sample(){
  return {
    backupFormat: 'toys-gallery-accounting',
    schemaVersion: 1,
    appVersion: '3.14',
    exportedAt: new Date().toISOString(),
    data: {
      vouchers: [{
        no: 'B010101', type: 'bank', numberManual: false, date: '2026-10-01', desc: 'V1TEST',
        lines: [
          { account: 'Bank Saving Account', debit: 100.1, credit: 0, detail: '' },
          { account: 'Sales', debit: 0, credit: 100.1, detail: '' }
        ],
        madeBy: 'T', checkedBy: 'T', approvedBy: 'T', allocationInvoice: '', attachments: []
      }],
      accounts: [
        { code: '1000', name: 'Bank Saving Account', type: '資產', balance: 100.1, importedBalance: 0, side: 'dr' },
        { code: '4000', name: 'Sales', type: '收入', balance: 0, importedBalance: 0, side: 'cr' }
      ],
      salesInvoices: [], purchaseInvoices: [], invoiceRemarks: {},
      allocations: [], allocationReview: [],
      fiscalYears: [{ start: 2026, key: '2026', label: 'FY2026/27', from: '2026-04-01', to: '2027-03-31' }],
      deletedDataYears: [], balanceAdjustments: {},
      openingBalances: {}, openingInvoiceDetails: {},
      reconciliationConfirmations: {},
      staffNames: [], suppressedStaffNames: [],
      settings: { selectedFiscalKey: '2026', lastVoucherDates: {}, reportState: {}, report: 'trial', currentRoute: 'dashboard', editingIndex: null },
      workingVoucher: null
    }
  };
}

(async () => {
  // 靜態 server（serve src/）
  const http = require('http');
  const handler = (req, res) => {
    let p = path.join(ROOT, 'src', decodeURIComponent(req.url.split('?')[0]));
    if (req.url === '/' || req.url === '/index.html') p = path.join(ROOT, 'src', 'index.html');
    fs.readFile(p, (e, data) => {
      if (e) { res.writeHead(404); res.end('nf'); return; }
      const ct = p.endsWith('.js') ? 'text/javascript' : 'text/html';
      res.writeHead(200, { 'Content-Type': ct });
      res.end(data);
    });
  };
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await puppeteer.launch({
    executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/ERR_|Failed to load resource|404/.test(m.text()))
      errs.push('console: ' + m.text().slice(0, 150));
  });

  await page.exposeFunction('__tgMockInvoke', (cmd, a, o) => mockInvoke(cmd, a, o));
  await page.evaluateOnNewDocument(() => {
    window.__TAURI_INTERNALS__ = {
      invoke: (cmd, args, options) => window.__tgMockInvoke(cmd, args, options),
    };
  });
  await page.goto(base + '/index.html', { waitUntil: 'networkidle0', timeout: 60000 });
  await sleep(2500);
  // 登入閘：直接加 authenticated（同 web 測試一致）
  await page.evaluate(() => document.body.classList.add('authenticated'));
  await sleep(1500);

  // T1 badge（桌面版＋核心兩個版本；Web 核心版本喺 S2 驗）
  const badge = await page.evaluate(() =>
    (document.querySelector('.version-badge') || {}).textContent || null);
  check('T1 badge 顯示 v3.22.0＋核心 v3.15.1', badge === 'v3.22.0核心 v3.15.1', String(badge));
  // T2 bridge
  const tgVer = await page.evaluate(() => window.__TG__ && window.__TG__.desktopVersion);
  check('T2 __TG__.desktopVersion = 3.22.0', tgVer === "3.22.0", String(tgVer));
  const hasDb = await page.evaluate(() => !!window.__TG_DB__);
  check('T3 __TG_DB__ 存在', hasDb);
  // T4 啟動狀態（全新 DB → 空白賬套）
  const status = await page.evaluate(() =>
    (document.getElementById('backupStatus') || {}).textContent || '');
  check('T4 啟動狀態', /空白|載入/.test(status), status.slice(0, 40));
  // T5 schema_version = 4
  let ver = null;
  try { ver = mockSelect('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')[0]; } catch (e) {}
  check('T5 schema_version = 4', ver && ver.version === 4, JSON.stringify(ver));
  // T6 關聯表存在
  const tables = mockSelect("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
  check('T6 關聯表齊全', ['vouchers', 'voucher_lines', 'accounts', 'fiscal_years', 'attachments'].every((t) => tables.includes(t)),
    tables.length + ' tables');

  // T7 importExcelData 匯入科目
  const impRes = await page.evaluate(() => window.__TG__.importExcelData({
    accounts: [
      { code: '1000', name: 'Bank Saving Account', type: '資產' },
      { code: '4000', name: 'Sales', type: '收入' },
      { code: '1101', name: 'Accounts Receivable of SmokeTest', type: '資產' },
    ],
    opening: [],
  }));
  check('T7 匯入 3 科目', impRes && impRes.addedAccounts === 3, JSON.stringify(impRes));

  // T8 UI 入銷貨 voucher（Dr AR 22000 / Cr Sales 22000）
  await page.evaluate(() => {
    const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
    document.querySelector('[data-route="voucher"]').click();
  });
  await sleep(600);
  const posted = await page.evaluate(async () => {
    const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
    const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
    const setRow = async (i, acct, debit, credit) => {
      const rows = document.querySelectorAll('.entry-row');
      const row = rows[i];
      const a = row.querySelector('.acct'); a.value = acct; fire(a, 'input'); await sleep2(300);
      const opt = document.querySelector('.account-option');
      if (opt) opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      const d = row.querySelector('.debit'); d.value = debit; fire(d, 'input');
      const c = row.querySelector('.credit'); c.value = credit; fire(c, 'input');
    };
    const dateEl = document.getElementById('voucherDate');
    dateEl.value = '2026-10-01'; fire(dateEl, 'change'); await sleep2(300);
    document.getElementById('voucherDesc').value = 'SMOKE-SALES';
    await setRow(0, 'Accounts Receivable of SmokeTest', '22000', '0');
    await setRow(1, 'Sales', '0', '22000');
    for (const id of ['madeBy', 'checkedBy', 'approvedBy']) {
      const el = document.getElementById(id); el.value = 'T'; fire(el, 'input');
    }
    await sleep2(400);
    const btn = document.getElementById('postBtn');
    if (btn.disabled) return { ok: false, reason: 'postBtn disabled' };
    const no = document.getElementById('voucherNoInput').value;
    btn.click(); await sleep2(800);
    return { ok: true, no };
  });
  check('T8 UI 入銷貨 voucher', posted && posted.ok, JSON.stringify(posted));
  await sleep(2200); // 等 debounce persist

  // T9 關聯表有數＋整數分
  let vRows = [], lRows = [];
  try {
    vRows = mockSelect('SELECT no, type, date FROM vouchers');
    lRows = mockSelect('SELECT voucher_no, account_name, debit_cents, credit_cents FROM voucher_lines ORDER BY line_index');
  } catch (e) { check('T9 讀關聯表', false, e.message); }
  check('T9 vouchers 表有 1 張', vRows.length === 1, JSON.stringify(vRows.map((r) => r.no)));
  const centsOk = lRows.length === 2 &&
    lRows[0].debit_cents === 2200000 && lRows[0].credit_cents === 0 &&
    lRows[1].debit_cents === 0 && lRows[1].credit_cents === 2200000;
  check('T10 voucher_lines 整數分', centsOk, JSON.stringify(lRows));
  const acctRows = mockSelect('SELECT code FROM accounts');
  check('T11 accounts 表有科目', acctRows.length >= 3, acctRows.length + ' accounts');

  // T12 reload → 由 SQLite 還原
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(2500);
  await page.evaluate(() => document.body.classList.add('authenticated'));
  await sleep(1200);
  const vCount = await page.evaluate(() =>
    document.querySelectorAll('#voucherListBody tr').length);
  check('T12 reload 後 voucher 還在', vCount >= 1, vCount + ' rows');

  // T13 報表：P&L Sales = 22000
  const plSales = await page.evaluate(async () => {
    document.querySelector('[data-route="reports"]').click();
    await new Promise((r) => setTimeout(r, 400));
    document.querySelector('[data-report="pl"]').click();
    await new Promise((r) => setTimeout(r, 600));
    return document.getElementById('reportCard').innerText.slice(0, 2000);
  });
  check('T13 P&L 有 Sales 22,000', /22,000/.test(plSales), plSales.slice(0, 80).replace(/\n/g, ' '));

  // T14 native CSV 下載落地
  savedDialogPath = null;
  await page.evaluate(() => {
    const btn = document.getElementById('exportReport');
    if (btn) btn.click();
  });
  await sleep(1500);
  const csvOk = savedDialogPath && fs.existsSync(savedDialogPath);
  let csvHead = '';
  if (csvOk) csvHead = fs.readFileSync(savedDialogPath, 'utf8').slice(0, 120);
  check('T14 native CSV 下載落地', csvOk && csvHead.includes('Account'), (savedDialogPath || 'no path') + ' :: ' + csvHead.slice(0, 60).replace(/\n/g, ' '));

  // ---- U. 桌面獨有 UI 修復 ----
  // U1 工具條：預設收起（只顯示財政年度列），㩒掣展開／收起
  const tbInit = await page.evaluate(() => {
    const section = document.querySelector('.fiscal-bar');
    const tgl = document.getElementById('tgToolsToggle');
    const bt = document.querySelector('.backup-tools');
    return { hasToggle: !!tgl,
             collapsed: !!(section && section.classList.contains('tg-collapsed')),
             hidden: !!(bt && getComputedStyle(bt).display === 'none') };
  });
  check('U1 工具條預設收起（只顯示財年列）', tbInit.hasToggle && tbInit.collapsed && tbInit.hidden, JSON.stringify(tbInit));
  await page.evaluate(() => document.getElementById('tgToolsToggle').click());
  await sleep(600);
  const tbExp = await page.evaluate(() => {
    const section = document.querySelector('.fiscal-bar');
    const bt = document.querySelector('.backup-tools');
    return { collapsed: section.classList.contains('tg-collapsed'),
             hidden: getComputedStyle(bt).display === 'none' };
  });
  check('U2 工具條㩒掣展開', !tbExp.collapsed && !tbExp.hidden, JSON.stringify(tbExp));
  await page.evaluate(() => document.getElementById('tgToolsToggle').click());
  await sleep(600);
  const tbCol = await page.evaluate(() =>
    document.querySelector('.fiscal-bar').classList.contains('tg-collapsed'));
  check('U3 工具條再㩒收起', tbCol === true);
  // U4 簽名列自適應：去 voucher 頁，簽名區唔可以爆出容器
  await page.evaluate(() => document.querySelector('[data-route="voucher"]').click());
  await sleep(800);
  const sigOk = await page.evaluate(() => {
    const el = document.querySelector('.signatures');
    if (!el) return { ok: false, why: 'no .signatures' };
    return { ok: el.scrollWidth <= el.clientWidth + 2, sw: el.scrollWidth, cw: el.clientWidth };
  });
  check('U4 簽名列唔爆出容器（自適應）', sigOk.ok === true, JSON.stringify(sigOk));

  // ---- S. 桌面設置 ----
  // S1 開啟設置畫面（隱藏 appShell）
  await page.evaluate(() => document.getElementById('tgSettingsNav').click());
  await sleep(1200);
  const setVisible = await page.evaluate(() => !document.getElementById('tgSettingsView').hidden);
  const appHidden = await page.evaluate(() => document.getElementById('appShell').style.display === 'none');
  check('S1 設置畫面開啟＋隱藏 app', setVisible && appHidden);
  const setVer = await page.evaluate(() => document.querySelector('.tgset-ver').textContent);
  check('S2 版本：桌面版 3.21.5＋Web核心 v3.15.1',
    /3\.22\.0/.test(setVer) && /v3\.15\.1/.test(setVer),
    setVer.trim().replace(/\s+/g, ' ').slice(0, 70));
  // S3/S4 表預覽
  await sleep(800);
  const tableCount = await page.evaluate(() => document.querySelectorAll('#tgTableList [data-table]').length);
  check('S3 表列表有筆數', tableCount >= 10, tableCount + ' tables');
  await page.evaluate(() => document.querySelector('#tgTableList [data-table="vouchers"]').click());
  await sleep(800);
  const pv = await page.evaluate(() => ({
    rows: document.querySelectorAll('#tgTablePreview tbody tr').length,
    cols: document.querySelectorAll('#tgTablePreview thead th').length,
  }));
  check('S4 vouchers 預覽行列', pv.rows >= 1 && pv.cols > 3, pv.rows + ' rows, ' + pv.cols + ' cols');
  // S5 切換數據位置到新目錄（複製賬套過去）
  const newDir = path.join(WORK, 'newloc');
  fs.mkdirSync(newDir, { recursive: true });
  mockDialogOpenQueue.push(newDir);
  await page.evaluate(() => document.getElementById('tgPickDbDir').click());
  await sleep(800);
  const swConfirm = await page.evaluate(() => !document.getElementById('tgDbSwitchConfirm').hidden);
  check('S5a 切換確認面板', swConfirm);
  await page.evaluate(() => document.getElementById('tgDbSwitchCopy').click());
  await sleep(3000);
  const newDbFile = path.join(newDir, 'toys-gallery.db');
  check('S5b 新位置 DB 檔建立', fs.existsSync(newDbFile));
  let cfgTxt = '';
  try{ cfgTxt = fs.readFileSync(path.join(WORK, 'appconfig', 'tg-config.json'), 'utf8'); }catch(e){}
  check('S5c config 寫入 dbPath', cfgTxt.includes(newDbFile), cfgTxt.slice(0, 90).replace(/\n/g, ' '));
  const newDbCount = new DatabaseSync(newDbFile).prepare('SELECT COUNT(*) AS c FROM vouchers').get().c;
  check('S5d 新庫有 voucher 數據', newDbCount >= 1, newDbCount + ' vouchers');
  // S6 切返預設位置
  await page.evaluate(() => document.getElementById('tgResetDbPath').click());
  await sleep(800);
  await page.evaluate(() => { const b = document.getElementById('tgDbSwitchGo'); if(b) b.click(); });
  await sleep(3000);
  let cfgTxt2 = '';
  try{ cfgTxt2 = fs.readFileSync(path.join(WORK, 'appconfig', 'tg-config.json'), 'utf8'); }catch(e){}
  check('S6 重設後 config 無 dbPath', cfgTxt2.indexOf('dbPath') < 0, cfgTxt2.slice(0, 60).replace(/\n/g, ' '));
  // S7/S8 關閉設置，app 還原，voucher 還在
  await page.evaluate(() => document.getElementById('tgSettingsClose').click());
  await sleep(600);
  const appBack = await page.evaluate(() =>
    document.getElementById('appShell').style.display !== 'none' &&
    document.getElementById('tgSettingsView').hidden);
  check('S7 關閉設置還原 app', appBack);
  const vCountS = await page.evaluate(() => document.querySelectorAll('#voucherListBody tr').length);
  check('S8 切返後 voucher 還在', vCountS >= 1, vCountS + ' rows');
  // S9 匯入 v2 JSON
  await page.evaluate(() => document.getElementById('tgSettingsNav').click());
  await sleep(800);
  const sampleV2 = await page.evaluate(async () => await window.__TG__.createBackupPayload());
  const v2Path = path.join(WORK, 'sample-v2.json');
  fs.writeFileSync(v2Path, JSON.stringify(sampleV2));
  mockDialogOpenQueue.push(v2Path);
  await page.evaluate(() => document.getElementById('tgPickJson').click());
  await sleep(1200);
  const sumVisible = await page.evaluate(() => !document.getElementById('tgImportSummary').hidden);
  const sumText = await page.evaluate(() => document.getElementById('tgImportSummary').innerText);
  check('S9a v2 匯入摘要', sumVisible && /Voucher/.test(sumText), sumText.replace(/\n/g, ' ').slice(0, 100));
  await page.evaluate(() => document.getElementById('tgImportGo').click());
  await sleep(3000);
  const impStatus = await page.evaluate(() => document.getElementById('tgSettingsStatus').textContent);
  check('S9b v2 匯入完成', /匯入完成/.test(impStatus), impStatus.slice(0, 60));
  const impV = curDb().prepare('SELECT COUNT(*) AS c FROM vouchers').get().c;
  check('S9c 匯入後 voucher 數一致', impV === sampleV2.data.vouchers.length, impV + ' vs ' + sampleV2.data.vouchers.length);
  // S10 匯入 v1 JSON（浮點→分）
  const v1Path = path.join(WORK, 'sample-v1.json');
  fs.writeFileSync(v1Path, JSON.stringify(makeV1Sample()));
  mockDialogOpenQueue.push(v1Path);
  await page.evaluate(() => document.getElementById('tgPickJson').click());
  await sleep(1200);
  const sumV1 = await page.evaluate(() => document.getElementById('tgImportSummary').innerText);
  check('S10a v1 摘要有轉分提示', /轉為分/.test(sumV1), sumV1.replace(/\n/g, ' ').slice(0, 120));
  await page.evaluate(() => document.getElementById('tgImportGo').click());
  await sleep(3000);
  const st10 = await page.evaluate(() => document.getElementById('tgSettingsStatus').textContent);
  check('S10b v1 匯入完成', /匯入完成/.test(st10), st10.slice(0, 60));
  const v1centsRows = curDb().prepare("SELECT debit_cents, credit_cents FROM voucher_lines WHERE voucher_no='B010101' ORDER BY line_index").all();
  const v1centsOk = v1centsRows.length === 2 && v1centsRows[0].debit_cents === 10010 && v1centsRows[1].credit_cents === 10010;
  check('S10c v1 浮點 100.1→10010 分', v1centsOk, JSON.stringify(v1centsRows));
  // U5 ArrayBuffer 讀檔（真 Tauri 行為）：頁內構造真 ArrayBuffer 回傳，
  // 驗 fsReadBytes 識得轉（之前 bug：Uint8Array.from(arrayBuffer) 出空→JSON EOF）
  const abPath = path.join(WORK, 'sample-ab.json');
  const abJson = JSON.stringify(makeV1Sample());
  fs.writeFileSync(abPath, abJson);
  mockDialogOpenQueue.push(abPath);
  await page.evaluate((p, txt) => {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals.__origInvoke) internals.__origInvoke = internals.invoke;
    internals.invoke = async (cmd, args, opts) => {
      if (cmd === 'plugin:fs|read_file' && args && args.path === p) {
        return new TextEncoder().encode(txt).buffer; // 真 ArrayBuffer，同真 Tauri 一樣
      }
      return internals.__origInvoke(cmd, args, opts);
    };
  }, abPath, abJson);
  await page.evaluate(() => document.getElementById('tgPickJson').click());
  await sleep(1200);
  const abSum = await page.evaluate(() => document.getElementById('tgImportSummary').innerText);
  const abOk = await page.evaluate(() =>
    !document.getElementById('tgImportSummary').hidden &&
    /Voucher/.test(document.getElementById('tgImportSummary').innerText) &&
    !/讀取失敗/.test(document.getElementById('tgSettingsStatus').textContent));
  check('U5 ArrayBuffer 讀檔匯入摘要正常', abOk, abSum.replace(/\n/g, ' ').slice(0, 100));
  await page.evaluate(() => {
    const internals = window.__TAURI_INTERNALS__;
    if (internals.__origInvoke) { internals.invoke = internals.__origInvoke; delete internals.__origInvoke; }
    document.getElementById('tgImportCancel').click();
  });
  // S11 v1 舊庫切換→自動 migration
  const v1dir = path.join(WORK, 'v1loc');
  fs.mkdirSync(v1dir, { recursive: true });
  const v1dbPath = path.join(v1dir, 'toys-gallery.db');
  {
    const v1db = new DatabaseSync(v1dbPath);
    v1db.exec('CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    v1db.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
    v1db.prepare('INSERT INTO schema_version(version) VALUES (1)').run();
    v1db.prepare("INSERT INTO kv_store(key, value) VALUES ('app_state', ?)").run(JSON.stringify(makeV1Sample()));
    v1db.close();
  }
  mockDialogOpenQueue.push(v1dbPath);
  await page.evaluate(() => document.getElementById('tgPickDbFile').click());
  await sleep(800);
  await page.evaluate(() => { const b = document.getElementById('tgDbSwitchGo'); if(b) b.click(); });
  await sleep(3000);
  const migVer = curDb().prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get();
  const migV = curDb().prepare('SELECT COUNT(*) AS c FROM vouchers').get().c;
  check('S11 v1 切換自動 migration', migVer && migVer.version === 4 && migV >= 1,
    'schema=' + (migVer && migVer.version) + ', vouchers=' + migV);
  // ---- X. Excel 完整支援 ----
  const XLSX = require('xlsx');
  const JSZip = require('jszip');

  // X1 範本下載（設置畫面開緊）
  savedDialogPath = null;
  await page.evaluate(() => document.getElementById('tgVoucherTpl').click());
  await sleep(1200);
  let tplOk = false, tplSheets = [];
  if (savedDialogPath && fs.existsSync(savedDialogPath)) {
    const twb = XLSX.readFile(savedDialogPath);
    tplSheets = twb.SheetNames;
    const tplRows = XLSX.utils.sheet_to_json(twb.Sheets['範本'], { header: 1, defval: '' });
    tplOk = tplRows[0] && /日期/.test(String(tplRows[0][0])) && /借方科目/.test(String(tplRows[0][4]));
  }
  check('X1 範本下載（說明＋範本）', tplOk && tplSheets.includes('說明'), tplSheets.join(','));

  // X2 匯入：3 張草稿（2 有效＋1 借貸不平）
  const impXlsxPath = path.join(WORK, 'voucher-import-test.xlsx');
  {
    const iwb = XLSX.utils.book_new();
    const iws = XLSX.utils.aoa_to_sheet([
      ['日期 Date','Voucher No.（吉=自動編號）','類型 Type（B=銀行 / T=轉賬）','摘要 Description','借方科目 Debit Account','借方金額 Debit Amount','貸方科目 Credit Account','貸方金額 Credit Amount','明細 Detail','製表 Made By','覆核 Checked By','批核 Approved By'],
      ['2026-10-05','TEX001','T','SMOKE-IMP-1','Bank Saving Account',1000.50,'','','D1','T','T','T'],
      ['2026-10-05','TEX001','T','SMOKE-IMP-1','','','Sales',1000.50,'D1','T','T','T'],
      ['2026-10-06','','B','SMOKE-IMP-2','Bank Saving Account',200,'','','D2','T','T','T'],
      ['2026-10-06','','B','SMOKE-IMP-2','','','Sales',200,'D2','T','T','T'],
      ['2026-10-05','TEX002','T','SMOKE-IMP-BAD','Bank Saving Account',100,'','','D3','T','T','T'],
      ['2026-10-05','TEX002','T','SMOKE-IMP-BAD','','','Sales',99,'D3','T','T','T'],
    ]);
    XLSX.utils.book_append_sheet(iwb, iws, '範本');
    XLSX.writeFile(iwb, impXlsxPath);
  }
  mockDialogOpenQueue.push(impXlsxPath);
  await page.evaluate(() => document.getElementById('tgVoucherImport').click());
  await sleep(1500);
  const impPreview = await page.evaluate(() => ({
    visible: !document.getElementById('tgVoucherImportBox').hidden,
    text: document.getElementById('tgVoucherImportBox').innerText.slice(0, 800),
  }));
  check('X2a 匯入預覽＋錯誤', impPreview.visible && /借貸不平/.test(impPreview.text),
    impPreview.text.replace(/\n/g, ' ').slice(0, 130));
  const vCountBefore = curDb().prepare('SELECT COUNT(*) AS c FROM vouchers').get().c;
  await page.evaluate(() => document.getElementById('tgVoucherImportGo').click());
  await sleep(3000);
  const impStatusX = await page.evaluate(() => document.getElementById('tgSettingsStatus').textContent);
  const vCountAfter = curDb().prepare('SELECT COUNT(*) AS c FROM vouchers').get().c;
  check('X2b 只匯入有效行（+2）', /匯入完成/.test(impStatusX) && vCountAfter === vCountBefore + 2,
    impStatusX.slice(0, 50) + ' | ' + vCountBefore + '→' + vCountAfter);
  const autoNos = curDb().prepare("SELECT no FROM vouchers WHERE no LIKE 'B10%26'").all().map((r) => r.no);
  check('X2c 自動編號 B100126', autoNos.length === 1 && /^B100126$/i.test(autoNos[0]), autoNos.join(','));
  const impLines = curDb().prepare(
    "SELECT SUM(debit_cents) AS dr, SUM(credit_cents) AS cr FROM voucher_lines WHERE voucher_no IN ('TEX001','" + autoNos[0] + "')").get();
  check('X2d 匯入分錄整數分＋平衡', impLines.dr === impLines.cr && impLines.dr === 120050,
    JSON.stringify(impLines));

  // X3 匯出：先經 JSON 匯入一張帶附件嘅 voucher
  const withAtt = await page.evaluate(() => window.__TG__.createBackupPayload());
  withAtt.data.vouchers[0].attachments = [
    { name: 'receipt.txt', type: 'text/plain', dataURL: 'data:text/plain;base64,aGVsbG8td29ybGQ=' }];
  const attPath = path.join(WORK, 'with-att.json');
  fs.writeFileSync(attPath, JSON.stringify(withAtt));
  mockDialogOpenQueue.push(attPath);
  await page.evaluate(() => document.getElementById('tgPickJson').click());
  await sleep(1200);
  await page.evaluate(() => document.getElementById('tgImportGo').click());
  await sleep(3000);
  savedDialogPath = null;
  await page.evaluate(() => document.getElementById('tgExportVouchers').click());
  await sleep(800);
  const dlgVisible = await page.evaluate(() => !!document.getElementById('tgVoucherExpDlg'));
  check('X3a 匯出範圍 dialog', dlgVisible);
  await page.evaluate(() => document.getElementById('tgExpGo').click());
  await sleep(3500);
  const zipOk = savedDialogPath && savedDialogPath.endsWith('.zip') && fs.existsSync(savedDialogPath);
  check('X3b zip 落地', zipOk, savedDialogPath || 'no path');
  if (zipOk) {
    const z = await JSZip.loadAsync(fs.readFileSync(savedDialogPath));
    const zipEntries = Object.keys(z.files).filter((f) => !z.files[f].dir);
    const xlsxFile = zipEntries.find((f) => f.endsWith('.xlsx'));
    const attFile = zipEntries.find((f) => f.startsWith('attachments/') && f.endsWith('receipt.txt'));
    let attContent = '';
    if (attFile) attContent = await z.file(attFile).async('string');
    check('X3c zip 有 xlsx＋附件', !!xlsxFile && !!attFile && attContent === 'hello-world',
      zipEntries.length + ' files');
    let linkOk = false, freezeOk = false, sumRows = 0;
    if (xlsxFile) {
      const zwb = XLSX.read(await z.file(xlsxFile).async('nodebuffer'), { type: 'buffer' });
      const wsS = zwb.Sheets['總表 Vouchers'];
      const srows = XLSX.utils.sheet_to_json(wsS, { header: 1, defval: '' });
      sumRows = srows.length - 4; // 3 標題行＋1 表頭
      const linkCell = Object.keys(wsS).find((k) => /^[A-Z]+\d+$/.test(k) && wsS[k].l);
      linkOk = !!linkCell && /attachments\//.test(wsS[linkCell].l.Target);
      const innerZip = await JSZip.loadAsync(await z.file(xlsxFile).async('nodebuffer'));
      const sheetXml = await innerZip.file('xl/worksheets/sheet1.xml').async('string');
      freezeOk = sheetXml.includes('state="frozen"');
      const vTotal = curDb().prepare('SELECT COUNT(*) AS c FROM vouchers').get().c;
      check('X3d 總表行數＝voucher 數', sumRows === vTotal, sumRows + ' vs ' + vTotal);
    }
    check('X3e 附件 hyperlink', linkOk);
    check('X3f 總表凍結窗格', freezeOk);
  }

  // B1–B3 附件入 SQLite（v3）
  {
    // B1：X3 匯入嘅附件存咗入 DB（data_b64），唔係寫實體檔
    const attRow = curDb().prepare('SELECT data_b64, path FROM attachments WHERE name = ?').get('receipt.txt');
    const noAttDir = !fs.existsSync(path.join(WORK, 'attachments'));
    const expB64 = Buffer.from('hello-world').toString('base64');
    check('B1 附件入 DB（data_b64 有料、無 path、無寫檔）',
      !!attRow && attRow.data_b64 === expB64 && attRow.path == null && noAttDir,
      attRow ? ('b64=' + String(attRow.data_b64).slice(0, 20) + ' path=' + attRow.path + ' noDir=' + noAttDir) : 'no row');
    // B2：附件 dataB64 → dataURL 還原正常（app 照常用）
    const payload2 = await page.evaluate(() => window.__TG__.createBackupPayload());
    const vAtt = ((payload2.data.vouchers[0] || {}).attachments || [])[0];
    check('B2 附件 dataURL 還原正常',
      !!vAtt && vAtt.dataURL === 'data:text/plain;base64,' + expB64,
      vAtt ? String(vAtt.dataURL).slice(0, 40) : 'no att');
    // B3：v2→v3 migration（模擬舊檔制附件入庫）
    const migDir = path.join(WORK, 'attachments', 'MIGV');
    fs.mkdirSync(migDir, { recursive: true });
    fs.writeFileSync(path.join(migDir, 'old.txt'), 'migrated-content');
    curDb().prepare("INSERT INTO vouchers(no, type, date) VALUES ('MIGV','B','2026-10-01')").run();
    curDb().prepare("INSERT INTO attachments(voucher_no, seq, name, mime, path) VALUES ('MIGV',0,'old.txt','text/plain','attachments/MIGV/old.txt')").run();
    const migRes = await page.evaluate(() => window.__TG_DESKTOP__.migrateAttachmentsToDb());
    const migRow = curDb().prepare("SELECT data_b64 FROM attachments WHERE voucher_no='MIGV'").get();
    const verRow = curDb().prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get();
    const expMigB64 = Buffer.from('migrated-content').toString('base64');
    check('B3 v2→v3 附件入庫＋版本升4',
      migRes.ok === 1 && migRes.fail === 0 && migRow.data_b64 === expMigB64 && verRow.version === 4,
      JSON.stringify(migRes) + ' ver=' + verRow.version);
    curDb().prepare("DELETE FROM vouchers WHERE no='MIGV'").run(); // 清理（CASCADE 刪附件）
  }

  // ---- C. 設置：附件管理＋MCP（X3 已匯入一張帶附件嘅 voucher） ----
  {
    // C1 附件管理顯示
    await page.evaluate(() => { document.getElementById('tgSettingsNav').click(); });
    await sleep(800);
    await page.evaluate(() => document.getElementById('tgAttRefresh').click());
    await sleep(800);
    const attStats = await page.evaluate(() => document.getElementById('tgAttStats').innerText);
    check('C1 附件管理統計', /共 [1-9].* 個附件/.test(attStats) && /全部正常|無內容/.test(attStats), attStats.slice(0, 80));
    // C2 MCP 設定顯示（含 DB 路徑）
    const mcpCfg = await page.evaluate(() => document.getElementById('tgMcpConfig').textContent);
    check('C2 MCP 設定含 DB 路徑', /mcp_servers\.toys-gallery/.test(mcpCfg) && /TG_DB_PATH/.test(mcpCfg), mcpCfg.slice(0, 80));
    // C3 匯出全部附件 zip
    savedDialogPath = null;
    await page.evaluate(() => document.getElementById('tgAttExport').click());
    await sleep(2500);
    let attZipOk = false, attZipN = 0;
    if (savedDialogPath && fs.existsSync(savedDialogPath)) {
      const az = await JSZip.loadAsync(fs.readFileSync(savedDialogPath));
      const azFiles = Object.keys(az.files).filter((f) => !az.files[f].dir);
      attZipN = azFiles.filter((f) => f.startsWith('attachments/')).length;
      attZipOk = attZipN >= 1;
    }
    check('C3 匯出全部附件 zip', attZipOk, attZipN + ' files');
  }

  // ---- D. 待匯入 Voucher（MCP 手寫單） ----
  {
    // D1：插入一張 pending，列表顯示
    const pendPayload = JSON.stringify({
      date: '2026-10-07', type: 'B', desc: '手寫單測試',
      madeBy: 'T', checkedBy: 'T', approvedBy: 'T',
      lines: [
        { account: 'Bank Saving Account', debit_cents: 50000, credit_cents: 0, detail: '' },
        { account: 'Sales', debit_cents: 0, credit_cents: 50000, detail: '' },
      ],
      attachments: [{ name: 'hand.jpg', mime: 'image/jpeg', dataB64: Buffer.from('fakeimg').toString('base64') }],
    });
    curDb().prepare("INSERT INTO pending_vouchers(status, payload_json, note) VALUES ('pending',?,?)").run(pendPayload, 'smoke');
    const pendId = curDb().prepare('SELECT last_insert_rowid() AS id').get().id;
    await page.evaluate(() => document.getElementById('tgPendRefresh').click());
    await sleep(800);
    const pendStats = await page.evaluate(() => document.getElementById('tgPendStats').innerText);
    check('D1 待匯入列表顯示', /共 1 張待匯入/.test(pendStats), pendStats.slice(0, 40));
    // D2：一鍵匯入
    await page.evaluate((id) => {
      document.querySelector('[data-pend-import="' + id + '"]').click();
    }, pendId);
    await sleep(2500);
    const impSt = await page.evaluate(() => document.getElementById('tgSettingsStatus').textContent);
    const vRow = curDb().prepare("SELECT no FROM vouchers WHERE description='手寫單測試'").get();
    const attRow2 = vRow && curDb().prepare('SELECT data_b64 FROM attachments WHERE voucher_no=?').get(vRow.no);
    const pendSt = curDb().prepare('SELECT status FROM pending_vouchers WHERE id=?').get(pendId).status;
    check('D2 一鍵匯入成功（入賬＋附件＋狀態）',
      /已匯入/.test(impSt) && !!vRow && !!attRow2 && attRow2.data_b64 === Buffer.from('fakeimg').toString('base64') && pendSt === 'imported',
      impSt.slice(0, 40) + ' voucher=' + (vRow && vRow.no));
    // D3：刪除待匯入（headless 預設 confirm→dismiss，先 override 做自動確認）
    curDb().prepare("INSERT INTO pending_vouchers(status, payload_json) VALUES ('pending',?)").run('{}');
    const delId = curDb().prepare('SELECT last_insert_rowid() AS id').get().id;
    await page.evaluate(() => document.getElementById('tgPendRefresh').click());
    await sleep(800);
    await page.evaluate((id) => {
      window.confirm = () => true;
      document.querySelector('[data-pend-reject="' + id + '"]').click();
    }, delId);
    await sleep(800);
    const delSt = curDb().prepare('SELECT status FROM pending_vouchers WHERE id=?').get(delId).status;
    check('D3 刪除待匯入', delSt === 'rejected', 'status=' + delSt);
  }

  // X4 報表 xlsx 執靚
  savedDialogPath = null;
  await page.evaluate(() => document.getElementById('tgExportExcel').click());
  await sleep(5000);
  const rptOk = savedDialogPath && savedDialogPath.endsWith('.xlsx') && fs.existsSync(savedDialogPath);
  check('X4a 報表 xlsx 落地', rptOk, savedDialogPath || 'no path');
  if (rptOk) {
    const rz = await JSZip.loadAsync(fs.readFileSync(savedDialogPath));
    const rwb = XLSX.read(fs.readFileSync(savedDialogPath), { type: 'buffer' });
    check('X4b 9 個 sheet', rwb.SheetNames.length === 9, rwb.SheetNames.length + ' sheets');
    let frozen = 0;
    for (let i = 1; i <= rwb.SheetNames.length; i++) {
      const sx = await rz.file('xl/worksheets/sheet' + i + '.xml').async('string');
      if (sx.includes('state="frozen"')) frozen++;
    }
    check('X4c 全部凍結窗格', frozen === 9, frozen + '/9');
    const wbx = await rz.file('xl/workbook.xml').async('string');
    const titles = (wbx.match(/_xlnm\.Print_Titles/g) || []).length;
    check('X4d 全部列印標題', titles === 9, titles + '/9');
    const trialSheet = rwb.Sheets[rwb.SheetNames.find((n) => /試算/.test(n))];
    const trows = XLSX.utils.sheet_to_json(trialSheet, { header: 1, defval: '' });
    let drSum = 0, crSum = 0, badFloat = false;
    for (const r of trows) for (const c of r) {
      if (typeof c === 'number' && Math.abs(c * 100 - Math.round(c * 100)) > 1e-6) badFloat = true;
    }
    // 借貸欄係第 2、3 欄（0-based 1、2），跳過標題行
    for (let i = 4; i < trows.length; i++) {
      if (typeof trows[i][1] === 'number') drSum += trows[i][1];
      if (typeof trows[i][2] === 'number') crSum += trows[i][2];
    }
    check('X4e 試算表借貸相等', drSum > 0 && Math.abs(drSum - crSum) < 0.005,
      drSum.toFixed(2) + ' vs ' + crSum.toFixed(2));
    check('X4f 無浮點垃圾', !badFloat);
  }

  // R1 工具欄還原 auto-resume：模擬 #confirmRestore 最終確認掣點擊，唔應報錯
  //（dbWriteEnabled=true 時應直接返回，唔做嘢）
  var r1ok = await page.evaluate(() => {
    try{
      var btn = document.createElement('button');
      btn.id = 'confirmRestore';
      btn.textContent = '確認還原';
      document.body.appendChild(btn);
      btn.click();
      btn.remove();
      return 'ok';
    }catch(e){ return 'throw:' + e.message; }
  });
  // 等 1 秒，睇下有冇 pageerror（handler 入面有 async，要時間跑）
  await new Promise(r => setTimeout(r, 1000));
  check('R1 #confirmRestore 攔截唔報錯', r1ok === 'ok', r1ok);

  // T15 零 pageerror（放最後，覆蓋埋設置測試）
  check('T15 零 pageerror', errs.length === 0, errs.slice(0, 3).join(' | ').slice(0, 200));

  await browser.close();
  server.close();
  for(const d of dbByPath.values()){ try{ d.close(); }catch(e){} }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
  console.log('workdir: ' + WORK);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('SMOKE FATAL:', e); process.exit(2); });
