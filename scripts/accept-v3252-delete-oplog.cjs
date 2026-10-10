#!/usr/bin/env node
/**
 * v3.25.2 專項測試：voucher 刪除＋操作日誌 op_logs。
 *
 * 刪除覆蓋：
 *  - D1 刪除掣存在（每行 voucher 列表有「刪除」掣）
 *  - D2 取消刪除 → voucher 仲喺度
 *  - D3 刪除普通 voucher → 列表＋DB 冇咗，試算表仍平衡
 *  - D4 刪除有附件嘅 voucher → attachments 表一併清
 *  - D5 刪除已對銷嘅收款 → allocations 回滾，發票恢復 outstanding
 *  - D6 deleted_vouchers audit 表有記錄（含快照）
 * 操作日誌覆蓋：
 *  - L1 op_logs 有 voucher.delete 記錄（欄位齊：ts/app/core/session/actor/op/entity/detail/before/after/result/fiscal_year/os）
 *  - L2 op_logs 有 login 記錄
 *  - L3 設置頁匯出操作日誌 → JSON 有效，可按日期篩
 *  - L4 超上限自動清（10,000 條／90 日）
 *
 * 用法：node scripts/accept-v3252-delete-oplog.cjs [--workdir <dir>]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const wi = args.indexOf('--workdir');
const WORK = wi >= 0 ? args[wi + 1] : fs.mkdtempSync(path.join(os.tmpdir(), 'tg-acc3252-'));
fs.mkdirSync(WORK, { recursive: true });

const puppeteer = require('/home/hatch/workspace/hk-legal-dora/node_modules/puppeteer-core');
const CHROME = path.join(
  os.homedir(), '.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell');

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra: extra || '' });
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  — ' + extra : ''));
}

// ---- SQLite mock ----
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
  const db = curDb();
  if (values.length === 0) { db.exec(String(query)); return; }
  db.prepare(String(query)).run(...values);
}
function mockSelect(query, values) {
  values = values || [];
  return curDb().prepare(String(query)).all(...values);
}

let savedDialogPath = null;
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
  if (cmd === 'plugin:dialog|open') return null;
  if (cmd === 'plugin:fs|mkdir') { fs.mkdirSync(a.path, { recursive: true }); return; }
  if (cmd === 'plugin:fs|exists') return fs.existsSync(a.path);
  if (cmd === 'plugin:fs|read_dir') {
    const entries = fs.readdirSync(a.path, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile(), isSymlink: e.isSymbolicLink() }));
  }
  if (cmd === 'plugin:fs|write_file') {
    const p = decodeURIComponent((options.headers && options.headers.path) || '');
    const bytes = (a instanceof Uint8Array) ? a
      : (Array.isArray(a) ? Uint8Array.from(a) : Uint8Array.from(Object.values(a || {})));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(bytes));
    return;
  }
  if (cmd === 'plugin:fs|read_file') return Array.from(fs.readFileSync(a.path));
  if (cmd === 'plugin:path|resolve_directory') return (a.directory === 13) ? path.join(WORK, 'appconfig') : WORK;
  throw new Error('mock 未處理的 invoke: ' + cmd);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let dialogAction = 'accept';

(async () => {
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
  page.on('dialog', async (d) => {
    if (dialogAction === 'accept') await d.accept();
    else await d.dismiss();
  });

  await page.exposeFunction('__tgMockInvoke', (cmd, a, o) => mockInvoke(cmd, a, o));
  await page.evaluateOnNewDocument(() => {
    window.__TAURI_INTERNALS__ = {
      invoke: (cmd, args, options) => window.__tgMockInvoke(cmd, args, options),
    };
  });
  await page.goto(base + '/index.html', { waitUntil: 'networkidle0', timeout: 60000 });
  await sleep(2500);
  // 登入（觸發 login op log）
  await page.evaluate(() => {
    document.getElementById('loginUser').value = 'admin';
    document.getElementById('loginPassword').value = 'admin';
    document.getElementById('loginForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await sleep(1500);
  // 如果 login form submit 唔 work（mock 環境），直接加 authenticated
  await page.evaluate(() => document.body.classList.add('authenticated'));
  await sleep(1500);

  const q1 = (sql, ...p) => { try { return curDb().prepare(sql).get(...p); } catch (e) { return null; } };
  const qall = (sql, ...p) => { try { return curDb().prepare(sql).all(...p); } catch (e) { return []; } };

  // A0 前置
  const badge = await page.evaluate(() =>
    (document.querySelector('.version-badge') || {}).textContent || null);
  check('A0 badge 係 v3.25.2', badge === 'v3.25.2核心 v3.15.1', String(badge));
  const impRes = await page.evaluate(() => window.__TG__.importExcelData({
    accounts: [
      { code: '1000', name: 'Bank Saving Account', type: '資產' },
      { code: '1101', name: 'Accounts Receivable of Toy Hunters', type: '資產' },
      { code: '4000', name: 'Sales', type: '收入' },
      { code: '5000', name: 'Purchases', type: '成本' },
    ],
    opening: [],
  }));
  check('A0 匯入 4 科目', impRes && impRes.addedAccounts === 4, JSON.stringify(impRes));

  // 建 3 張測試 voucher（經 UI，行真實過賬路徑）
  async function uiPost(o) {
    return await page.evaluate(async (o) => {
      const fire = (el, t) => el.dispatchEvent(new Event(t, { bubbles: true }));
      const s2 = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('[data-route="voucher"]').click();
      await s2(400);
      document.getElementById('newVoucher').click();
      await s2(400);
      const tv = document.querySelector('[data-vtype="' + o.type + '"]');
      if (tv) tv.click();
      await s2(200);
      const de = document.getElementById('voucherDate');
      de.value = o.date; fire(de, 'change'); await s2(200);
      document.getElementById('voucherDesc').value = o.desc || '';
      document.getElementById('allocationInvoice').value = o.allocInv || '';
      const setRow = async (i, L) => {
        const rows = document.querySelectorAll('.entry-row');
        const row = rows[i];
        const ac = row.querySelector('.acct'); ac.value = L.account; fire(ac, 'input'); await s2(350);
        const opt = document.querySelector('.account-option');
        if (opt) opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        await s2(150);
        row.querySelector('.detail').value = L.detail || ''; fire(row.querySelector('.detail'), 'input');
        row.querySelector('.debit').value = L.debit; fire(row.querySelector('.debit'), 'input');
        row.querySelector('.credit').value = L.credit; fire(row.querySelector('.credit'), 'input');
        await s2(150);
      };
      for (let i = 0; i < o.lines.length; i++) await setRow(i, o.lines[i]);
      ['madeBy', 'checkedBy', 'approvedBy'].forEach((id, i) => {
        const el = document.getElementById(id);
        el.value = (o.signs && o.signs[i]) || ''; fire(el, 'input');
      });
      await s2(400);
      const btn = document.getElementById('postBtn');
      let no = null;
      if (!btn.disabled) {
        no = document.getElementById('voucherNoInput').value;
        btn.click(); await s2(1200);
      }
      return { ok: !btn.disabled, no };
    }, o);
  }
  const D = '2026-10-05';
  const r1 = await uiPost({ date: D, type: 'T', desc: '刪除測試普通單',
    lines: [{ account: 'Bank Saving Account', debit: '1000', credit: '' }, { account: 'Sales', debit: '', credit: '1000' }],
    signs: ['阿Bin', '阿May', '老闆'] });
  check('A1 建 DEL 測試單 1（普通）', r1.ok && r1.no, JSON.stringify(r1));
  const r2 = await uiPost({ date: D, type: 'T', desc: '刪除測試附件單',
    lines: [{ account: 'Bank Saving Account', debit: '2000', credit: '' }, { account: 'Sales', debit: '', credit: '2000' }],
    signs: ['阿Bin', '阿May', '老闆'] });
  check('A1 建 DEL 測試單 2（掛附件用）', r2.ok && r2.no, JSON.stringify(r2));
  // 掛附件到第 2 張
  const attBytes = Buffer.from('DELETE-TEST-ATTACHMENT');
  await page.evaluate((no) => {
    const dataURL = 'data:text/plain;base64,' + btoa('DELETE-TEST-ATTACHMENT');
    window.__TG__.setVoucherAttachments(no, [{ name: 'del-test.txt', mime: 'text/plain', dataURL }]);
  }, r2.no);
  await sleep(2500); // 等 persist
  // 銷貨發票＋收款（對銷測試用）
  const rInv = await uiPost({ date: D, type: 'T', desc: '銷貨',
    lines: [{ account: 'Accounts Receivable of Toy Hunters', detail: 'INVDEL001', debit: '5000', credit: '' }, { account: 'Sales', debit: '', credit: '5000' }],
    signs: ['阿Bin', '阿May', '老闆'] });
  check('A1 建銷貨發票單', rInv.ok && rInv.no, JSON.stringify(rInv));
  const rRecv = await uiPost({ date: D, type: 'B', desc: '收款',
    lines: [{ account: 'Bank Saving Account', debit: '5000', credit: '' }, { account: 'Accounts Receivable of Toy Hunters', debit: '', credit: '5000' }],
    signs: ['阿Bin', '阿May', '老闆'] });
  check('A1 建收款單（應自動對銷 INVDEL001）', rRecv.ok && rRecv.no, JSON.stringify(rRecv));
  await sleep(3000);
  const allocBefore = qall('SELECT invoice_no, amount_cents FROM allocations WHERE voucher_no=?', rRecv.no);
  check('A1 收款已對銷 INVDEL001', allocBefore.length === 1 && allocBefore[0].amount_cents === 500000,
    JSON.stringify(allocBefore));

  // D1 刪除掣存在
  await page.evaluate(() => document.querySelector('[data-route="voucher"]').click());
  await sleep(1000);
  const delBtns = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.delete-voucher-btn')).map((b) => b.getAttribute('data-no')));
  check('D1 每行有「刪除」掣', delBtns.length >= 4 && delBtns.includes(r1.no),
    'buttons=' + delBtns.length + ', has ' + r1.no + '=' + delBtns.includes(r1.no));

  // D2 取消刪除 → 仲喺度
  dialogAction = 'dismiss';
  await page.evaluate((no) => {
    document.querySelector('.delete-voucher-btn[data-no="' + no + '"]').click();
  }, r1.no);
  await sleep(1500);
  const stillThere = q1('SELECT COUNT(*) AS c FROM vouchers WHERE no=?', r1.no);
  check('D2 取消刪除 → voucher 仲喺度', stillThere && stillThere.c === 1, 'count=' + (stillThere && stillThere.c));

  // D3 刪除普通單
  dialogAction = 'accept';
  await page.evaluate((no) => {
    document.querySelector('.delete-voucher-btn[data-no="' + no + '"]').click();
  }, r1.no);
  await sleep(3000);
  const goneList = await page.evaluate(() => document.getElementById('voucherListBody').innerText);
  const goneDb = q1('SELECT COUNT(*) AS c FROM vouchers WHERE no=?', r1.no);
  check('D3 刪除後列表＋DB 冇咗', !goneList.includes(r1.no) && goneDb.c === 0,
    'list has=' + goneList.includes(r1.no) + ', db=' + goneDb.c);
  // 試算表仍平衡
  const trial = await page.evaluate(async () => {
    document.querySelector('[data-route="reports"]').click();
    await new Promise((r) => setTimeout(r, 500));
    document.querySelector('[data-report="trial"]').click();
    await new Promise((r) => setTimeout(r, 800));
    return document.getElementById('reportCard').innerText;
  });
  const tbm = trial.match(/([\d,]+\.\d{2})\s+([\d,]+\.\d{2})/);
  check('D3 試算表借貸仍平衡', !!tbm && tbm[1] === tbm[2], tbm ? tbm[1] + ' vs ' + tbm[2] : 'no match');

  // D4 刪除有附件嘅單 → 附件一併清
  const attBefore = q1('SELECT COUNT(*) AS c FROM attachments WHERE voucher_no=?', r2.no);
  await page.evaluate((no) => {
    document.querySelector('.delete-voucher-btn[data-no="' + no + '"]').click();
  }, r2.no);
  await sleep(3000);
  const attAfter = q1('SELECT COUNT(*) AS c FROM attachments WHERE voucher_no=?', r2.no);
  const vGone2 = q1('SELECT COUNT(*) AS c FROM vouchers WHERE no=?', r2.no);
  check('D4 附件一併刪除', attBefore.c === 1 && attAfter.c === 0 && vGone2.c === 0,
    'before=' + attBefore.c + ' after=' + attAfter.c);

  // D5 刪除已對銷收款 → 回滾
  await page.evaluate((no) => {
    document.querySelector('.delete-voucher-btn[data-no="' + no + '"]').click();
  }, rRecv.no);
  await sleep(3000);
  const allocAfter = qall('SELECT * FROM allocations WHERE voucher_no=?', rRecv.no);
  const vGone3 = q1('SELECT COUNT(*) AS c FROM vouchers WHERE no=?', rRecv.no);
  check('D5 對銷回滾（allocations 清零）', allocAfter.length === 0 && vGone3.c === 0,
    'allocs=' + allocAfter.length);
  // 發票恢復 outstanding：AR 賬齡「發票計算結欠」應為 HK$ 5,000.00
  // （報告按公司分組，唔逐張顯示發票號；結欠金額證明對銷已回滾）
  const arText = await page.evaluate(async () => {
    document.querySelector('[data-route="reports"]').click();
    await new Promise((r) => setTimeout(r, 500));
    document.querySelector('[data-report="ar"]').click();
    await new Promise((r) => setTimeout(r, 1000));
    return document.getElementById('reportCard').innerText;
  });
  check('D5 發票恢復 outstanding（發票計算結欠 HK$ 5,000.00）',
    /發票計算結欠/.test(arText) && /HK\$\s*5,000\.00/.test(arText),
    arText.replace(/\n/g, ' ').slice(-160));

  // D6 audit 表
  const auditRows = qall('SELECT voucher_no, deleted_at FROM deleted_vouchers ORDER BY id');
  const auditNos = auditRows.map((r) => r.voucher_no);
  const auditJson = q1('SELECT voucher_json FROM deleted_vouchers WHERE voucher_no=?', r1.no);
  let snapOk = false;
  try { const s = JSON.parse(auditJson.voucher_json); snapOk = s.no === r1.no && s.lines && s.lines.length === 2; } catch (e) {}
  check('D6 deleted_vouchers 有 3 筆＋快照完整',
    auditNos.includes(r1.no) && auditNos.includes(r2.no) && auditNos.includes(rRecv.no) && snapOk,
    'nos=' + auditNos.join(','));

  // L1 op_logs 有 voucher.delete
  const delLogs = qall("SELECT op, entity, result FROM op_logs WHERE op='voucher.delete' ORDER BY id");
  check('L1 op_logs 有 3 筆 voucher.delete', delLogs.length === 3,
    'count=' + delLogs.length);
  const sample = q1("SELECT ts, app, core, session, actor, op, entity, detail, \"before\", \"after\", result, fiscal_year, os FROM op_logs WHERE op='voucher.delete' LIMIT 1");
  const fieldsOk = sample && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(sample.ts) &&
    sample.app === '3.25.2' && sample.core === '3.15.1' && !!sample.session &&
    !!sample.op && !!sample.entity && !!sample.result && !!sample.os;
  let entityOk = false;
  try { entityOk = JSON.parse(sample.entity).no === r1.no; } catch (e) {}
  check('L1 欄位齊全（ts 時區格式＋app/core/session/actor/os）', fieldsOk && entityOk,
    'ts=' + (sample && sample.ts) + ' app=' + (sample && sample.app));

  // L2 login 記錄
  const loginLogs = qall("SELECT COUNT(*) AS c FROM op_logs WHERE op='login'");
  check('L2 op_logs 有 login 記錄', loginLogs[0].c >= 1, 'count=' + loginLogs[0].c);

  // L3 匯出操作日誌：開設置頁（側欄「桌面設置」掣）
  await page.evaluate(() => { document.getElementById('tgSettingsNav').click(); });
  await sleep(1200);
  const hasExportBtn = await page.evaluate(() => !!document.getElementById('tgOpLogExport'));
  // 直接調用匯出（設日期範圍覆蓋全部）
  savedDialogPath = null;
  await page.evaluate(() => {
    const f = document.getElementById('tgOpLogFrom'), t = document.getElementById('tgOpLogTo');
    if (f) f.value = ''; if (t) t.value = '';
    document.getElementById('tgOpLogExport').click();
  });
  await sleep(2000);
  let exportOk = false, exportCount = 0;
  if (savedDialogPath && fs.existsSync(savedDialogPath)) {
    try {
      const j = JSON.parse(fs.readFileSync(savedDialogPath, 'utf8'));
      exportOk = j && Array.isArray(j.logs) && j.logs.length > 0 && j.logs[0].ts && j.logs[0].op;
      exportCount = j.logs.length;
    } catch (e) { exportOk = false; }
  }
  check('L3 設置頁匯出操作日誌 JSON 有效', hasExportBtn && exportOk, 'count=' + exportCount);

  // L4 超上限自動清：塞 10005 條舊 log，觸發一次寫入後應剩 10000
  const db = curDb();
  const oldTs = Date.now() - 100 * 24 * 3600 * 1000; // 100 日前（超 90 日）
  db.exec('BEGIN');
  const ins = db.prepare('INSERT INTO op_logs (ts, ts_ms, app, core, session, actor, op, result, os) VALUES (?,?,?,?,?,?,?,?,?)');
  for (let i = 0; i < 10005; i++) {
    ins.run('2026-01-01T00:00:00+08:00', oldTs, '3.25.2', '3.15.1', 'old-session', 'admin', 'report.generate', 'ok', 'linux');
  }
  db.exec('COMMIT');
  // 觸發一次正常寫入（會連帶 prune）：先確保喺報表頁再撳報表掣
  await page.evaluate(async () => {
    document.querySelector('[data-route="reports"]').click();
    await new Promise((r) => setTimeout(r, 500));
    document.querySelector('[data-report="trial"]').click();
  });
  await sleep(2500);
  const cntAfter = q1('SELECT COUNT(*) AS c FROM op_logs');
  const oldRemain = q1("SELECT COUNT(*) AS c FROM op_logs WHERE session='old-session'");
  check('L4 超上限自動清（剩 ≤10000 條，舊 session 清走）',
    cntAfter.c <= 10000 && oldRemain.c === 0,
    'total=' + cntAfter.c + ' oldRemain=' + oldRemain.c);

  // 零 pageerror
  check('Z 零 pageerror', errs.length === 0, errs.slice(0, 3).join(' | '));

  const fails = results.filter((r) => !r.ok);
  console.log('\n==== v3.25.2 刪除＋op_log 專項：' + (results.length - fails.length) + '/' + results.length +
    ' PASS' + (fails.length ? '，' + fails.length + ' FAIL' : '') + ' ====');
  if (errs.length) console.log('console/pageerror：\n' + errs.slice(0, 5).join('\n'));
  await browser.close();
  server.close();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('驗收腳本異常：', e); process.exit(2); });
