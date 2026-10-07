# AGENTS.md — Toys Gallery 會計系統 桌面版（Tauri）

> 呢份係俾 AI coding agent（Codex 等）嘅上下文知識庫：項目係咩、點 build、點測、啲鐵律。

## 項目簡介

- 香港 **Toys Gallery International Limited** 會計系統嘅桌面版。
- **Tauri 2 + SQLite**（`@tauri-apps/plugin-sql`），本地單機運行，無後端 server。
- 功能同 web 版完全一樣：Voucher 入賬（借貸自動平衡＋製表／覆核／批核三簽名）、即時過賬、General Ledger、9 份自動報表（Trial Balance、P&L、Balance Sheet、AR/AP Aging、Purchase／Sales Report、Journal、Voucher Register）、CSV／Excel 匯出。
- 當前版本：**桌面版 v3.21.2／Web 核心 v3.15.1**（badge 同時顯示兩個版本）。
- Repo：https://github.com/bwenpig/toy-legal-desktop（分支 `main`）
- Web 版 repo（邏輯來源）：https://github.com/bwenpig/hk-legal-dora

## 技術棧

| 層 | 技術 |
|---|---|
| 殼 | Tauri 2.x（Rust 側只註冊 plugin，`src-tauri/src/main.rs` 無自定義 command） |
| 數據庫 | SQLite（WAL 模式），經 `plugin-sql`；關聯式 schema v2，18 張表 |
| 前端核心 | web 版 TypeScript 編譯產物（`web-src/`，唯讀） |
| 桌面膠水層 | `src/tauri-glue.js`（DB 持久化、dialog、fs、設置畫面、Excel 匯出） |
| 資料庫層 | `src/db-layer.js`（由 `desktop/db/*.ts` 編譯；JSON ↔ 關聯表雙向轉換） |
| Excel | `xlsx`（SheetJS）：Voucher 批量匯入／匯出、報表 xlsx 美化 |
| 金額 | 一律整數「分」（cents），同 web v3.15.1 一致 |

## 目錄結構

```
mcp-server/           MCP Server（Node.js）：Codex 經 MCP 唯讀查賬套；見 mcp-server/README.md
src-tauri/            Tauri 配置：tauri.conf.json、capabilities/default.json、Cargo.toml
web-src/              web 版 TS 源碼（由 hk-legal-dora/src 複製；唯讀，唔好改）
desktop/              桌面獨有 TS 源碼
  desktop-entry.ts    前端入口（掛載版本號、啟動 glue）
  desktop-shell.html  App 殼 HTML
  db/                 資料庫層（schema、migration、JSON↔關聯表轉換）
  excel-*.ts          Excel 匯入／匯出／報表美化
  shims/              瀏覽器 API 墊片
src/                  組裝後前端（build-desktop.cjs 產出；唔好手改）
  index.html / desktop-bundle.js / db-layer.js / tauri-glue.js / vendor/
scripts/
  build-desktop.cjs   組裝：web-src → esbuild → 拼 index.html（要先跑）
  smoke-desktop.cjs   自動 smoke 測試（55 項，headless Chromium + mock Tauri）
```

## 數據架構（SQLite schema v2）

18 張表：`fiscal_years`、`accounts`、`vouchers`、`voucher_lines`（FK CASCADE）、`attachments`、
`opening_balances`、`opening_invoices`、`sales_invoices`、`purchase_invoices`、`invoice_remarks`、
`allocations`、`allocation_reviews`、`reconciliation_confirmations`、`staff_names`、
`suppressed_staff_names`、`deleted_data_years`、`balance_adjustments`、`app_state`、`schema_version`。

- 金額欄一律 `INTEGER` 分；單 transaction 寫入；mutation 後 debounce 1.5 秒自動持久化。
- v1（kv_store JSON blob）→ v2 會自動 migration，**之前先備份成個 DB**。
- 讀取失敗時**暫停自動儲存**（唔可以用空數據覆蓋舊庫），等用戶用 JSON 還原。
- 附件存實體檔，DB 只記路徑。
- 數據位置可指定（`tg-config.json` 存於 AppConfig 目錄）；搬庫係複製唔刪源，失敗還原舊連接。

## Web JSON 備份 ＝ 交換標準

- web 版下載嘅 JSON 備份（schema v1／v2）係 web ↔ 桌面嘅交換格式。
- **桌面版適應 web 格式**，唔好反過來要求 web 改。
- v1（浮點美元）還原會自動轉分，並提示轉換咗幾多個欄位。

## 鐵律

