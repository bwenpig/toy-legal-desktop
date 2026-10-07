#!/usr/bin/env node
/**
 * Toys Gallery 會計系統 — MCP Server（v3.19.0）
 *
 * 俾 Codex / Claude 等 AI agent 經 MCP 讀取桌面版 SQLite 賬套。
 * - 讀：DB 以 WAL 模式開，可同 desktop app 並行（SQLite lock 排隊寫入）。
 * - 寫：只限 pending_vouchers（待匯入）；唔掂核心賬表，唔怕同 app 衝突。
 *   app 嘅 persist 係全表重寫，直接寫 vouchers 會被覆蓋，所以 voucher 經 inbox 由用戶一鍵匯入。
 * - query tool 只接受唯讀 SQL。
 *
 * DB 路徑解析順序：
 *   1. 環境變量 TG_DB_PATH
 *   2. <AppConfig>/tg-config.json 嘅 dbPath（AppConfig = macOS ~/Library/Application Support/com.toysgallery.accounting/
 *      Linux ~/.config/com.toysgallery.accounting/）
 *   3. <AppConfig>/toys-gallery.db（預設）
 *
 * Codex 接入（~/.codex/config.toml）：
 *   [mcp_servers.toys-gallery]
 *   command = "node"
 *   args = ["/path/to/toys-gallery-desktop/mcp-server/index.js"]
 *   env = { TG_DB_PATH = "/path/to/toys-gallery.db" }
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP_ID = 'com.toysgallery.accounting';

function appConfigDir() {
  const home = os.homedir();
  if (process.platform === 'darwin')
    return path.join(home, 'Library', 'Application Support', APP_ID);
  if (process.platform === 'win32')
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP_ID);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), APP_ID);
}

function resolveDbPath() {
  if (process.env.TG_DB_PATH) return process.env.TG_DB_PATH;
  const cfg = path.join(appConfigDir(), 'tg-config.json');
  try {
    const j = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    if (j && j.dbPath) return j.dbPath;
  } catch { /* 用預設 */ }
  return path.join(appConfigDir(), 'toys-gallery.db');
}

const DB_PATH = resolveDbPath();
if (!fs.existsSync(DB_PATH)) {
  console.error(`[mcp] 找不到數據庫：${DB_PATH}（可用 TG_DB_PATH 指定）`);
  process.exit(1);
}
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

/** 分 → "1234.56" 字串（唔用浮點） */
function centsStr(c) {
  const n = Number(c) || 0;
  const neg = n < 0;
  const a = Math.abs(Math.round(n));
  return (neg ? '-' : '') + Math.floor(a / 100) + '.' + String(a % 100).padStart(2, '0');
}
const q = (sql, params = []) => db.prepare(sql).all(...params);
const one = (sql, params = []) => db.prepare(sql).get(...params);

function tableCounts() {
  const out = {};
  for (const r of q(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)) {
    try { out[r.name] = one(`SELECT COUNT(*) AS c FROM "${r.name}"`).c; }
    catch { out[r.name] = null; }
  }
  return out;
}

