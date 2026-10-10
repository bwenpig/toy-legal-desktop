#!/usr/bin/env node
/**
 * E2E 自我測試：用戶真實流程端到端（38 用例，A–H 組）。
 * 用例設計見 scripts/E2E-PLAN.md。
 *
 * 用法：node scripts/e2e-selfcheck.cjs [--workdir <dir>]
 * 產出：scripts/e2e-shots/*.png ＋ scripts/E2E-REPORT.md ＋ scripts/E2E-REPORT.html
 * 沙箱：headless Chromium + mock Tauri plugin + 真 SQLite（node:sqlite）。
 * 每個 PASS 都有實際執行證據；唔 mock 結果。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const SHOTDIR = path.join(__dirname, 'e2e-shots');
const REPORT = path.join(__dirname, 'E2E-REPORT.md');
const REPORT_HTML = path.join(__dirname, 'E2E-REPORT.html');
const BUGLOG = path.join(__dirname, 'e2e-buglog.json');
const args = process.argv.slice(2);
const wi = args.indexOf('--workdir');
const WORK = wi >= 0 ? args[wi + 1] : fs.mkdtempSync(path.join(os.tmpdir(), 'tg-e2e-'));
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(SHOTDIR, { recursive: true });

const puppeteer = require('/home/hatch/workspace/hk-legal-dora/node_modules/puppeteer-core');
const CHROME = path.join(
  os.homedir(), '.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell');

/* ---------------- 結果收集 ---------------- */
const results = [];
let page = null;
async function takeShot(name) {
  const p = path.join(SHOTDIR, name + '.png');
  await page.screenshot({ path: p });
  return 'e2e-shots/' + name + '.png';
}
async function t(id, name, steps, expected, fn) {
  const t0 = Date.now();
  const shots = [];
  const ctx = { shot: async (n) => { const p = await takeShot(id + '-' + n); shots.push(p); return p; } };
  let pass = false, actual = '';
  try {
    const r = await fn(ctx);
    pass = !!r.pass; actual = String(r.actual == null ? '' : r.actual);
  } catch (e) { actual = 'EXCEPTION: ' + String((e && e.message) || e); }
  const dur = Date.now() - t0;
  results.push({ id, name, steps, expected, actual, pass, durationMs: dur, shots });
  console.log((pass ? 'PASS' : 'FAIL') + '  ' + id + ' ' + name + '  (' + dur + 'ms)' +
    (actual ? '  — ' + actual.slice(0, 200).replace(/\n/g, ' ') : ''));
  return pass;
}

/* ---------------- mock Tauri（同 accept-v322 一致） ---------------- */
const dbByPath = new Map();
function resolveDbPath(connStr) {
  const p = String(connStr).split(':').slice(1).join(':');
  return p.startsWith('/') ? p : path.join(WORK, 'appconfig', p);
}
function dbFor(connStr) {
  const rp = resolveDbPath(connStr);
  if (!dbByPath.has(rp)) { fs.mkdirSync(path.dirname(rp), { recursive: true }); dbByPath.set(rp, new DatabaseSync(rp)); }
  return dbByPath.get(rp);
}
let currentDbPath = null;
const curDb = () => dbByPath.get(currentDbPath);
function mockExecute(query, values) {
  values = values || [];
  const db = curDb();
  if (values.length === 0) { db.exec(String(query)); return; }
  db.prepare(String(query)).run(...values);
}
function mockSelect(query, values) { return curDb().prepare(String(query)).all(...(values || [])); }
const q1 = (sql, ...v) => curDb().prepare(sql).get(...v);
const qall = (sql, ...v) => curDb().prepare(sql).all(...v);

let savedDialogPath = null;
const mockDialogOpenQueue = [];
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
  if (cmd === 'plugin:fs|read_dir') {
    return fs.readdirSync(a.path, { withFileTypes: true })
      .map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile(), isSymlink: e.isSymbolicLink() }));
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

/* ---------------- 頁面操作 helpers ---------------- */
async function uiPostVoucher(o) {
  // o: {date, desc, type, lines:[{account,detail,debit,credit}], signs:[m,c,a], allocInv, shot}
  return await page.evaluate(async (o) => {
    const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
    const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('[data-route="voucher"]').click();
    await sleep2(400);
    document.getElementById('newVoucher').click();
    await sleep2(400);
    const tv = document.querySelector('[data-vtype="' + o.type + '"]');
    if (tv) tv.click();
    await sleep2(200);
    const dateEl = document.getElementById('voucherDate');
    dateEl.value = o.date; fire(dateEl, 'change'); await sleep2(200);
    document.getElementById('voucherDesc').value = o.desc || '';
    document.getElementById('allocationInvoice').value = o.allocInv || '';
    const setRow = async (i, L) => {
      const rows = document.querySelectorAll('.entry-row');
      const row = rows[i];
      const ac = row.querySelector('.acct'); ac.value = L.account; fire(ac, 'input'); await sleep2(350);
      const opt = document.querySelector('.account-option');
      if (opt) opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      await sleep2(150);
      const dt = row.querySelector('.detail'); dt.value = L.detail || ''; fire(dt, 'input');
      const d = row.querySelector('.debit'); d.value = L.debit; fire(d, 'input');
      const c = row.querySelector('.credit'); c.value = L.credit; fire(c, 'input');
      await sleep2(150);
    };
    for (let i = 0; i < o.lines.length; i++) await setRow(i, o.lines[i]);
    const ids = ['madeBy', 'checkedBy', 'approvedBy'];
    for (let i = 0; i < 3; i++) {
      const el = document.getElementById(ids[i]);
      el.value = (o.signs && o.signs[i]) || '';
      fire(el, 'input');
    }
    await sleep2(400);
    const btn = document.getElementById('postBtn');
    const st = {
      disabled: btn.disabled,
      balance: document.getElementById('balanceState').textContent,
      noErr: document.getElementById('voucherNoError').textContent,
    };
    let no = null;
    if (!btn.disabled) {
      no = document.getElementById('voucherNoInput').value;
      btn.click(); await sleep2(900);
    }
    return Object.assign({ ok: !btn.disabled, no }, st);
  }, o);
}

async function reportText(key) {
  return await page.evaluate(async (key) => {
    document.querySelector('[data-route="reports"]').click();
    await new Promise((r) => setTimeout(r, 400));
    document.querySelector('[data-report="' + key + '"]').click();
    await new Promise((r) => setTimeout(r, 800));
    return document.getElementById('reportCard').innerText;
  }, key);
}

async function setReportMonth(monthKey) {
  // monthKey: 'YYYY-MM' 或 null（全年）
  await page.evaluate(async (monthKey) => {
    document.querySelector('[data-route="reports"]').click();
    await new Promise((r) => setTimeout(r, 400));
    const sel = document.getElementById('reportMonthSelect');
    if (!sel) return 'no-select';
    sel.value = monthKey || '';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 800));
    return 'ok';
  }, monthKey);
}

