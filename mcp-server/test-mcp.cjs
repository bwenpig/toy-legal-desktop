/* MCP server 測試：起 test DB → 經 stdio 調 tools → 驗回傳 */
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-'));
const DB = path.join(WORK, 'test.db');

function setupDb() {
  const db = new DatabaseSync(DB);
  db.exec(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
    INSERT INTO schema_version VALUES (3);
    CREATE TABLE fiscal_years (key TEXT PRIMARY KEY, label TEXT, "from" TEXT, "to" TEXT);
    INSERT INTO fiscal_years VALUES ('2023','FY2023/24','2023-04-01','2024-03-31');
    CREATE TABLE vouchers (no TEXT PRIMARY KEY, type TEXT NOT NULL, date TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', made_by TEXT NOT NULL DEFAULT '',
      checked_by TEXT NOT NULL DEFAULT '', approved_by TEXT NOT NULL DEFAULT '',
      allocation_invoice TEXT NOT NULL DEFAULT '', fiscal_key TEXT);
    CREATE TABLE voucher_lines (voucher_no TEXT NOT NULL REFERENCES vouchers(no) ON DELETE CASCADE,
      line_index INTEGER NOT NULL, account TEXT NOT NULL,
      debit_cents INTEGER NOT NULL, credit_cents INTEGER NOT NULL, detail TEXT NOT NULL DEFAULT '');
    CREATE TABLE attachments (id INTEGER PRIMARY KEY AUTOINCREMENT, voucher_no TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL, mime TEXT NOT NULL, path TEXT, data_b64 TEXT);
    CREATE TABLE accounts (code TEXT, name TEXT PRIMARY KEY, type TEXT);
    INSERT INTO accounts VALUES ('1000','Bank Saving Account','資產'),('4000','Sales','收入');
    CREATE TABLE pending_vouchers (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      source TEXT NOT NULL DEFAULT 'mcp', status TEXT NOT NULL DEFAULT 'pending', voucher_no TEXT,
      payload_json TEXT NOT NULL, note TEXT);
    INSERT INTO vouchers VALUES ('B091423','B','2023-09-22','MCP 測試單','A','B','C','', '2023');
    INSERT INTO voucher_lines VALUES ('B091423',0,'Bank Saving Account',142800,0,''),
      ('B091423',1,'Sales',0,142800,'');
    INSERT INTO attachments(voucher_no,seq,name,mime,data_b64) VALUES
      ('B091423',0,'r.txt','text/plain','aGVsbG8=');
  `);
  db.close();
}

let seq = 0;
function rpc(proc, method, params) {
  return new Promise((resolve, reject) => {
    seq++;
    const id = seq;
    let buf = '';
    const onData = (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) { proc.stdout.off('data', onData); resolve(msg); }
        } catch {}
      }
    };
    proc.stdout.on('data', onData);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => reject(new Error('timeout ' + method)), 8000);
  });
}

let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + '  — ' + (info || '')); }
}

(async () => {
  setupDb();
  const proc = spawn('node', [path.join(__dirname, 'index.js')], {
    env: { ...process.env, TG_DB_PATH: DB },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => { /* console.error('[srv]', d.toString().trim()); */ });
  await new Promise((r) => setTimeout(r, 800));

  await rpc(proc, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  const tools = await rpc(proc, 'tools/list', {});
  const names = (tools.result.tools || []).map((t) => t.name);
  check('M1 tools/list 有 10 個 tools', names.length === 10, names.join(','));

  const st = await rpc(proc, 'tools/call', { name: 'status', arguments: {} });
  const stData = JSON.parse(st.result.content[0].text);
  check('M2 status 回傳正確', stData.schema_version === 3 && stData.tables.vouchers === 1, JSON.stringify(stData.tables));

  const lv = await rpc(proc, 'tools/call', { name: 'list_vouchers', arguments: { fiscal_year: '2023' } });
  const lvData = JSON.parse(lv.result.content[0].text);
  check('M3 list_vouchers', lvData.length === 1 && lvData[0].debit === '1428.00' && lvData[0].attachments === 1, JSON.stringify(lvData[0]));

  const gv = await rpc(proc, 'tools/call', { name: 'get_voucher', arguments: { no: 'B091423' } });
  const gvData = JSON.parse(gv.result.content[0].text);
  check('M4 get_voucher 明細', gvData.lines.length === 2 && gvData.lines[0].debit_cents === 142800, gvData.no);

  const ga = await rpc(proc, 'tools/call', { name: 'get_attachment', arguments: { voucher_no: 'B091423', seq: 0 } });
  const gaData = JSON.parse(ga.result.content[0].text);
  check('M5 get_attachment base64', gaData.content_base64 === 'aGVsbG8=' && gaData.size_bytes === 6, gaData.name);

  const al = await rpc(proc, 'tools/call', { name: 'account_ledger', arguments: { account: 'Bank Saving Account' } });
  const alData = JSON.parse(al.result.content[0].text);
  check('M6 account_ledger', alData.total_debit === '1428.00' && alData.entries.length === 1, alData.total_debit);

  const qq = await rpc(proc, 'tools/call', { name: 'query', arguments: { sql: 'SELECT no FROM vouchers' } });
  check('M7 query 唯讀通過', JSON.parse(qq.result.content[0].text).rows.length === 1, '');

  const qb = await rpc(proc, 'tools/call', { name: 'query', arguments: { sql: 'DELETE FROM vouchers' } });
  check('M8 query 擋寫入', qb.result.isError === true, '');

  const q2 = await rpc(proc, 'tools/call', { name: 'query', arguments: { sql: 'SELECT * FROM vouchers; DROP TABLE vouchers' } });
  check('M9 query 擋多語句寫入', q2.result.isError === true, '');

  // M10-M14 voucher 錄入
  const goodVoucher = {
    date: '2026-10-07', type: 'B', desc: 'MCP 入賬測試',
    made_by: 'T', checked_by: 'T', approved_by: 'T',
    lines: [
      { account: 'Bank Saving Account', debit: '1428.00', detail: 'test' },
      { account: 'Sales', credit_cents: 142800 },
    ],
    attachments: [{ name: 'hand.jpg', mime: 'image/jpeg', data_base64: 'aGVsbG8=' }],
  };
  const cv = await rpc(proc, 'tools/call', { name: 'create_voucher', arguments: { voucher: goodVoucher, note: 'test' } });
  const cvData = JSON.parse(cv.result.content[0].text);
  check('M10 create_voucher 正常', cvData.pending_id === 1 && cvData.total === '1428.00', JSON.stringify(cvData).slice(0, 100));

  const badBal = await rpc(proc, 'tools/call', { name: 'create_voucher', arguments: { voucher: {
    ...goodVoucher, lines: [{ account: 'Bank Saving Account', debit: '100.00' }, { account: 'Sales', credit: '99.00' }] } } });
  check('M11 借貸不平被擋', badBal.result.isError === true, '');

  const badAcc = await rpc(proc, 'tools/call', { name: 'create_voucher', arguments: { voucher: {
    ...goodVoucher, lines: [{ account: '唔存在科目', debit: '100.00' }, { account: 'Sales', credit: '100.00' }] } } });
  check('M12 唔存在科目被擋', badAcc.result.isError === true, '');

  const lp = await rpc(proc, 'tools/call', { name: 'list_pending_vouchers', arguments: {} });
  const lpData = JSON.parse(lp.result.content[0].text);
  check('M13 list_pending', lpData.length === 1 && lpData[0].desc === 'MCP 入賬測試', JSON.stringify(lpData[0]));

  const gp = await rpc(proc, 'tools/call', { name: 'get_pending_voucher', arguments: { id: 1 } });
  const gpData = JSON.parse(gp.result.content[0].text);
  check('M14 get_pending 明細', gpData.voucher.lines.length === 2 && gpData.voucher.attachments[0].has_content === true, '');

  const rj = await rpc(proc, 'tools/call', { name: 'reject_pending_voucher', arguments: { id: 1 } });
  check('M15 reject', JSON.parse(rj.result.content[0].text).status === 'rejected', '');
  const lp2 = await rpc(proc, 'tools/call', { name: 'list_pending_vouchers', arguments: {} });
  check('M16 reject 後唔再係 pending', JSON.parse(lp2.result.content[0].text).length === 0, '');

  proc.kill();
  console.log(`==== ${pass}/${pass + fail} PASS ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
