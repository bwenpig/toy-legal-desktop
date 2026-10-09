#!/usr/bin/env node
/**
 * v3.22.0 附件流程專項 E2E 驗收（含 v3.22.1 兩個修復嘅回歸覆蓋）。
 *
 * 覆蓋官方真實流程（同 src/tauri-glue.js doImportVouchers 一致）：
 *  - 範本下載（13 欄，含 M 欄附件路徑）
 *  - 設置頁 UI 匯入：讀 xlsx → parseVoucherImport → 預覽（📎 數量欄）
 *  - 只匯入有效行 → importVouchers → 按 Excel 目錄相對路徑讀檔
 *    （fsReadBytes）→ setVoucherAttachments 掛到 voucher → persist
 *  - reload 後：voucher 列表 📎 按鈕（v3.22.0 桌面 patch）→ 撳開附件檢視 modal
 *  - 附件內容同原始檔 bytes 一致；讀唔到嘅檔只列失敗，唔影響成批
 *
 * 用法：node scripts/accept-v322-attachments.cjs [--workdir <dir>]
 * （src/index.html 必須已由 scripts/build-desktop.cjs 產出，含 v3.22.0 bundle）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const wi = args.indexOf('--workdir');
const WORK = wi >= 0 ? args[wi + 1] : fs.mkdtempSync(path.join(os.tmpdir(), 'tg-acc322-'));
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
  check('A0 badge 係 v3.24.2', badge === 'v3.24.2核心 v3.15.1', String(badge));
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

  // 附件 fixture（放匯入資料夾，測檔名解析；sub/ 子資料夾＋絕對路徑照舊支援）
  const attA = Buffer.from('ATTACHMENT-A-CONTENT-中文');
  const attB = Buffer.from('ATTACHMENT-B-CONTENT');
  const subDir = path.join(WORK, 'sub');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(WORK, 'receipt-a.txt'), attA);
  fs.writeFileSync(path.join(WORK, 'receipt-b.txt'), attB);
  fs.writeFileSync(path.join(subDir, 'invoice.pdf'), Buffer.from('%PDF-1.4 fake-pdf-bytes'));
  const absPdf = path.join(WORK, 'absolute.pdf');
  fs.writeFileSync(absPdf, Buffer.from('%PDF-1.4 absolute-path-bytes'));

  // A2 範本下載：第 13 欄係附件
  const XLSX = require('xlsx');
  savedDialogPath = null;
  await page.evaluate(() => document.getElementById('tgVoucherTpl').click());
  await sleep(1200);
  let tplCols = [];
  if (savedDialogPath && fs.existsSync(savedDialogPath)) {
    const twb = XLSX.readFile(savedDialogPath);
    const tplRows = XLSX.utils.sheet_to_json(twb.Sheets['範本'], { header: 1, defval: '' });
    tplCols = tplRows[0] || [];
  }
  check('A2 範本有 13 欄＋M 欄係附件（檔名）', tplCols.length === 13 && /附件.*檔名/.test(String(tplCols[12])),
    tplCols.length + ' cols :: ' + String(tplCols[12]));

  // A3 建測試 Excel（含附件欄；有 1 個壞路徑測容錯）
  // 檔名加 0- 前綴：資料夾內仲有 A2 下載嘅範本檔，排序後確保用測試檔（唔係範本）
  const impXlsxPath = path.join(WORK, '0-att-import-test.xlsx');
  {
    const iwb = XLSX.utils.book_new();
    const iws = XLSX.utils.aoa_to_sheet([
      ['日期 Date','Voucher No.（吉=自動編號）','類型 Type（B=銀行 / T=轉賬）','摘要 Description',
       '借方科目 Debit Account','借方金額 Debit Amount','貸方科目 Credit Account','貸方金額 Credit Amount',
       '明細 Detail','製表 Made By','覆核 Checked By','批核 Approved By','附件 Attachment（檔案路徑，多個用 ; 分隔）'],
      [D1,'ATT001','T','收到 Toy Hunters 貨款','Bank Saving Account',5000,'','', 'INV1','阿Bin','阿May','老闆','receipt-a.txt;receipt-b.txt'],
      [D1,'ATT001','T','收到 Toy Hunters 貨款','','','Accounts Receivable of Toy Hunters',5000,'INV1','阿Bin','阿May','老闆',''],
      [D2,'','B','付供應商訂金','Prepayment to Supplier',1200.5,'','','','阿Bin','阿May','老闆','sub/invoice.pdf'],
      [D2,'','B','付供應商訂金','','','Bank Saving Account',1200.5,'','阿Bin','阿May','老闆',''],
      [D3,'ATT002','B','壞路徑測試','Bank Saving Account',100,'','','','阿Bin','阿May','老闆',absPdf],
      [D3,'ATT002','B','壞路徑測試','','','Sales',100,'','阿Bin','阿May','老闆','nope/missing.pdf'],
    ]);
    XLSX.utils.book_append_sheet(iwb, iws, '範本');
    XLSX.writeFile(iwb, impXlsxPath);
  }

  // A4 經設置 UI 匯入（v3.23.0 資料夾模式：dialog 回傳資料夾，附件喺同資料夾搵）
  mockDialogOpenQueue.push(WORK);
  await page.evaluate(() => document.getElementById('tgVoucherImport').click());
  await sleep(1500);
  const preview = await page.evaluate(() => ({
    visible: !document.getElementById('tgVoucherImportBox').hidden,
    text: document.getElementById('tgVoucherImportBox').innerText,
  }));
  check('A4 預覽顯示 📎 2 個（ATT001）／📎 1 個／📎 2 個（ATT002）',
    preview.visible && (preview.text.match(/📎 2 個/g) || []).length === 2 &&
      (preview.text.match(/📎 1 個/g) || []).length === 1,
    preview.text.replace(/\n/g, ' ').slice(0, 260));

  // A5 只匯入有效行 → 附件自動入庫
  const vBefore = curDb().prepare('SELECT COUNT(*) AS c FROM vouchers').get().c;
  await page.evaluate(() => document.getElementById('tgVoucherImportGo').click());
  await sleep(3500);
  const status = await page.evaluate(() => document.getElementById('tgSettingsStatus').textContent);
  const vAfter = curDb().prepare('SELECT COUNT(*) AS c FROM vouchers').get().c;
  check('A5 匯入 3 張 voucher', /匯入完成/.test(status) && vAfter === vBefore + 3,
    status.slice(0, 60) + ' | ' + vBefore + '→' + vAfter);
  check('A5 附件 4 個成功＋1 個失敗（唔爆成批）',
    /附件 4 個已匯入/.test(status) && /附件失敗 1 個/.test(status) && /nope\/missing\.pdf/.test(status),
    status.slice(0, 260));

  // A6 attachments 表：名＋對應 voucher＋內容一致
  const attRows = curDb().prepare(
    'SELECT voucher_no AS no, name, LENGTH(data_b64) AS len, data_b64 FROM attachments ORDER BY name').all();
  const names = attRows.map((r) => r.no + ':' + r.name);
  const aOk = attRows.length === 4 &&
    names.includes('ATT001:receipt-a.txt') && names.includes('ATT001:receipt-b.txt') &&
    names.some((n) => n.endsWith(':invoice.pdf')) && names.includes('ATT002:absolute.pdf');
  const rowByName = (n) => attRows.find((r) => r.name === n);
  const bytesOk = rowByName('receipt-a.txt') && rowByName('receipt-b.txt') &&
    Buffer.from(rowByName('receipt-a.txt').data_b64, 'base64').equals(attA) &&
    Buffer.from(rowByName('receipt-b.txt').data_b64, 'base64').equals(attB);
  const absOk = attRows.some((r) => r.name === 'absolute.pdf' &&
    Buffer.from(r.data_b64, 'base64').toString().startsWith('%PDF-1.4 absolute-path-bytes'));
  check('A6 附件入 DB（3 行、voucher 對應啱）', aOk, names.join(' | '));
  check('A6 附件內容同原始檔一致', bytesOk && absOk);

  // A7 自動編號
  const autoNo = curDb().prepare("SELECT no FROM vouchers WHERE date=? AND type='B'").all(D2).map((r) => r.no);
  check('A7 自動編號 B100126', autoNo.length === 1 && /^B100126$/i.test(autoNo[0]), autoNo.join(','));

  // A8 reload → voucher 列表 📎 按鈕（桌面 v3.22.0 patch）
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(2500);
  await page.evaluate(() => document.body.classList.add('authenticated'));
  await sleep(1200);
  const btns = await page.evaluate(() => {
    document.querySelector('[data-route="voucher"]').click();
    return new Promise((res) => setTimeout(() => {
      const b = [...document.querySelectorAll('#voucherListBody .attachment-btn')];
      res(b.map((x) => ({ no: x.closest('tr').querySelector('b').textContent, label: x.textContent.trim() })));
    }, 500));
  });
  const btnMap = Object.fromEntries(btns.map((b) => [b.no, b.label]));
  check('A8 voucher 列表有 📎 按鈕（ATT001 📎2、自動編號 📎1、ATT002 📎1）',
    btnMap['ATT001'] === '📎 2' && btnMap[autoNo[0]] === '📎 1' && btnMap['ATT002'] === '📎 1' &&
      Object.keys(btnMap).length === 3,
    JSON.stringify(btnMap));

  // A9 撳 📎 → 附件檢視 modal 開啟，列出 2 個檔
  const modal = await page.evaluate(() => {
    const b = [...document.querySelectorAll('#voucherListBody .attachment-btn')]
      .find((x) => x.closest('tr').querySelector('b').textContent === 'ATT001');
    if (!b) return null;
    b.click();
    return new Promise((res) => setTimeout(() => {
      const m = document.getElementById('attachmentModal');
      res({
        hidden: m.hidden,
        title: document.getElementById('attachmentModalTitle').textContent,
        files: [...document.querySelectorAll('#attachmentModalList .attachment-open span')].map((s) => s.textContent),
      });
    }, 400));
  });
  check('A9 📎 開啟附件 modal（2 個檔名啱）',
    modal && !modal.hidden && /ATT001 · 2 個附件/.test(modal.title) &&
      modal.files.includes('receipt-a.txt') && modal.files.includes('receipt-b.txt'),
    JSON.stringify(modal));

  // A10 Ledger 同 Journal 沿用附件按鈕
  const journalHas = await page.evaluate(() => {
    document.querySelector('[data-route="reports"]').click();
    return new Promise((res) => setTimeout(() => {
      document.querySelector('[data-report="journal"]').click();
      setTimeout(() => {
        res(document.querySelectorAll('#reportCard .attachment-btn').length);
      }, 500);
    }, 400));
  });
  check('A10 Journal 報表有 📎 按鈕', journalHas >= 3, journalHas + ' buttons');

  // A11 零 pageerror／console error
  check('A11 零 pageerror', errs.length === 0, errs.slice(0, 3).join(' | '));

  const fails = results.filter((r) => !r.ok);
  console.log('\n==== 專項驗收：' + (results.length - fails.length) + '/' + results.length +
    ' PASS' + (fails.length ? '，' + fails.length + ' FAIL' : '') + ' ====');
  if (errs.length) console.log('console/pageerror：\n' + errs.slice(0, 5).join('\n'));
  await browser.close();
  server.close();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('驗收腳本異常：', e); process.exit(2); });