1. **唔好影響 web 版**：桌面獨有改動只做呢個 repo；`web-src/` 唯讀；唔好掂公開 artifact／`hk-legal-dora`。
2. 每次改版（無論功能定純文字）：遞增桌面版本號 → `DESKTOP_CHANGELOG`（`src/tauri-glue.js`）寫明改咗咩 → smoke 全 PASS → GitHub release（tag `vX.Y.Z`＋上傳 Mac source tarball）→ 等用戶「發佈」指令先出包。
   Mac source 打包：`tar --exclude=node_modules --exclude='src-tauri/target' --exclude='*.bak' --exclude=.git -czf toys-gallery-desktop-mac-src-vX.Y.Z.tar.gz .`
   Release：`gh release create vX.Y.Z <tarball> --repo bwenpig/toy-legal-desktop`
3. 用戶原則：「有唔明白直接問，不要自己做主」——唔好估，問。

## 開發流程

```bash
# 1. 改 desktop/ 或 src/tauri-glue.js
# 2. 組裝（需 Node 18+；TG_HK_SRC 指向 web-src）
TG_HK_SRC="$PWD/web-src" TG_HK_DIST="$PWD/src/index.html" node scripts/build-desktop.cjs
# 3. 跑 smoke（55 項，約 1 分鐘）
node scripts/smoke-desktop.cjs
# 4. 升版本號（package.json、tauri.conf.json、Cargo.toml、desktop-entry.ts）+ 寫 CHANGELOG
# 5. Mac 打包：npm install && npm run build
#    產物：src-tauri/target/release/bundle/{macos,dmg}/
```

## 已知坑（唔好再踩）

- `plugin:fs|read_file` 喺**真 Tauri 回傳 `ArrayBuffer`**（唔係 `Uint8Array` 亦唔係 `Array`）；
  `Uint8Array.from(arrayBuffer)` 會靜靜出空 array。`src/tauri-glue.js` 嘅 `fsReadBytes`
  已按 `@tauri-apps/plugin-fs` 官方寫法處理（`instanceof ArrayBuffer → new Uint8Array(arr)`）。
  2026-10-07 就係呢個 bug 搞到 JSON 匯入報 "Unexpected EOF"（v3.17.2 修復，U5 回歸測試）。
- smoke 嘅 `page.exposeFunction` mock **傳唔到 ArrayBuffer**（會變 `{}`）；mock 回傳 `Array`，
  ArrayBuffer 分支由 U5 在頁內直接構造真 ArrayBuffer 測試。
- `invoke('plugin:fs|write_file', data, { headers: { path } })` 係官方寫法（binary 經 payload），唔好改。
- `plugin:path|resolve_directory` 嘅 directory 參數係 numeric enum（AppData=14），唔好傳 string。
- `plugin-sql` 嘅 path_mapper 用 `PathBuf::push`：絕對路徑會成個取代 `sqlite:` 前綴，所以 `sqlite:/abs/path.db` 開到任意位置。
- `capabilities/default.json` 嘅 fs scope：`$APPDATA/**` + `$HOME/**`；加新 fs command 記得加對應 permission。
- 未簽名 Mac 包第一次開會被 Gatekeeper 擋：右鍵 → 開啟。正式簽名要 Apple Developer 帳號。

## 功能清單（v3.17.x）

- v3.15.1 核心：關聯式 SQLite 存儲、金額整數分、自動持久化。
- v3.16.0：桌面設置（指定數據庫位置、數據表預覽、Web JSON 匯入 SQLite）。
- v3.17.0：Excel 完整支援——Voucher 批量匯入（範本＋逐行驗證＋只匯入有效行）、
  Voucher 批量匯出（總表＋明細＋附件 zip＋hyperlink）、報表 xlsx 美化（篩選／凍結窗格／列印標題）。
- v3.17.1：badge 雙版本顯示、簽名列自適應換行、工具條可收起（預設收起）。
- v3.17.2：修復 JSON 匯入讀檔 bug（ArrayBuffer 轉換）。
- v3.18.0：附件入 SQLite（data_b64），唔再寫實體檔；v2→v3 自動遷移。
- v3.19.0：MCP Server（Codex 唯讀接入：status／query／list_vouchers／get_voucher／get_attachment／account_ledger）。
- v3.20.0：設置加「附件管理」（統計／列表／匯出全部／刪舊備份）＋「MCP 服務」（一鍵複製 Codex 設定）。
- v3.21.0：MCP voucher 錄入（create_voucher 驗證後入 pending_vouchers，桌面版一鍵匯入；手寫單識別流程見 mcp-server/VOUCHER_ENTRY.md）。
- v3.21.1：修復設置深色模式文字唔可見（改用 --ink／--line 變量）。
- v3.21.2：修復 voucher 簽名列第三格爆出容器（改固定三欄 minmax(0,1fr)；手機版單欄覆蓋一併修）。（create_voucher 驗證後入 pending_vouchers，桌面版一鍵匯入；手寫單識別流程見 mcp-server/VOUCHER_ENTRY.md）。