const server = new Server(
  { name: 'toys-gallery-accounting', version: '3.21.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'status',
      description: '賬套狀態：DB 路徑、schema 版本、各表筆數、財年列表、版本號',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'query',
      description: '唯讀 SQL 查詢（只接受 SELECT/WITH/EXPLAIN/PRAGMA 開頭；唔做得寫入）。金額欄係整數分。',
      inputSchema: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'SQL（唯讀）' },
          params: { type: 'array', description: '參數', items: {} },
        },
        required: ['sql'],
      },
    },
    {
      name: 'list_vouchers',
      description: '列出 voucher（按財年／月份篩選，分頁）',
      inputSchema: {
        type: 'object',
        properties: {
          fiscal_year: { type: 'string', description: '財年 key，如 2023（即 FY2023/24）' },
          month: { type: 'string', description: '月份 YYYY-MM，如 2023-09' },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
    {
      name: 'get_voucher',
      description: '取一張 voucher 全明細：表頭、分錄（含借貸金額）、附件 metadata',
      inputSchema: {
        type: 'object',
        properties: { no: { type: 'string', description: 'Voucher No.，如 B091423' } },
        required: ['no'],
      },
    },
    {
      name: 'get_attachment',
      description: '取附件內容（base64）。list/get 淨回 metadata，要睇內容用呢個。',
      inputSchema: {
        type: 'object',
        properties: {
          voucher_no: { type: 'string' },
          seq: { type: 'number', description: '附件順序（預設 0）', default: 0 },
        },
        required: ['voucher_no'],
      },
    },
    {
      name: 'account_ledger',
      description: '某科目嘅明細賬（按日期；金額回 cents＋dollars 字串）',
      inputSchema: {
        type: 'object',
        properties: {
          account: { type: 'string', description: '科目名，如 Bank Saving Account' },
          fiscal_year: { type: 'string' },
          limit: { type: 'number', default: 200 },
        },
        required: ['account'],
      },
    },
    {
      name: 'create_voucher',
      description: '新增 voucher（手寫單相片經 AI 識別後用呢個入賬）。先驗證（借貸平衡、科目存在、日期有效），通過後放入 pending_vouchers 待用戶喺桌面版一鍵匯入。唔會直接寫賬套，唔怕同桌面版衝突。',
      inputSchema: {
        type: 'object',
        properties: {
          voucher: {
            type: 'object',
            description: 'voucher 資料',
            properties: {
              date: { type: 'string', description: '日期 YYYY-MM-DD' },
              type: { type: 'string', description: 'B=銀行 / T=轉賬', enum: ['B', 'T'] },
              desc: { type: 'string', description: '摘要' },
              voucher_no: { type: 'string', description: '自選編號（唔填匯入時自動編 B040124 格式）' },
              made_by: { type: 'string' },
              checked_by: { type: 'string' },
              approved_by: { type: 'string' },
              lines: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    account: { type: 'string' },
                    debit_cents: { type: 'integer', description: '借方金額（分，整數）' },
                    credit_cents: { type: 'integer', description: '貸方金額（分，整數）' },
                    debit: { type: 'string', description: '借方金額（美元字串，如 "1234.56"；同 debit_cents 二揀一）' },
                    credit: { type: 'string', description: '貸方金額（美元字串）' },
                    detail: { type: 'string', description: '明細' },
                  },
                  required: ['account'],
                },
              },
              attachments: {
                type: 'array',
                description: '附件（通常係手寫單相片）',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    mime: { type: 'string' },
                    data_base64: { type: 'string' },
                  },
                  required: ['name', 'data_base64'],
                },
              },
            },
            required: ['date', 'type', 'desc', 'lines'],
          },
          note: { type: 'string', description: '備註（如識別信心、用戶確認記錄）' },
        },
        required: ['voucher'],
      },
    },
    {
      name: 'list_pending_vouchers',
      description: '列出待匯入 voucher（status=pending／全部）',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'imported', 'rejected'], description: '唔填=pending' },
        },
      },
    },
    {
      name: 'get_pending_voucher',
      description: '取一張待匯入 voucher 明細',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'number' } },
        required: ['id'],
      },
    },
    {
      name: 'reject_pending_voucher',
      description: '駁回一張待匯入 voucher（用戶唔要）',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'number' } },
        required: ['id'],
      },
    },
  ],
}));

