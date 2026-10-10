#!/usr/bin/env node
/**
 * v3.24.2 回歸測試：附件對應錯位修復（voucherNo → 路徑映射）。
 *
 * 場景：匯入 Excel 入面有 3 張草稿，中間嗰張借貸不平被 skip。
 * 舊行為（index 對應）會令附件掛錯 voucher；新行為用
 * TG.importVouchers 回傳嘅 attachmentMap（keyed by 最終 voucherNo），
 * 就算有草稿被 skip 都唔會錯位。
 *
 * 覆蓋：
 *  - 設置頁資料夾匯入（同 tauri-glue.js doImportVouchers 真實路徑）
 *  - 只匯入有效行：2 張 voucher（MAP001＋自動編號），MAP002 被 skip
 *  - r1.txt → MAP001、r3.txt → 自動編號；r2.txt 唔會掛去任何 voucher
 *  - 附件內容 bytes 同原始檔一致；零 pageerror
 *
 * 用法：node scripts/accept-v3242-attach-map.cjs [--workdir <dir>]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const wi = args.indexOf('--workdir');
const WORK = wi >= 0 ? args[wi + 1] : fs.mkdtempSync(path.join(os.tmpdir(), 'tg-acc3242map-'));
fs.mkdirSync(WORK, { recursive: true });

const puppeteer = require('/home/hatch/workspace/hk-legal-dora/node_modules/puppeteer-core');
const CHROME = path.join(
  os.homedir(), '.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell');

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra: extra || '' });
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  — ' + extra : ''));
}

// ---- SQLite（同 smoke-desktop.cjs 一樣嘅 mock 後端） ----
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
  if (cmd === 'plugin:fs|read_dir') { // v3.23.0 資料夾模式：列出資料夾內容
    const entries = fs.readdirSync(a.path, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile(), isSymlink: e.isSymbolicLink() }));
  }
  if (cmd === 'plugin:fs|write_file') {
    const p = decodeURIComponent((options.headers && options.headers.path) || '');
    const bytes = (a instanceof Uint8Array) ? a
      : (Array.isArray(a) ? Uint8Array.from(a) : Uint8Array.from(Object.values(a || {})));
    const buf = Buffer.from(bytes);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf);
    return;
  }
  if (cmd === 'plugin:fs|read_file') {
    // 同 smoke：exposeFunction 傳唔到 ArrayBuffer，回傳 Array；glue 照樣識轉
    const buf = fs.readFileSync(a.path);
    return Array.from(buf);
  }
  if (cmd === 'plugin:path|resolve_directory') return (a.directory === 13) ? path.join(WORK, 'appconfig') : WORK;
  throw new Error('mock 未處理的 invoke: ' + cmd);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  await page.evaluate(() => document.body.classList.add('authenticated'));
  await sleep(1500);

  // A0 前置：版本＋財年
  const badge = await page.evaluate(() =>
    (document.querySelector('.version-badge') || {}).textContent || null);
  check('A0 badge 係 v3.25.1', badge === 'v3.25.1核心 v3.15.1', String(badge));
  const fys = await page.evaluate(() => window.__TG__.fiscalYears());
  const openFy = (fys || []).find((f) => f.from <= '2026-10-08' && '2026-10-08' <= f.to);
  check('A0 已有財年涵蓋測試日期', !!openFy, JSON.stringify((fys || []).map((f) => f.key)));
  const D1 = '2026-10-05', D2 = '2026-10-06', D3 = '2026-10-07';

  // A1 科目
  const impRes = await page.evaluate(() => window.__TG__.importExcelData({
    accounts: [
      { code: '1000', name: 'Bank Saving Account', type: '資產' },
      { code: '1101', name: 'Accounts Receivable of Toy Hunters', type: '資產' },
      { code: '1120', name: 'Prepayment to Supplier', type: '資產' },
      { code: '4000', name: 'Sales', type: '收入' },
    ],
    opening: [],
  }));
  check('A1 匯入 4 科目', impRes && impRes.addedAccounts === 4, JSON.stringify(impRes));

  // 附件 fixture：3 個草稿各自有一個附件檔，中間草稿係壞單（借貸不平）會被 skip
  const att1 = Buffer.from('ATTACHMENT-1-CONTENT');
  const att2 = Buffer.from('ATTACHMENT-2-CONTENT-should-NOT-be-attached');
  const att3 = Buffer.from('ATTACHMENT-3-CONTENT-中文');
  fs.writeFileSync(path.join(WORK, 'r1.txt'), att1);
  fs.writeFileSync(path.join(WORK, 'r2.txt'), att2);
  fs.writeFileSync(path.join(WORK, 'r3.txt'), att3);

  // A2 建測試 Excel：MAP001（好）→ MAP002（壞，借貸不平）→ 自動編號（好）
  // 檔名加 0- 前綴：排序後確保程式用測試檔（唔係範本下載檔）
  const XLSX = require('xlsx');
  const impXlsxPath = path.join(WORK, '0-map-import-test.xlsx');
  {
    const iwb = XLSX.utils.book_new();
    const iws = XLSX.utils.aoa_to_sheet([
      ['日期 Date','Voucher No.（吉=自動編號）','類型 Type（B=銀行 / T=轉賬）','摘要 Description',
       '借方科目 Debit Account','借方金額 Debit Amount','貸方科目 Credit Account','貸方金額 Credit Amount',
       '明細 Detail','製表 Made By','覆核 Checked By','批核 Approved By','附件 Attachment（檔案路徑，多個用 ; 分隔）'],
      [D1,'MAP001','T','mapping 好單 1','Bank Saving Account',1000,'','','d1','阿Bin','阿May','老闆','r1.txt'],
      [D1,'MAP001','T','mapping 好單 1','','','Sales',1000,'d1','阿Bin','阿May','老闆',''],
      [D2,'MAP002','T','mapping 壞單（借貸不平）','Bank Saving Account',500,'','','d2','阿Bin','阿May','老闆','r2.txt'],
      [D2,'MAP002','T','mapping 壞單（借貸不平）','','','Sales',499,'d2','阿Bin','阿May','老闆',''],
      [D3,'','B','mapping 好單 2','Bank Saving Account',200,'','','d3','阿Bin','阿May','老闆','r3.txt'],
      [D3,'','B','mapping 好單 2','','','Sales',200,'d3','阿Bin','阿May','老闆',''],
    ]);
    XLSX.utils.book_append_sheet(iwb, iws, '範本');
    XLSX.writeFile(iwb, impXlsxPath);
  }

  // A3 經設置 UI 匯入（資料夾模式：dialog 回傳資料夾，附件喺同資料夾搵）
  mockDialogOpenQueue.push(WORK);
  await page.evaluate(() => document.getElementById('tgVoucherImport').click());
  await sleep(1500);
  const preview = await page.evaluate(() => ({
    visible: !document.getElementById('tgVoucherImportBox').hidden,
    text: document.getElementById('tgVoucherImportBox').innerText,
  }));
  check('A3 預覽：只匯入有效行（2 張）＋MAP002 借貸不平錯誤',
    preview.visible && /借貸不平/.test(preview.text) && /只匯入有效行（2 張）/.test(preview.text),
    preview.text.replace(/\n/g, ' ').slice(0, 260));

  // A4 只匯入有效行 → MAP001＋自動編號入賬，MAP002 被 skip；附件按 voucherNo 掛
  const vBefore = curDb().prepare('SELECT COUNT(*) AS c FROM vouchers').get().c;
  await page.evaluate(() => document.getElementById('tgVoucherImportGo').click());
  await sleep(3500);
  const status = await page.evaluate(() => document.getElementById('tgSettingsStatus').textContent);
  const vAfter = curDb().prepare('SELECT COUNT(*) AS c FROM vouchers').get().c;
  check('A4 匯入 2 張 voucher（壞單被 skip）',
    /匯入完成/.test(status) && vAfter === vBefore + 2,
    status.slice(0, 80) + ' | ' + vBefore + '→' + vAfter);
  check('A4 附件 2 個已匯入、0 失敗',
    /附件 2 個已匯入/.test(status) && !/附件失敗/.test(status),
    status.slice(0, 260));

  // A5 附件掛載正確：r1.txt→MAP001，r3.txt→自動編號，r2.txt 唔喺任何 voucher
  const autoNo = curDb().prepare("SELECT no FROM vouchers WHERE date=? AND type='B'").all(D3).map((r) => r.no);
  const attRows = curDb().prepare(
    'SELECT voucher_no AS no, name, data_b64 FROM attachments').all();
  const names = attRows.map((r) => r.no + ':' + r.name);
  const aOk = attRows.length === 2 &&
    names.includes('MAP001:r1.txt') &&
    autoNo.length === 1 && names.includes(autoNo[0] + ':r3.txt');
  check('A5 附件按 voucherNo 對啱（MAP001↔r1.txt、自動編號↔r3.txt）', aOk, names.join(' | '));
  const rowByName = (n) => attRows.find((r) => r.name === n);
  const bytesOk = Buffer.from(rowByName('r1.txt').data_b64, 'base64').equals(att1) &&
    Buffer.from(rowByName('r3.txt').data_b64, 'base64').equals(att3);
  check('A5 附件內容 bytes 同原始檔一致', bytesOk);
  const r2Attached = attRows.some((r) => r.name === 'r2.txt');
  const map002 = curDb().prepare("SELECT COUNT(*) AS c FROM vouchers WHERE no='MAP002'").get().c;
  check('A5 壞單 MAP002 冇入賬、r2.txt 冇掛去任何 voucher（冇錯位）',
    map002 === 0 && !r2Attached, 'MAP002 vouchers=' + map002 + ', r2.txt attached=' + r2Attached);

  // A6 零 pageerror／console error
  check('A6 零 pageerror', errs.length === 0, errs.slice(0, 3).join(' | '));

  const fails = results.filter((r) => !r.ok);
  console.log('\n==== v3.24.2 mapping 回歸：' + (results.length - fails.length) + '/' + results.length +
    ' PASS' + (fails.length ? '，' + fails.length + ' FAIL' : '') + ' ====');

  if (errs.length) console.log('console/pageerror：\n' + errs.slice(0, 5).join('\n'));
  await browser.close();
  server.close();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('驗收腳本異常：', e); process.exit(2); });
