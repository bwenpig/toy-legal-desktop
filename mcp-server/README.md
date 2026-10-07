# Toys Gallery MCP Server

俾 Codex / Claude 等 AI agent 經 MCP（Model Context Protocol）讀取桌面版 SQLite 賬套。

## 特性

- **唯讀**：DB 以 read-only 開，唔會 lock 住 desktop app（WAL 模式可並行讀）；寫入語句會被擋。
- **金額**：一律回傳 `*_cents`（整數分）＋ `*`（dollars 字串，兩位小數），唔用浮點。
- **附件**：`list_vouchers`／`get_voucher` 淨回 metadata；要睇內容用 `get_attachment`（base64）。

## 安裝

```bash
cd mcp-server
npm install
```

## Codex 接入

`~/.codex/config.toml`：

```toml
[mcp_servers.toys-gallery]
command = "node"
args = ["/path/to/toys-gallery-desktop/mcp-server/index.js"]
# DB 路徑：唔設就自動搵（見下）
env = { TG_DB_PATH = "/path/to/toys-gallery.db" }
```

DB 路徑解析順序：`TG_DB_PATH` 環境變量 → `<AppConfig>/tg-config.json` 嘅 `dbPath` →
`<AppConfig>/toys-gallery.db` 預設（AppConfig：macOS `~/Library/Application Support/com.toysgallery.accounting/`，
Linux `~/.config/com.toysgallery.accounting/`）。

注意：MCP server 要同 DB 喺同一部機跑（讀本地 .db 檔）。

## Tools

| tool | 用途 |
|---|---|
| `status` | DB 路徑、schema 版本、各表筆數、財年列表 |
| `query` | 唯讀 SQL（SELECT/WITH/EXPLAIN/PRAGMA；擋寫入） |
| `list_vouchers` | voucher 列表（財年／月份篩選，分頁） |
| `get_voucher` | 一張 voucher 全明細＋分錄＋附件 metadata |
| `get_attachment` | 附件內容（base64） |
| `account_ledger` | 某科目明細賬 |

## 測試

```bash
node test-mcp.cjs   # 9 項：tools、讀寫、唯讀攔截
```