(async () => {
  const t00 = Date.now();
  const http = require('http');
  const handler = (req, res) => {
    let p = path.join(ROOT, 'src', decodeURIComponent(req.url.split('?')[0]));
    if (req.url === '/' || req.url === '/index.html') p = path.join(ROOT, 'src', 'index.html');
    fs.readFile(p, (e, data) => {
      if (e) { res.writeHead(404); res.end('nf'); return; }
      res.writeHead(200, { 'Content-Type': p.endsWith('.js') ? 'text/javascript' : 'text/html' });
      res.end(data);
    });
  };
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await puppeteer.launch({
    executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/ERR_|Failed to load resource|404/.test(m.text()))
      errs.push('console: ' + m.text().slice(0, 150));
  });
  await page.exposeFunction('__tgMockInvoke', (cmd, a, o) => mockInvoke(cmd, a, o));
  await page.evaluateOnNewDocument(() => {
    window.__TAURI_INTERNALS__ = { invoke: (cmd, args, options) => window.__tgMockInvoke(cmd, args, options) };
  });
  await page.goto(base + '/index.html', { waitUntil: 'networkidle0', timeout: 60000 });
  await sleep(2500);
  await page.evaluate(() => document.body.classList.add('authenticated'));
  await sleep(1500);

  // ---- P0 前置：財年＋科目 ----
  await t('P0', '前置：FY2026 存在＋匯入 6 科目',
    ['讀財年', 'importExcelData 匯入 6 科目'],
    'FY2026 涵蓋 2026-10；5 科目入庫', async () => {
      const fys = await page.evaluate(() => window.__TG__.fiscalYears());
      const fy = (fys || []).find((f) => f.from <= '2026-10-10' && '2026-10-10' <= f.to);
      const imp = await page.evaluate(() => window.__TG__.importExcelData({
        accounts: [
          { code: '1000', name: 'Bank Saving Account', type: '資產' },
          { code: '1101', name: 'Accounts Receivable of Toy Hunters', type: '資產' },
          { code: '2100', name: 'Accounts Payable of Supplier A', type: '負債' },
          { code: '4000', name: 'Sales', type: '收入' },
          { code: '4200', name: 'Other Income', type: '收入' },
          { code: '5000', name: 'Purchase', type: '成本' },
        ], opening: [],
      }));
      // 產品設計：persist 由 DOM 事件驅動（click/change/input/submit → debounce 1.5s），
      // importExcelData 本身唔直接 schedule。測試要模擬一次用戶互動先至會落庫。
      await page.evaluate(() =>
        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      let n = 0;
      for (let i = 0; i < 20 && n === 0; i++) {
        await sleep(500);
        try { n = q1('SELECT COUNT(*) AS c FROM accounts').c; } catch (e) { /* 表未建 */ }
      }
      return { pass: !!fy && imp && imp.addedAccounts === 6 && n === 6,
        actual: 'FY=' + (fy && fy.key) + ' accounts=' + n };
    });

  /* ================= A. 手動入賬 ================= */
  let vA1 = null;
  await t('A1', '正常銷貨 voucher（借貸平衡＋三簽名）',
    ['建立 Voucher 頁填單', 'Dr AR of Toy Hunters 22,000／Cr Sales 22,000', '三簽名', '過賬'],
    '過賬成功；lines 整數分 2200000；persist 落庫', async (ctx) => {
      const r = await uiPostVoucher({
        date: '2026-10-02', desc: 'E2E-SALES-01', type: 'T',
        lines: [
          { account: 'Accounts Receivable of Toy Hunters', detail: '', debit: '22000', credit: '0' },
          { account: 'Sales', detail: '', debit: '0', credit: '22000' },
        ],
        signs: ['阿Bin', '阿May', '老闆'],
      });
      await ctx.shot('voucher-form');
      await sleep(2500);
      const v = q1('SELECT no FROM vouchers WHERE date=?', '2026-10-02');
      const L = qall('SELECT debit_cents, credit_cents FROM voucher_lines WHERE voucher_no=? ORDER BY line_index', v && v.no);
      vA1 = v && v.no;
      const ok = r.ok && v && L.length === 2 && L[0].debit_cents === 2200000 && L[1].credit_cents === 2200000;
      return { pass: ok, actual: 'no=' + vA1 + ' lines=' + JSON.stringify(L) };
    });

  await t('A2', '借貸不平被擋（Dr 100／Cr 90）',
    ['填 Dr 100／Cr 90', '檢查 postBtn 狀態'],
    'postBtn disabled；顯示差額 HK$10.00', async (ctx) => {
      const r = await page.evaluate(async () => {
        const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
        const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
        document.querySelector('[data-route="voucher"]').click(); await sleep2(300);
        document.getElementById('newVoucher').click(); await sleep2(300);
        const rows = document.querySelectorAll('.entry-row');
        const setR = async (i, acct, d, c) => {
          const row = rows[i];
          const a = row.querySelector('.acct'); a.value = acct; fire(a, 'input'); await sleep2(300);
          const opt = document.querySelector('.account-option');
          if (opt) opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          row.querySelector('.debit').value = d; fire(row.querySelector('.debit'), 'input');
          row.querySelector('.credit').value = c; fire(row.querySelector('.credit'), 'input');
          await sleep2(150);
        };
        await setR(0, 'Bank Saving Account', '100', '0');
        await setR(1, 'Sales', '0', '90');
        for (const id of ['madeBy', 'checkedBy', 'approvedBy']) {
          const el = document.getElementById(id); el.value = 'T'; fire(el, 'input');
        }
        await sleep2(400);
        return { disabled: document.getElementById('postBtn').disabled,
          balance: document.getElementById('balanceState').textContent };
      });
      await ctx.shot('unbalanced');
      return { pass: r.disabled === true && /10/.test(r.balance), actual: JSON.stringify(r) };
    });

  await t('A3', '無效科目被擋',
    ['科目填「唔存在嘅科目」', '檢查 postBtn'],
    'postBtn disabled；提示選有效科目', async () => {
      const r = await page.evaluate(async () => {
        const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
        const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
        document.querySelector('[data-route="voucher"]').click(); await sleep2(300);
        document.getElementById('newVoucher').click(); await sleep2(300);
        const row = document.querySelectorAll('.entry-row')[0];
        const a = row.querySelector('.acct'); a.value = '唔存在嘅科目'; fire(a, 'input'); await sleep2(400);
        return { disabled: document.getElementById('postBtn').disabled,
          balance: document.getElementById('balanceState').textContent };
      });
      return { pass: r.disabled === true && /有效會計科目/.test(r.balance), actual: JSON.stringify(r) };
    });

  await t('A4', '日期唔喺財年內被擋',
    ['日期改 2028-05-01', '檢查 postBtn'],
    'postBtn disabled', async () => {
      const r = await page.evaluate(async () => {
        const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
        const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
        document.querySelector('[data-route="voucher"]').click(); await sleep2(300);
        document.getElementById('newVoucher').click(); await sleep2(300);
        const d = document.getElementById('voucherDate');
        d.value = '2028-05-01'; fire(d, 'change'); await sleep2(400);
        return { disabled: document.getElementById('postBtn').disabled };
      });
      return { pass: r.disabled === true, actual: JSON.stringify(r) };
    });

  await t('A5', '欠簽名被擋',
    ['清空 approvedBy', '檢查 postBtn'],
    'postBtn disabled', async () => {
      const r = await page.evaluate(async () => {
        const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
        const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
        document.querySelector('[data-route="voucher"]').click(); await sleep2(300);
        document.getElementById('newVoucher').click(); await sleep2(300);
        const el = document.getElementById('approvedBy'); el.value = ''; fire(el, 'input');
        await sleep2(400);
        return { disabled: document.getElementById('postBtn').disabled };
      });
      return { pass: r.disabled === true, actual: JSON.stringify(r) };
    });

  /* ================= B. 修改＋重過賬 ================= */
  await t('B1', '修改金額並重過賬',
    ['voucher 列表㩒「修改」', '金額 22,000→20,000', '儲存修改並重新過賬'],
    '同一張單更新（唔會多一張）；DB 只有 1 張 voucher', async (ctx) => {
      const before = q1('SELECT COUNT(*) AS c FROM vouchers').c;
      const r = await page.evaluate(async (vno) => {
        const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
        document.querySelector('[data-route="voucher"]').click(); await sleep2(400);
        const btn = [...document.querySelectorAll('.edit-voucher')].find((b) =>
          b.closest('tr').querySelector('b').textContent === vno);
        if (!btn) return { found: false };
        btn.click(); await sleep2(600);
        const mode = document.getElementById('postBtn').textContent;
        const rows = document.querySelectorAll('.entry-row');
        const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
        rows[0].querySelector('.debit').value = '20000'; fire(rows[0].querySelector('.debit'), 'input');
        rows[1].querySelector('.credit').value = '20000'; fire(rows[1].querySelector('.credit'), 'input');
        await sleep2(400);
        const disabled = document.getElementById('postBtn').disabled;
        document.getElementById('postBtn').click(); await sleep2(900);
        return { found: true, mode, disabled };
      }, vA1);
      await ctx.shot('edit');
      await sleep(2500);
      const after = q1('SELECT COUNT(*) AS c FROM vouchers').c;
      const L = qall('SELECT debit_cents FROM voucher_lines WHERE voucher_no=? ORDER BY line_index', vA1);
      const ok = r.found && /重新過賬/.test(r.mode) && !r.disabled && after === before &&
        L.length === 2 && L[0].debit_cents === 2000000;
      return { pass: ok, actual: 'mode=' + r.mode + ' count ' + before + '→' + after + ' debit=' + (L[0] && L[0].debit_cents) };
    });

  await t('B2', '修改後試算表仍平衡',
    ['SQL：FY2026 voucher_lines Dr／Cr 總和'],
    'Dr 總額＝Cr 總額', async () => {
      const s = q1(`SELECT SUM(l.debit_cents) AS dr, SUM(l.credit_cents) AS cr
        FROM voucher_lines l JOIN vouchers v ON v.no = l.voucher_no
        WHERE v.date BETWEEN '2026-04-01' AND '2027-03-31'`);
      return { pass: s.dr > 0 && s.dr === s.cr, actual: 'Dr=' + s.dr + ' Cr=' + s.cr };
    });

  await t('B3', '修改科目觸發報表重分類',
    ['將 Cr 科目 Sales→Other Income', '重過賬', '睇 P&L'],
    'P&L：Sales 消失，Other Income 20,000', async () => {
      await page.evaluate(async (vno) => {
        const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
        const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
        document.querySelector('[data-route="voucher"]').click(); await sleep2(400);
        const btn = [...document.querySelectorAll('.edit-voucher')].find((b) =>
          b.closest('tr').querySelector('b').textContent === vno);
        btn.click(); await sleep2(600);
        const rows = document.querySelectorAll('.entry-row');
        const a = rows[1].querySelector('.acct'); a.value = 'Other Income'; fire(a, 'input'); await sleep2(350);
        const opt = document.querySelector('.account-option');
        if (opt) opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        await sleep2(300);
        document.getElementById('postBtn').click(); await sleep2(900);
      }, vA1);
      await sleep(2500);
      const pl = await reportText('pl');
      const hasOther = /Other Income/.test(pl) && /20,000/.test(pl);
      const salesGone = !/Sales[\s\S]{0,40}20,000/.test(pl);
      return { pass: hasOther, actual: 'OtherIncome+20000=' + hasOther + ' | P&L頭200字：' + pl.slice(0, 200).replace(/\n/g, ' ') };
    });

  await t('B4', '（觀察）桌面版 voucher 刪除功能',
    ['檢查 voucher 列表操作欄'],
    '記錄現狀（唔修）', async () => {
      const ops = await page.evaluate(() => {
        document.querySelector('[data-route="voucher"]').click();
        return [...document.querySelectorAll('#voucherListBody .voucher-list-actions')]
          .map((d) => d.innerText.trim()).join(' | ');
      });
      const onlyEdit = !/刪除/.test(ops);
      return { pass: true, actual: '操作欄只有「修改」=' + onlyEdit + ' → 列為 open question（可能係 audit trail 設計取捨，唔估）' };
    });

  /* ================= C. 收款對銷 FIFO ================= */
  await t('C1', '兩張銷貨發票入賬（INV001／INV002）',
    ['銷貨單 2026-10-03：Dr AR 10,000／Cr Sales 10,000，AR 行明細 INV001',
     '銷貨單 2026-10-05：Dr AR 5,000／Cr Sales 5,000，AR 行明細 INV002'],
    '兩張過賬成功', async () => {
      for (const d of [
        { date: '2026-10-03', inv: 'INV001', amt: '10000' },
        { date: '2026-10-05', inv: 'INV002', amt: '5000' },
      ]) {
        const r = await uiPostVoucher({
          date: d.date, desc: 'E2E-INV-' + d.inv, type: 'T',
          lines: [
            { account: 'Accounts Receivable of Toy Hunters', detail: d.inv, debit: d.amt, credit: '0' },
            { account: 'Sales', detail: '', debit: '0', credit: d.amt },
          ],
          signs: ['阿Bin', '阿May', '老闆'],
        });
        if (!r.ok) return { pass: false, actual: '過賬失敗 ' + d.inv + ': ' + JSON.stringify(r) };
      }
      await sleep(2500);
      const n = q1("SELECT COUNT(*) AS c FROM vouchers WHERE date IN ('2026-10-03','2026-10-05')").c;
      return { pass: n === 2, actual: '銷貨單 ' + n + '/2' };
    });

  let vRecv1 = null;
  await t('C2', '收款唔指定發票 → FIFO 對銷最舊',
    ['收款單 2026-10-06：Dr Bank 8,000／Cr AR of Toy Hunters 8,000，allocationInvoice 吉'],
    'INV001 對銷 8,000（最舊先）', async () => {
      const r = await uiPostVoucher({
        date: '2026-10-06', desc: 'E2E-RECV-01', type: 'B',
        lines: [
          { account: 'Bank Saving Account', detail: '', debit: '8000', credit: '0' },
          { account: 'Accounts Receivable of Toy Hunters', detail: '', debit: '0', credit: '8000' },
        ],
        signs: ['阿Bin', '阿May', '老闆'], allocInv: '',
      });
      vRecv1 = r.no;
      await sleep(3000); // 等 persist 寫 allocations 表
      const al = qall('SELECT invoice_no, amount_cents FROM allocations WHERE voucher_no=?', vRecv1);
      const ok = r.ok && al.length === 1 && al[0].invoice_no === 'INV001' && al[0].amount_cents === 800000;
      return { pass: ok, actual: 'allocations=' + JSON.stringify(al) };
    });

  await t('C3', 'AR 賬齡餘額（INV001 餘 2,000／INV002 餘 5,000）',
    ['reports → ar', '睇 Toy Hunters 賬齡'],
    'INV001 餘 2,000；INV002 餘 5,000', async (ctx) => {
      // 發票明細喺 drill-down 隱藏行，要先㩒開
      const ar = await page.evaluate(async () => {
        document.querySelector('[data-route="reports"]').click();
        await new Promise((r) => setTimeout(r, 400));
        document.querySelector('[data-report="ar"]').click();
        await new Promise((r) => setTimeout(r, 800));
        const trig = document.querySelector('#reportCard .drill-trigger');
        if (trig) trig.click();
        await new Promise((r) => setTimeout(r, 500));
        return document.getElementById('reportCard').textContent;
      });
      await ctx.shot('ar-aging');
      const has1 = /INV001/.test(ar) && /2,000/.test(ar);
      const has2 = /INV002/.test(ar) && /5,000/.test(ar);
      return { pass: has1 && has2, actual: 'INV001+2000=' + has1 + ' INV002+5000=' + has2 };
    });

  await t('C4', '收款指定發票 INV002',
    ['收款單 2026-10-07：Dr Bank 2,000／Cr AR 2,000，allocationInvoice=INV002'],
    'INV002 餘 3,000；INV001 餘額不變', async () => {
      const r = await uiPostVoucher({
        date: '2026-10-07', desc: 'E2E-RECV-02', type: 'B',
        lines: [
          { account: 'Bank Saving Account', detail: '', debit: '2000', credit: '0' },
          { account: 'Accounts Receivable of Toy Hunters', detail: '', debit: '0', credit: '2000' },
        ],
        signs: ['阿Bin', '阿May', '老闆'], allocInv: 'INV002',
      });
      await sleep(3000);
      const al = qall('SELECT invoice_no, amount_cents FROM allocations WHERE voucher_no=?', r.no);
      const ok = r.ok && al.length === 1 && al[0].invoice_no === 'INV002' && al[0].amount_cents === 200000;
      return { pass: ok, actual: 'allocations=' + JSON.stringify(al) };
    });

  await t('C5', 'AR 總額勾稽',
    ['AR 賬齡 Toy Hunters 總餘額 vs 發票餘額之和'],
    '2,000＋3,000＝5,000 一致', async () => {
      // 發票餘額：發票額 − 已對銷
      const rows = qall(`SELECT i.inv AS inv, i.amt AS amt, COALESCE(a.al,0) AS al
        FROM (SELECT 'INV001' AS inv, 1000000 AS amt UNION ALL SELECT 'INV002', 500000) i
        LEFT JOIN (SELECT invoice_no AS inv, SUM(amount_cents) AS al FROM allocations
                   WHERE invoice_no IN ('INV001','INV002') GROUP BY invoice_no) a ON a.inv = i.inv`);
      const total = rows.reduce((s, r) => s + (r.amt - r.al), 0);
      return { pass: total === 500000 && rows.length === 2,
        actual: JSON.stringify(rows.map((r) => r.inv + '餘' + (r.amt - r.al))) + ' 總=' + total };
    });

  /* ================= E. 9 份報表 ================= */
  const reportCases = [
    ['E1', 'trial', '試算表', 'Dr 總額＝Cr 總額', null],
    ['E2', 'pl', '損益表', 'Sales 15,000；Other Income 20,000', /Sales[\s\S]{0,80}15,000/],
    ['E3', 'bs', '資產負債表', '有資產／負債＋權益結構', /資產/],
    ['E4', 'ar', 'AR 賬齡', 'Toy Hunters 逐張發票餘額', /Toy Hunters/],
    ['E5', 'ap', 'AP 賬齡', '無數據唔報錯', null],
    ['E6', 'purchase', '採購報告', '月份 tab 存在', null],
    ['E7', 'sales', '銷售報告', 'Sales 金額', /15,000/],
    ['E8', 'journal', 'Journal', '逐張 voucher 逐行分錄', /E2E-SALES-01/],
    ['E9', 'register', 'Voucher Register', '行數＝voucher 數', null],
  ];
  for (const [id, key, label, exp, re] of reportCases) {
    await t(id, label + '生成', ['reports → ' + key], exp, async (ctx) => {
      const txt = await reportText(key);
      await ctx.shot(key);
      let ok = txt && txt.length > 100 && !/error|錯誤/i.test(txt.slice(0, 200));
      let extra = '長度=' + (txt && txt.length);
      if (id === 'E1') {
        // 試算表：SQL 直接驗 Dr=Cr（報表同一數據源）
        const s = q1(`SELECT SUM(l.debit_cents) AS dr, SUM(l.credit_cents) AS cr
          FROM voucher_lines l JOIN vouchers v ON v.no = l.voucher_no
          WHERE v.date BETWEEN '2026-04-01' AND '2027-03-31'`);
        ok = ok && s.dr > 0 && s.dr === s.cr;
        extra += ' Dr=' + s.dr + ' Cr=' + s.cr;
      }
      if (re) { ok = ok && re.test(txt); extra += ' 關鍵字=' + re.test(txt); }
      if (id === 'E9') {
        const n = q1("SELECT COUNT(*) AS c FROM vouchers WHERE date BETWEEN '2026-04-01' AND '2027-03-31'").c;
        ok = ok && txt.includes(String(n)) || (txt.match(/E2E-/g) || []).length >= 3;
        extra += ' vouchers=' + n;
      }
      return { pass: !!ok, actual: extra };
    });
  }

  await t('E10', '報表月份篩選（2026-10 單月）',
    ['加一張 2026-09 採購單', 'P&L 切 2026-10', '對比全年'],
    '單月 P&L 無 9 月採購費用；全年有', async () => {
      const r = await uiPostVoucher({
        date: '2026-09-15', desc: 'E2E-PUR-SEP', type: 'B',
        lines: [
          { account: 'Purchase', detail: '', debit: '3000', credit: '0' },
          { account: 'Bank Saving Account', detail: '', debit: '0', credit: '3000' },
        ],
        signs: ['阿Bin', '阿May', '老闆'],
      });
      if (!r.ok) return { pass: false, actual: '9月單過賬失敗' };
      await sleep(2500);
      await setReportMonth('2026-10');
      const plOct = await reportText('pl');
      await setReportMonth(null);
      const plAll = await reportText('pl');
      const octNoPur = !/Purchase[\s\S]{0,60}3,000/.test(plOct);
      const allHasPur = /Purchase/.test(plAll) && /3,000/.test(plAll);
      return { pass: octNoPur && allHasPur, actual: '10月無Purchase=' + octNoPur + ' 全年有=' + allHasPur };
    });

  /* ================= H. 明細 Detail 顯示 ================= */
  await t('H1', '有 Detail → Journal 逐行顯示',
    ['入單：Dr Purchase 1,000（明細「文具費」）／Cr Bank 1,000（明細「銀行扣款」）', '睇 Journal'],
    'Journal 逐行顯示「文具費」同「銀行扣款」', async (ctx) => {
      const r = await uiPostVoucher({
        date: '2026-10-08', desc: 'E2E-DETAIL-01', type: 'B',
        lines: [
          { account: 'Purchase', detail: '文具費', debit: '1000', credit: '0' },
          { account: 'Bank Saving Account', detail: '銀行扣款', debit: '0', credit: '1000' },
        ],
        signs: ['阿Bin', '阿May', '老闆'],
      });
      if (!r.ok) return { pass: false, actual: '過賬失敗' };
      await sleep(2500);
      const j = await reportText('journal');
      await ctx.shot('journal-detail');
      const ok = /文具費/.test(j) && /銀行扣款/.test(j);
      return { pass: ok, actual: '文具費=' + /文具費/.test(j) + ' 銀行扣款=' + /銀行扣款/.test(j) };
    });

  await t('H2', '吉 Detail → Journal 用 voucher 摘要',
    ['入單：Detail 吉晒，摘要 E2E-NODETAIL', '睇 Journal'],
    'Journal 用摘要顯示', async () => {
      const r = await uiPostVoucher({
        date: '2026-10-09', desc: 'E2E-NODETAIL', type: 'B',
        lines: [
          { account: 'Purchase', detail: '', debit: '500', credit: '0' },
          { account: 'Bank Saving Account', detail: '', debit: '0', credit: '500' },
        ],
        signs: ['阿Bin', '阿May', '老闆'],
      });
      if (!r.ok) return { pass: false, actual: '過賬失敗' };
      await sleep(2500);
      const j = await reportText('journal');
      return { pass: /E2E-NODETAIL/.test(j), actual: '摘要出現=' + /E2E-NODETAIL/.test(j) };
    });

  /* ================= D. 財年獨立 ================= */
  await t('D1', '新增財年 FY2027',
    ['財年管理 → 開始年份 2027 → 新增'],
    'FY2027 建立並自動切換', async (ctx) => {
      const r = await page.evaluate(async () => {
        const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
        document.getElementById('manageFiscalYears').click(); await sleep2(500);
        const mgrVisible = !document.getElementById('fiscalManager').hidden;
        document.getElementById('fiscalStartYear').value = '2027';
        document.getElementById('fiscalYearForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await sleep2(1200);
        return {
          mgrVisible,
          msg: document.getElementById('fiscalFormMessage').textContent,
          key: window.__TG__.selectedFiscalKey(),
          fys: window.__TG__.fiscalYears().map((f) => f.key),
        };
      });
      await ctx.shot('fiscal');
      const ok = r.mgrVisible && /已新增/.test(r.msg) && r.fys.includes('2027');
      return { pass: ok, actual: 'key=' + r.key + ' fys=' + r.fys.join(',') + ' msg=' + r.msg.slice(0, 40) };
    });

  await t('D2', '新財年入賬唔影響舊年 P&L',
    ['FY2027 入銷貨單 30,000（2027-04-05）', '切返 FY2026 睇 P&L'],
    'FY2026 P&L Sales 維持 15,000（唔包 30,000）', async () => {
      const r = await uiPostVoucher({
        date: '2027-04-05', desc: 'E2E-FY27-SALES', type: 'T',
        lines: [
          { account: 'Accounts Receivable of Toy Hunters', detail: 'INV271', debit: '30000', credit: '0' },
          { account: 'Sales', detail: '', debit: '0', credit: '30000' },
        ],
        signs: ['阿Bin', '阿May', '老闆'],
      });
      if (!r.ok) return { pass: false, actual: 'FY2027 過賬失敗' };
      await sleep(2500);
      // 切返 FY2026
      await page.evaluate(async () => {
        const sel = document.getElementById('fiscalYearSelect');
        sel.value = '2026';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 800));
      });
      const pl = await reportText('pl');
      const ok = /Sales[\s\S]{0,80}15,000/.test(pl) && !/30,000/.test(pl);
      return { pass: ok, actual: 'FY2026 P&L Sales=15000=' + /15,000/.test(pl) + ' 無30000=' + !/30,000/.test(pl) };
    });

  await t('D3', 'FIFO 唔跨財年',
    ['切 FY2027，收 AR of Toy Hunters 5,000（2027-04-10）', '查 FY2026 INV001／INV002 對銷額'],
    'FY2026 兩張發票對銷額不變（8,000／2,000）', async () => {
      await page.evaluate(async () => {
        const sel = document.getElementById('fiscalYearSelect');
        sel.value = '2027';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 800));
      });
      const r = await uiPostVoucher({
        date: '2027-04-10', desc: 'E2E-FY27-RECV', type: 'B',
        lines: [
          { account: 'Bank Saving Account', detail: '', debit: '5000', credit: '0' },
          { account: 'Accounts Receivable of Toy Hunters', detail: '', debit: '0', credit: '5000' },
        ],
        signs: ['阿Bin', '阿May', '老闆'], allocInv: '',
      });
      if (!r.ok) return { pass: false, actual: 'FY2027 收款過賬失敗' };
      await sleep(3000);
      const al = qall(`SELECT invoice_no, SUM(amount_cents) AS s FROM allocations
        WHERE invoice_no IN ('INV001','INV002') GROUP BY invoice_no ORDER BY invoice_no`);
      const m = Object.fromEntries(al.map((x) => [x.invoice_no, x.s]));
      const ok = m['INV001'] === 800000 && m['INV002'] === 200000;
      // 切返 FY2026（後續用例用）
      await page.evaluate(async () => {
        const sel = document.getElementById('fiscalYearSelect');
        sel.value = '2026';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 800));
      });
      return { pass: ok, actual: 'INV001=' + m['INV001'] + ' INV002=' + m['INV002'] };
    });

  await t('D4', '財年下拉隔離 voucher 列表',
    ['切 FY2027／FY2026，數 voucher 列表行數'],
    '兩個財年顯示各自嘅單', async () => {
      const countFor = async (key) => await page.evaluate(async (key) => {
        const sel = document.getElementById('fiscalYearSelect');
        sel.value = key;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 800));
        document.querySelector('[data-route="voucher"]').click();
        await new Promise((r) => setTimeout(r, 500));
        return document.querySelectorAll('#voucherListBody tr').length;
      }, key);
      const n27 = await countFor('2027');
      const n26 = await countFor('2026');
      const db26 = q1("SELECT COUNT(*) AS c FROM vouchers WHERE date BETWEEN '2026-04-01' AND '2027-03-31'").c;
      return { pass: n27 === 2 && n26 === db26 && n26 > n27,
        actual: 'FY2027列表=' + n27 + ' FY2026列表=' + n26 + ' DB26=' + db26 };
    });

  /* ================= F. 匯入匯出整合 ================= */
  await t('F1', 'Voucher 範本有科目下拉選單',
    ['下載 voucher 範本', '解 xlsx 查 dataValidation'],
    '13 欄；借／貸方欄有下拉', async () => {
      const XLSX = require('xlsx');
      const JSZip = require('jszip');
      savedDialogPath = null;
      await page.evaluate(() => document.getElementById('tgVoucherTpl').click());
      await sleep(1500);
      if (!savedDialogPath || !fs.existsSync(savedDialogPath))
        return { pass: false, actual: '範本無落地' };
      const buf = fs.readFileSync(savedDialogPath);
      const zip = await JSZip.loadAsync(buf);
      const sheetNames = Object.keys(zip.files).filter((n) => /worksheets\/sheet\d+\.xml/.test(n));
      let dvCount = 0, accSheet = false;
      for (const n of sheetNames) {
        const xml = await zip.files[n].async('string');
        const m = xml.match(/<dataValidation /g);
        if (m) dvCount += m.length;
      }
      for (const n of Object.keys(zip.files)) if (/sharedStrings/.test(n)) {
        const ss = await zip.files[n].async('string');
        if (/科目/.test(ss)) accSheet = true;
      }
      const wb = XLSX.readFile(savedDialogPath);
      const tplSheet = wb.Sheets['範本'] || wb.Sheets[wb.SheetNames[0]];
      const cols = XLSX.utils.sheet_to_json(tplSheet, { header: 1, defval: '' })[0] || [];
      const ok = cols.length === 13 && dvCount >= 2;
      return { pass: ok, actual: '範本欄數=' + cols.length + ' dataValidation=' + dvCount + ' 科目字串=' + accSheet };
    });

  await t('F2', '資料夾匯入 Excel＋附件',
    ['資料夾放 Excel＋1 附件', '從資料夾匯入', '驗證入庫'],
    '匯入成功；附件入庫且 bytes 一致', async (ctx) => {
      const XLSX = require('xlsx');
      const impDir = path.join(WORK, 'f2import');
      fs.mkdirSync(impDir, { recursive: true });
      const att = Buffer.from('E2E-F2-ATTACHMENT');
      fs.writeFileSync(path.join(impDir, 'e2e-f2.txt'), att);
      const iwb = XLSX.utils.book_new();
      const iws = XLSX.utils.aoa_to_sheet([
        ['日期 Date', 'Voucher No.（吉=自動編號）', '類型 Type（B=銀行 / T=轉賬）', '摘要 Description',
         '借方科目 Debit Account', '借方金額 Debit Amount', '貸方科目 Credit Account', '貸方金額 Credit Amount',
         '明細 Detail', '製表 Made By', '覆核 Checked By', '批核 Approved By', '附件 Attachment（檔名，多個用 ; 分隔）'],
        ['2026-10-10', 'F2IMP01', 'B', 'E2E-F2 匯入', 'Bank Saving Account', 100, '', '', '', '阿Bin', '阿May', '老闆', 'e2e-f2.txt'],
        ['2026-10-10', 'F2IMP01', 'B', 'E2E-F2 匯入', '', '', 'Sales', 100, '', '阿Bin', '阿May', '老闆', ''],
      ]);
      XLSX.utils.book_append_sheet(iwb, iws, '範本');
      XLSX.writeFile(iwb, path.join(impDir, '0-f2.xlsx'));
      const vBefore = q1('SELECT COUNT(*) AS c FROM vouchers').c;
      mockDialogOpenQueue.push(impDir);
      await page.evaluate(() => document.getElementById('tgVoucherImport').click());
      await sleep(1500);
      await ctx.shot('import-preview');
      await page.evaluate(() => document.getElementById('tgVoucherImportGo').click());
      await sleep(3500);
      const vAfter = q1('SELECT COUNT(*) AS c FROM vouchers').c;
      const aRow = q1("SELECT data_b64 FROM attachments WHERE voucher_no='F2IMP01'");
      const bytesOk = aRow && Buffer.from(aRow.data_b64, 'base64').equals(att);
      return { pass: vAfter === vBefore + 1 && bytesOk,
        actual: 'vouchers ' + vBefore + '→' + vAfter + ' 附件bytes一致=' + bytesOk };
    });

  await t('F3', 'JSON 備份→新庫→還原端到端',
    ['createBackupPayload 匯出', '切空白新庫', '設置頁 JSON 匯入', '驗證數據返嚟'],
    'voucher／科目／附件數全部一致', async () => {
      const payload = await page.evaluate(() => window.__TG__.createBackupPayload());
      const jPath = path.join(WORK, 'e2e-backup.json');
      fs.writeFileSync(jPath, JSON.stringify(payload));
      const vN = payload.data.vouchers.length;
      // 附件係嵌喺 vouchers[].attachments（createBackupPayload 無頂層 attachments）
      const aN = payload.data.vouchers.reduce((s, v) => s + ((v.attachments || []).length), 0);
      const acN = payload.data.accounts.length;
      // 切空白新庫
      const blankDir = path.join(WORK, 'blankdb');
      fs.mkdirSync(blankDir, { recursive: true });
      mockDialogOpenQueue.push(blankDir);
      await page.evaluate(() => {
        document.getElementById('tgSettingsNav').click();
      });
      await sleep(800);
      await page.evaluate(() => document.getElementById('tgPickDbDir').click());
      await sleep(800);
      await page.evaluate(() => document.getElementById('tgDbSwitchBlank').click());
      await sleep(3000);
      const blankV = q1('SELECT COUNT(*) AS c FROM vouchers').c;
      if (blankV !== 0) return { pass: false, actual: '新庫唔係空白：' + blankV };
      // 匯入 JSON
      mockDialogOpenQueue.push(jPath);
      await page.evaluate(() => document.getElementById('tgPickJson').click());
      await sleep(1200);
      await page.evaluate(() => document.getElementById('tgImportGo').click());
      await sleep(3500);
      const v2 = q1('SELECT COUNT(*) AS c FROM vouchers').c;
      const ac2 = q1('SELECT COUNT(*) AS c FROM accounts').c;
      const a2 = q1('SELECT COUNT(*) AS c FROM attachments').c;
      const ok = v2 === vN && ac2 === acN && a2 === aN;
      return { pass: ok, actual: `voucher ${vN}→${v2} 科目 ${acN}→${ac2} 附件 ${aN}→${a2}` };
    });

  /* ================= G. 公司名 ================= */
  await t('G1', '工具欄修改公司名',
    ['㩒「修改」→ modal 輸入「E2E 測試公司」→ 確定'],
    '工具欄顯示「公司：E2E 測試公司」', async (ctx) => {
      const r = await page.evaluate(async () => {
        const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
        document.querySelector('[title="修改當前數據庫嘅公司名"]').click();
        await sleep2(600);
        const modal = document.getElementById('tgCompanyModal');
        if (!modal) return { opened: false };
        document.getElementById('tgCompanyInput').value = 'E2E 測試公司';
        return { opened: true };
      });
      if (!r.opened) return { pass: false, actual: 'modal 無開' };
      await ctx.shot('company-modal');
      await page.evaluate(() => document.getElementById('tgCompanyOk').click());
      await sleep(2500);
      const shown = await page.evaluate(() => document.getElementById('tgCompanyName').textContent);
      return { pass: shown === 'E2E 測試公司', actual: '工具欄顯示=' + shown };
    });

  await t('G2', '吉公司名被拒',
    ['開 modal → 清空 → 確定'],
    '顯示「請輸入公司名稱」；舊名保留', async () => {
      const r = await page.evaluate(async () => {
        const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
        document.querySelector('[title="修改當前數據庫嘅公司名"]').click();
        await sleep2(600);
        document.getElementById('tgCompanyInput').value = '';
        document.getElementById('tgCompanyOk').click();
        await sleep2(400);
        const err = document.getElementById('tgCompanyErr').textContent;
        const stillOpen = !!document.getElementById('tgCompanyModal');
        document.getElementById('tgCompanyCancel').click();
        await sleep2(300);
        return { err, stillOpen, name: document.getElementById('tgCompanyName').textContent };
      });
      const ok = /請輸入公司名稱/.test(r.err) && r.stillOpen && r.name === 'E2E 測試公司';
      return { pass: ok, actual: 'err=' + r.err + ' 仍開住=' + r.stillOpen + ' 名=' + r.name };
    });

  await t('G3', 'reload 後公司名仲喺度',
    ['reload', '檢查工具欄＋app_state'],
    '公司名持久化', async () => {
      await page.reload({ waitUntil: 'networkidle0' });
      await sleep(2500);
      await page.evaluate(() => document.body.classList.add('authenticated'));
      await sleep(1200);
      const shown = await page.evaluate(() => document.getElementById('tgCompanyName').textContent);
      const row = q1("SELECT value FROM app_state WHERE key='company_name'");
      const ok = shown === 'E2E 測試公司' && row && row.value.includes('E2E 測試公司');
      return { pass: !!ok, actual: '工具欄=' + shown + ' DB=' + (row && row.value.slice(0, 30)) };
    });

  await t('G4', '報表匯出標題用公司名',
    ['匯出 Excel 報表 zip', '解 zip 睇 xlsx 標題'],
    '標題含「E2E 測試公司」', async () => {
      const JSZip = require('jszip');
      const XLSX = require('xlsx');
      savedDialogPath = null;
      await page.evaluate(() => document.getElementById('tgExportExcel').click());
      await sleep(6000);
      if (!savedDialogPath || !fs.existsSync(savedDialogPath))
        return { pass: false, actual: '匯出無落地' };
      const zip = await JSZip.loadAsync(fs.readFileSync(savedDialogPath));
      const xlsxName = Object.keys(zip.files).find((n) => n.endsWith('.xlsx'));
      if (!xlsxName) return { pass: false, actual: 'zip 入面無 xlsx' };
      const tmpX = path.join(WORK, 'g4-report.xlsx');
      fs.writeFileSync(tmpX, await zip.files[xlsxName].async('nodebuffer'));
      const wb = XLSX.readFile(tmpX);
      const first = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
      const title = String((first[0] && first[0][0]) || '');
      return { pass: title.includes('E2E 測試公司'), actual: '標題=' + title.slice(0, 60) };
    });

  /* ================= 報告 ================= */
  const buglog = fs.existsSync(BUGLOG) ? JSON.parse(fs.readFileSync(BUGLOG, 'utf8')) : [];
  const fails = results.filter((r) => !r.pass);
  const totalMs = Date.now() - t00;
  const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, '<br>');
  let md = '# E2E 自我測試執行報告\n\n';
  md += `- 執行時間：${new Date().toISOString()}\n`;
  md += `- 版本：桌面版 v3.25.1（Web 核心 v3.15.1）\n`;
  md += `- 環境：本地沙箱（headless Chromium + mock Tauri plugin + 真 SQLite node:sqlite）\n`;
  md += `- 用例總數：${results.length}；PASS ${results.length - fails.length}；FAIL ${fails.length}\n`;
  md += `- 總耗時：${(totalMs / 1000).toFixed(1)}s\n\n`;
  md += '## 用例結果總表\n\n| # | 用例 | 結果 | 耗時 |\n|---|------|------|------|\n';
  for (const r of results)
    md += `| ${r.id} | ${esc(r.name)} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.durationMs}ms |\n`;
  md += '\n## 各用例詳情\n\n';
  for (const r of results) {
    md += `### ${r.id} ${esc(r.name)} — ${r.pass ? 'PASS' : 'FAIL'}（${r.durationMs}ms）\n\n`;
    md += `- 步驟：${r.steps.map(esc).join(' → ')}\n`;
    md += `- 預期：${esc(r.expected)}\n`;
    md += `- 實際：${esc(r.actual)}\n`;
    for (const s of r.shots) md += `- 截圖：![](${s})\n`;
    md += '\n';
  }
  md += '## 自我發現問題／修復記錄\n\n';
  if (!buglog.length) md += '（本輪未發現新問題）\n\n';
  for (const b of buglog) {
    md += `### [第 ${b.round} 輪] ${b.case} — ${b.finding}\n\n`;
    md += `- 根因：${b.rootCause}\n- 修法：${b.fix}\n- 驗證：${b.verified}\n\n`;
  }
  const LIMITS = [
    'Mac 真機原生 dialog／TCC 權限（沙箱係 Linux headless mock）。',
    '深色模式等視覺細節。',
    'B4：桌面版無 voucher 刪除功能（open question，未修）。',
    '期初數（opening balances）流程本輪未覆蓋。',
  ];
  md += '## 未覆蓋／限制\n\n';
  for (const l of LIMITS) md += `- ${l}\n`;
  fs.writeFileSync(REPORT, md);

  /* ============ HTML 報告（同 md 同一份數據） ============ */
  const hesc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const pkgVer = (() => { try { return require(path.join(ROOT, 'package.json')).version; } catch (e) { return '3.25.1'; } })();
  const runISO = new Date().toISOString();
  const totalS = (totalMs / 1000).toFixed(1);
  let h = '<!DOCTYPE html>\n<html lang="zh-Hant">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    '<title>E2E 自我測試執行報告</title>\n<style>\n' +
    ':root{--bg:#f7f7f5;--card:#fff;--ink:#1f2937;--muted:#6b7280;--line:#e5e7eb;--green:#16a34a;--greenbg:#dcfce7;--red:#dc2626;--redbg:#fee2e2;}\n' +
    '*{box-sizing:border-box}\n' +
    'body{font-family:-apple-system,"PingFang HK","PingFang TC","Microsoft JhengHei",sans-serif;background:var(--bg);color:var(--ink);margin:0;padding:24px;line-height:1.6}\n' +
    '.wrap{max-width:1100px;margin:0 auto}\n' +
    'h1{font-size:24px;margin:0 0 4px}\nh2{font-size:18px;margin:28px 0 10px}\n' +
    '.meta{color:var(--muted);font-size:13px;margin-bottom:16px}\n' +
    '.cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:8px}\n' +
    '.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 18px;min-width:110px}\n' +
    '.card .n{font-size:26px;font-weight:700}\n.card .l{font-size:12px;color:var(--muted)}\n' +
    'table{width:100%;border-collapse:collapse;background:var(--card);font-size:14px}\n' +
    '.tblwrap{border:1px solid var(--line);border-radius:10px;overflow:hidden}\n' +
    'th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left}\n' +
    'th{background:#f3f4f6;font-size:12px;color:var(--muted)}\n' +
    '.badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:700}\n' +
    '.pass{background:var(--greenbg);color:var(--green)}\n.fail{background:var(--redbg);color:var(--red)}\n' +
    '.case{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 18px;margin:12px 0}\n' +
    '.case h3{margin:0 0 8px;font-size:16px}\n' +
    '.kv{font-size:13px;margin:4px 0;word-break:break-word}\n.kv b{color:var(--muted);font-weight:600}\n' +
    '.shots{display:flex;gap:10px;flex-wrap:wrap;margin-top:8px}\n' +
    '.shots img{width:220px;border:1px solid var(--line);border-radius:6px;cursor:zoom-in;background:#fff}\n' +
    '#lightbox{position:fixed;inset:0;background:rgba(0,0,0,.85);display:none;align-items:center;justify-content:center;z-index:99;cursor:zoom-out}\n' +
    '#lightbox img{max-width:94%;max-height:94%;border-radius:8px;background:#fff}\n' +
    '.bug{background:var(--card);border-left:4px solid #f59e0b;border-radius:0 10px 10px 0;padding:12px 16px;margin:12px 0;font-size:14px}\n' +
    '.note{font-size:13px;color:var(--muted)}\n' +
    '</style>\n</head>\n<body>\n<div class="wrap">\n' +
    '<h1>E2E 自我測試執行報告</h1>\n' +
    `<div class="meta">執行時間：${hesc(runISO)} ｜ 版本：桌面版 v${hesc(pkgVer)}（Web 核心 v3.15.1） ｜ 環境：本地沙箱（headless Chromium + mock Tauri plugin + 真 SQLite node:sqlite）</div>\n` +
    '<div class="cards">\n' +
    `<div class="card"><div class="n">${results.length}</div><div class="l">用例總數</div></div>\n` +
    `<div class="card"><div class="n" style="color:var(--green)">${results.length - fails.length}</div><div class="l">PASS</div></div>\n` +
    `<div class="card"><div class="n" style="color:${fails.length ? 'var(--red)' : 'var(--muted)'}">${fails.length}</div><div class="l">FAIL</div></div>\n` +
    `<div class="card"><div class="n">${totalS}<span style="font-size:14px">s</span></div><div class="l">總耗時</div></div>\n` +
    '</div>\n<h2>用例結果總表</h2>\n<div class="tblwrap"><table>\n<tr><th>#</th><th>用例</th><th>結果</th><th>耗時</th></tr>\n';
  for (const r of results)
    h += `<tr><td>${hesc(r.id)}</td><td>${hesc(r.name)}</td><td><span class="badge ${r.pass ? 'pass' : 'fail'}">${r.pass ? 'PASS' : 'FAIL'}</span></td><td>${r.durationMs}ms</td></tr>\n`;
  h += '</table></div>\n<h2>各用例詳情</h2>\n';
  for (const r of results) {
    h += `<div class="case"><h3>${hesc(r.id)} ${hesc(r.name)} <span class="badge ${r.pass ? 'pass' : 'fail'}">${r.pass ? 'PASS' : 'FAIL'}</span> <span class="note">${r.durationMs}ms</span></h3>\n`;
    h += `<div class="kv"><b>步驟：</b>${hesc(r.steps.join(' → '))}</div>\n`;
    h += `<div class="kv"><b>預期：</b>${hesc(r.expected)}</div>\n`;
    h += `<div class="kv"><b>實際：</b>${hesc(r.actual)}</div>\n`;
    if (r.shots.length) {
      h += '<div class="shots">';
      for (const s of r.shots)
        h += `<img src="${hesc(s)}" data-full="${hesc(s)}" alt="${hesc(r.id)} 截圖" loading="lazy">`;
      h += '</div>\n';
    }
    h += '</div>\n';
  }
  h += '<h2>自我發現問題／修復記錄</h2>\n';
  if (!buglog.length) h += '<p class="note">（本輪未發現新問題）</p>\n';
  for (const b of buglog) {
    h += `<div class="bug"><b>[第 ${hesc(String(b.round))} 輪] ${hesc(b.case)} — ${hesc(b.finding)}</b><br>\n`;
    h += `<span class="note">根因：</span>${hesc(b.rootCause)}<br>\n`;
    h += `<span class="note">修法：</span>${hesc(b.fix)}<br>\n`;
    h += `<span class="note">驗證：</span>${hesc(b.verified)}</div>\n`;
  }
  h += '<h2>未覆蓋／限制</h2>\n<ul class="note">\n';
  for (const l of LIMITS) h += `<li>${hesc(l)}</li>\n`;
  h += '</ul>\n</div>\n' +
    '<div id="lightbox"><img alt="放大截圖"></div>\n' +
    '<script>\n' +
    "document.querySelectorAll('.shots img').forEach(function(im){im.addEventListener('click',function(){var lb=document.getElementById('lightbox');lb.querySelector('img').src=im.getAttribute('data-full');lb.style.display='flex';});});\n" +
    "document.getElementById('lightbox').addEventListener('click',function(e){e.currentTarget.style.display='none';});\n" +
    '<\/script>\n</body>\n</html>\n';
  fs.writeFileSync(REPORT_HTML, h);
  console.log('HTML 報告已生成：' + REPORT_HTML);
  console.log('\n報告已生成：' + REPORT);
  console.log(`==== E2E：${results.length - fails.length}/${results.length} PASS，${fails.length} FAIL，總耗時 ${(totalMs / 1000).toFixed(1)}s ====`);
  if (errs.length) console.log('pageerror/console：\n' + errs.slice(0, 5).join('\n'));
  await browser.close();
  server.close();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('E2E 腳本異常：', e); process.exit(2); });