function err(msg) {
  return { content: [{ type: 'text', text: '錯誤：' + msg }], isError: true };
}
function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/** "1234.56" → 125434 分（half-up；唔用浮點） */
function dollarsToCents(s) {
  const m = String(s).trim().match(/^(\d+)(?:\.(\d{1,3}))?$/);
  if (!m) throw new Error('金額格式唔啱：' + s);
  let cents = parseInt(m[1], 10) * 100;
  const dec = (m[2] || '').padEnd(3, '0');
  cents += Math.floor(parseInt(dec, 10) / 10) + (parseInt(dec, 10) % 10 >= 5 ? 1 : 0);
  return cents;
}
function parseLineAmount(line, side) {
  const cKey = side + '_cents', dKey = side;
  if (line[cKey] != null && line[cKey] !== '') {
    const n = Number(line[cKey]);
    if (!Number.isInteger(n) || n < 0) throw new Error('金額分必須係非負整數：' + line[cKey]);
    return n;
  }
  if (line[dKey] != null && line[dKey] !== '') return dollarsToCents(line[dKey]);
  return 0;
}
/** 驗證 voucher，ok 回正規化 payload，唔 ok throw */
function validateVoucherInput(v) {
  if (!v || typeof v !== 'object') throw new Error('voucher 唔係物件');
  const date = String(v.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date + 'T00:00:00Z').getTime()))
    throw new Error('日期唔啱（要 YYYY-MM-DD）：' + v.date);
  const type = String(v.type || '').toUpperCase();
  if (type !== 'B' && type !== 'T') throw new Error('類型要 B 或 T：' + v.type);
  const desc = String(v.desc || '').trim();
  if (!desc) throw new Error('摘要唔可以空');
  const lines = v.lines;
  if (!Array.isArray(lines) || !lines.length) throw new Error('至少要一行分錄');
  let dr = 0, cr = 0;
  const normLines = lines.map((l, i) => {
    const account = String(l.account || '').trim();
    if (!account) throw new Error(`第 ${i + 1} 行：科目唔可以空`);
    const exists = one('SELECT 1 FROM accounts WHERE name = ? LIMIT 1', [account]);
    if (!exists) throw new Error(`第 ${i + 1} 行：科目唔存在「${account}」`);
    const debit_cents = parseLineAmount(l, 'debit');
    const credit_cents = parseLineAmount(l, 'credit');
    if (debit_cents > 0 && credit_cents > 0)
      throw new Error(`第 ${i + 1} 行：借貸唔可以同時有數`);
    dr += debit_cents; cr += credit_cents;
    return { account, debit_cents, credit_cents, detail: String(l.detail || '') };
  });
  if (dr !== cr) throw new Error(`借貸不平：借 ${centsStr(dr)} vs 貸 ${centsStr(cr)}`);
  if (dr <= 0) throw new Error('金額要大過 0');
  let voucher_no = null;
  if (v.voucher_no != null && String(v.voucher_no).trim() !== '') {
    voucher_no = String(v.voucher_no).trim();
    const dup = one('SELECT 1 FROM vouchers WHERE no = ? LIMIT 1', [voucher_no]) ||
      one("SELECT 1 FROM pending_vouchers WHERE voucher_no = ? AND status='pending' LIMIT 1", [voucher_no]);
    if (dup) throw new Error('Voucher No. 已存在：' + voucher_no);
  }
  const atts = [];
  for (const a of v.attachments || []) {
    const b64 = String(a.data_base64 || '').replace(/\s+/g, '');
    if (!b64) throw new Error('附件 ' + a.name + ' 無內容');
    if (!/^[A-Za-z0-9+/=]+$/.test(b64)) throw new Error('附件 ' + a.name + ' 唔係有效 base64');
    atts.push({ name: String(a.name || 'attachment'), mime: String(a.mime || 'application/octet-stream'), dataB64: b64 });
  }
  return {
    date, type, desc, voucher_no,
    madeBy: String(v.made_by || ''), checkedBy: String(v.checked_by || ''), approvedBy: String(v.approved_by || ''),
    lines: normLines, attachments: atts,
  };
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a = {} } = req.params;
  try {
    switch (name) {
      case 'status': {
        const ver = one('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1');
        return ok({
          db_path: DB_PATH,
          schema_version: ver ? ver.version : null,
          tables: tableCounts(),
          fiscal_years: q('SELECT key, label, "from" AS from_date, "to" AS to_date FROM fiscal_years ORDER BY key'),
          note: '金額一律整數分（cents）；1 美元 = 100 分',
        });
      }
      case 'query': {
        const sql = String(a.sql || '').trim();
        if (!/^(select|with|explain|pragma)\b/i.test(sql))
          return err('只接受唯讀查詢（SELECT/WITH/EXPLAIN/PRAGMA 開頭）');
        if (/;\s*(insert|update|delete|drop|alter|create|replace|attach|detach)\b/i.test(sql))
          return err('唔接受寫入語句');
        const rows = q(sql, Array.isArray(a.params) ? a.params : []);
        return ok({ rows: rows.slice(0, 1000), truncated: rows.length > 1000 });
      }
      case 'list_vouchers': {
        const cond = [], params = [];
        if (a.fiscal_year) { cond.push('v.fiscal_key = ?'); params.push(String(a.fiscal_year)); }
        if (a.month) { cond.push("substr(v.date,1,7) = ?"); params.push(String(a.month)); }
        const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
        const limit = Math.min(Math.max(Number(a.limit) || 50, 1), 500);
        const offset = Math.max(Number(a.offset) || 0, 0);
        const rows = q(
          `SELECT v.no, v.date, v.type, v.description,
                  COALESCE((SELECT SUM(debit_cents) FROM voucher_lines l WHERE l.voucher_no=v.no),0) AS dr,
                  COALESCE((SELECT SUM(credit_cents) FROM voucher_lines l WHERE l.voucher_no=v.no),0) AS cr,
                  (SELECT COUNT(*) FROM attachments t WHERE t.voucher_no=v.no) AS att_n
           FROM vouchers v ${where} ORDER BY v.date, v.no LIMIT ? OFFSET ?`,
          [...params, limit, offset]);
        return ok(rows.map((r) => ({
          no: r.no, date: r.date, type: r.type, description: r.description,
          debit_cents: r.dr, debit: centsStr(r.dr),
          credit_cents: r.cr, credit: centsStr(r.cr),
          attachments: r.att_n,
        })));
      }
      case 'get_voucher': {
        const v = one('SELECT * FROM vouchers WHERE no = ?', [String(a.no)]);
        if (!v) return err('搵唔到 voucher ' + a.no);
        const lines = q(
          'SELECT line_index, account, debit_cents, credit_cents, detail FROM voucher_lines WHERE voucher_no=? ORDER BY line_index',
          [v.no]);
        const atts = q(
          'SELECT seq, name, mime, length(data_b64) AS b64_len FROM attachments WHERE voucher_no=? ORDER BY seq',
          [v.no]);
        return ok({
          no: v.no, type: v.type, date: v.date, description: v.description,
          made_by: v.made_by, checked_by: v.checked_by, approved_by: v.approved_by,
          allocation_invoice: v.allocation_invoice || null,
          lines: lines.map((l) => ({
            account: l.account, detail: l.detail,
            debit_cents: l.debit_cents, debit: centsStr(l.debit_cents),
            credit_cents: l.credit_cents, credit: centsStr(l.credit_cents),
          })),
          attachments: atts.map((t) => ({
            seq: t.seq, name: t.name, mime: t.mime,
            size_bytes: t.b64_len == null ? null : Math.floor(t.b64_len * 3 / 4),
          })),
        });
      }
      case 'get_attachment': {
        const r = one(
          'SELECT name, mime, data_b64 FROM attachments WHERE voucher_no=? AND seq=?',
          [String(a.voucher_no), Number(a.seq) || 0]);
        if (!r) return err('搵唔到附件');
        if (!r.data_b64) return err('附件無內容（舊 v2 檔制未遷移）');
        return ok({
          name: r.name, mime: r.mime,
          size_bytes: Math.floor(r.data_b64.length * 3 / 4),
          content_base64: r.data_b64,
        });
      }
      case 'account_ledger': {
        const cond = ['l.account = ?'], params = [String(a.account)];
        if (a.fiscal_year) { cond.push('v.fiscal_key = ?'); params.push(String(a.fiscal_year)); }
        const limit = Math.min(Math.max(Number(a.limit) || 200, 1), 2000);
        const rows = q(
          `SELECT v.date, v.no, l.detail, l.debit_cents, l.credit_cents
           FROM voucher_lines l JOIN vouchers v ON v.no=l.voucher_no
           WHERE ${cond.join(' AND ')} ORDER BY v.date, v.no LIMIT ?`,
          [...params, limit]);
        let dr = 0, cr = 0;
        const entries = rows.map((r) => {
          dr += r.debit_cents; cr += r.credit_cents;
          return {
            date: r.date, voucher_no: r.no, detail: r.detail,
            debit_cents: r.debit_cents, debit: centsStr(r.debit_cents),
            credit_cents: r.credit_cents, credit: centsStr(r.credit_cents),
          };
        });
        return ok({
          account: a.account, entries,
          total_debit_cents: dr, total_debit: centsStr(dr),
          total_credit_cents: cr, total_credit: centsStr(cr),
        });
      }
      case 'create_voucher': {
        const norm = validateVoucherInput(a.voucher);
        const payload = {
          date: norm.date, type: norm.type, desc: norm.desc,
          madeBy: norm.madeBy, checkedBy: norm.checkedBy, approvedBy: norm.approvedBy,
          lines: norm.lines, attachments: norm.attachments,
        };
        const r = db.prepare(
          "INSERT INTO pending_vouchers(source, status, voucher_no, payload_json, note) VALUES ('mcp','pending',?,?,?)"
        ).run(norm.voucher_no, JSON.stringify(payload), a.note != null ? String(a.note) : null);
        return ok({
          pending_id: Number(r.lastInsertRowid),
          voucher_no: norm.voucher_no || '(匯入時自動編號)',
          status: 'pending',
          lines: norm.lines.length,
          total: centsStr(norm.lines.reduce((s, l) => s + l.debit_cents, 0)),
          next: '用戶喺桌面版「設置 → 待匯入 Voucher」一鍵匯入',
        });
      }
      case 'list_pending_vouchers': {
        const st = a.status || 'pending';
        const rows = q(
          'SELECT id, created_at, source, status, voucher_no, note, payload_json FROM pending_vouchers WHERE status=? ORDER BY id',
          [st]);
        return ok(rows.map((r) => {
          let desc = '', date = '';
          try { const p = JSON.parse(r.payload_json); desc = p.desc; date = p.date; } catch {}
          return { id: r.id, created_at: r.created_at, source: r.source, status: r.status, voucher_no: r.voucher_no, date, desc, note: r.note };
        }));
      }
      case 'get_pending_voucher': {
        const r = one('SELECT * FROM pending_vouchers WHERE id=?', [Number(a.id)]);
        if (!r) return err('搵唔到 pending voucher id=' + a.id);
        const p = JSON.parse(r.payload_json);
        p.attachments = (p.attachments || []).map((t) => ({
          name: t.name, mime: t.mime,
          size_bytes: t.dataB64 ? Math.floor(t.dataB64.length * 3 / 4) : 0,
          has_content: !!t.dataB64,
        }));
        return ok({ id: r.id, created_at: r.created_at, source: r.source, status: r.status, voucher_no: r.voucher_no, note: r.note, voucher: p });
      }
      case 'reject_pending_voucher': {
        const r = db.prepare("UPDATE pending_vouchers SET status='rejected' WHERE id=? AND status='pending'").run(Number(a.id));
        if (!r.changes) return err('搵唔到待匯入 id=' + a.id + '（可能已匯入／已駁回）');
        return ok({ id: Number(a.id), status: 'rejected' });
      }
      default:
        return err('未知 tool：' + name);
    }
  } catch (e) {
    return err(e.message || String(e));
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[mcp] toys-gallery-accounting 已啟動，DB：${DB_PATH}`);
