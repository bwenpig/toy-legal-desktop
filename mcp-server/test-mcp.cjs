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
  check('M1 tools/list 有 6 個 tools', names.length === 6, names.join(','));

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

  proc.kill();
  console.log(`==== ${pass}/${pass + fail} PASS ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
