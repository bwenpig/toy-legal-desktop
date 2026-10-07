#!/usr/bin/env node
/**
 * Toys Gallery 會計系統 — MCP Server（v3.19.0）
 *
 * 俾 Codex / Claude 等 AI agent 經 MCP 讀取桌面版 SQLite 賬套。
 * - 唯讀：DB 以 read-only 開，唔會 lock 住 desktop app（WAL 模式可並行讀）。
 * - 金額一律回傳 cents（整數）＋ dollars（字串，兩位小數），唔用浮點。
 * - 附件內容經 get_attachment 攞（base64），list/get 淨係回 metadata。
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
const db = new DatabaseSync(DB_PATH, { readOnly: true });

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
  { name: 'toys-gallery-accounting', version: '3.19.0' },
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
  ],
}));

function err(msg) {
  return { content: [{ type: 'text', text: '錯誤：' + msg }], isError: true };
}
function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
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
