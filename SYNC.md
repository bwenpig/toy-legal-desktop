# SYNC.md — Web 更新 → 桌面版同步 → VPS 發佈流程（草稿）

> 原則（用戶拍板）：web 版保持主線，先更新 web、驗收通過，再同步到桌面版。
> 架構方向：SQLite 做 single source of truth；API service（FastAPI＋SQLite，先喺雲電腦 `~/workspace/toys-gallery-api/`，驗好搬去 CentOS VPS）；桌面版 local SQLite 保留做離線模式。

## 1. Web 主線（不變）

1. 改 web 版 → 獨立 agent 驗收（source＋Node 執行）→ 用戶話發佈先發佈
2. Web 版而家係 v3.5（memory-only＋JSON 備份／還原；平台禁止 browser storage；
   期初發票明細可暫存＋「待完成」標記；AR/AP 中文為「應收賬款／應付賬款」）

## 2. 同步前端到桌面版（v3.5.0 實際做法）

> **重要更正（2026-10-05）**：原計劃假設前端有 StorageAdapter 抽象層，
> 但平台拒絕咗嗰個重構——實際嘅 v3.5 前端係純 memory-only 單文件 IIFE，
> 無 adapter。以下係實際採用嘅方案。

**核心思路**：唔重構 app 內部，用 web 版現有兩個抓手做持久化出入口：
- 出口：`createBackupPayload()`（async，全賬套序列化做 JSON，附件轉 data URL）
- 入口：`validateBackup()`（sync）＋`prepareRestore()`（**async**）＋
  `applyPreparedRestore()`（sync）

> ⚠️ **async 陷阱（2026-10-05 實測發現）**：`prepareRestore`、`beginRestore`、
> `createBackupPayload` 全部係 async function——`prepareRestore` 唔 await
> 會攞到 Promise 而唔係 prepared 物件，`renderRestoreModal` 會喺
> `prepared.vouchers.length` 炒車。glue 入面所有 call 位都要 `await`：
> 開機還原（`await TG.prepareRestore(payload)`）、JSON 匯入
> （`await TG.beginRestore(payload, name)`）、自動儲存
> （`await TG.createBackupPayload()`）。已喺 JSDOM＋真 SheetJS 驗證晒。

> ⚠️ **BaseDirectory 係 numeric enum（2026-10-05 實測發現）**：
> `plugin:path|resolve_directory` 嘅 `directory` 參數要傳數字（`AppData=14`），
> 傳 string `"AppData"` 會喺 Rust 側 deserialize 失敗、invoke 直接 throw。
> 呢個 bug 令 `extractAttachments()` 入面嘅 `appDataDir()` 炒車，
> `persistNow()` 成條寫庫路徑靜靜失敗（try/catch 食咗）。
> 修復後 SQLite 讀寫已喺真機驗證通過。

> ⚠️ **空白賬套唔寫庫（2026-10-05 實測發現）**：app 自身 `validateBackup`
> 要求 `accounts` 至少有一個科目——0 科目嘅空白 state 存咗落庫，
> reload 嗰陣 `prepareRestore` 會 reject「備份內的科目表不完整」。
> 所以 `persistNow()` 喺 `accounts.length===0` 時跳過寫入
> （`blankStart()` 係 deterministic，reload 重做一次就得，唔會唔見數據）；
> 還原失敗嗰陣 fallback `TG.blankStart()`，唔好卡死喺 login 畫面。

**做法**（全部喺 desktop copy `src/index.html`，原檔 `~/workspace/ts-spaces/space-2/` 永不改動）：
1. 複製 v3.5 `index.html` → `src/index.html`。
2. Surgical edits（只加，唔改邏輯）：
   - `exportCSV()` 抽出 `buildReportRows(key)`（Excel 匯出 reuse；行為不變）。
   - IIFE 尾部加 `window.__TG__` 暴露：`createBackupPayload`、`validateBackup`、
     `prepareRestore`、`applyPreparedRestore`、`buildReportRows`、
     `reportHTML(key)`（切 report＋`reportBody()` 取 HTML）、
     `blankStart()`（清 demo state＋重繪）、`beginRestore(payload,fileName)`
     （app 原有雙重確認 modal）、`importExcelData({accounts,opening})`、
     `fiscalLabel()`。
3. 新增 `src/tauri-glue.js`（classic script，喺 app script 之後載入）：
   - 偵測 `window.__TAURI_INTERNALS__`（非 Tauri 環境自動跳過，當 web 版跑）。
   - 經 `plugin-sql` raw invoke（`plugin:sql|load|execute|select`）讀寫
     `kv_store`（key=`app_state`，JSON），`schema_version` 做將來 migration。
   - 啟動：有存檔 → 附件路徑還原做 data URL → `prepareRestore`＋
     `applyPreparedRestore`；無存檔 → `blankStart()`（唔載 demo 數據）。
   - 自動儲存：監聽 document 級 `click/change/input/submit` → debounce 1.5s →
     `createBackupPayload()` → 附件 data URL 抽出存
     `<appData>/attachments/<voucherNo>/<檔名>`（payload 改記 `supportingPath`）
     → 內容 hash 無變化則跳過寫入。
   - 桌面按鈕（注入 `.backup-tools` 欄）：匯入 JSON 備份（dialog 揀檔→
     `validateBackup`→`beginRestore` 雙重確認）、匯出 Excel 報表、
     下載匯入範本、匯入 Excel。
4. Excel（`src/vendor/xlsx.full.min.js`，npm SheetJS 本地 bundle，離線可用）：
   - 匯出：9 sheets；trial/ar/ap/purchase/sales/journal/register 用
     `buildReportRows(key)`；**pl/bs 用 `reportHTML()` 取 app 自己 render 嘅
     table 轉 AOA**（零邏輯重複，數字同畫面一致）；標題列＋欄寬＋數字格式。
   - 匯入：範本 3 sheets（說明／科目表／期初數）；科目表只新增唔存在的編號；
     期初數要求財年＋科目名存在，否則跳過並報告。
5. 版本號三處對齊：`tauri.conf.json`／`package.json`／`Cargo.toml`（如 web v3.5 → desktop 3.5.0）。

## 3. Build

| 環境 | 用途 | 做法 |
|---|---|---|
| Linux 雲電腦 | 驗 compile＋WebKitGTK 渲染＋SQLite adapter 邏輯 | `npx tauri build`（bundle 出 .deb/.AppImage，只作驗證） |
| GitHub Actions `macos-latest` | 出正式 Mac 版 | `tauri-action`：build（aarch64＋x86_64）→ Developer ID 簽名 → notarization |

簽名材料（GitHub Secrets）：Developer ID Application certificate、notarization 用嘅 Apple ID＋app-specific password、updater 私鑰（公鑰放 `tauri.conf.json` `plugins.updater.pubkey`，而家係佔位符）。

## 4. 經 VPS 發佈更新

`tauri build` 會產出（`src-tauri/target/release/bundle/macos/`）：
- `Toys Gallery 會計系統.app.tar.gz`（updater 用嘅更新包）
- `Toys Gallery 會計系統.app.tar.gz.sig`（簽名）
- `latest.json`（版本資訊＋更新說明；tauri-action 可自動生成）

CI 最後一步 `scp` 上 VPS：`https://update.<domain>/latest.json`（同目錄擺埋 .tar.gz＋.sig）。
VPS 側：nginx static 站＋Let's Encrypt（HTTPS 必須，updater 唔收 http）。

## 5. 客戶端更新體驗

1. 開 app → updater 問 `latest.json` → 有新版彈提示（顯示更新說明，唔靜默）
2. 用戶撳確認 → **先自動備份** `toys-gallery.db`（→ `backups/`，見 SCHEMA.md §6）→ 下載安裝
3. 出事回滾：保留上一個版本 .app；還原備份 .db 檔
4. 更新頻率：跟 web 版火車時刻表（例如每週五），唔好碎片式推送

## 6. 將來：API sync mode（API service 起好之後）

- 桌面版加 `SyncEngine`：online 時將 local SQLite 變更 push 去 FastAPI，啟動時 pull 最新 state；offline 照用 local（離線模式）。
- 衝突策略：以 server 時間戳為準，local 改動 queue 住等連線後補 push；會計數據唔做自動 merge，有衝突彈提示人手揀。
- SYNC 流程到時加多步：「API schema／endpoint 對齊檢查」（桌面版用嘅 key 同 API 一致）。
- 數據放用戶 VPS 嘅信任問題，用戶會同客戶講清楚先行。

## 7. Checklist（每次同步）

- [ ] web 版驗收 PASS＋已發佈
- [ ] index.html 已複製到 `src/`，版本號三處對齊
- [ ] Linux `tauri build` 通過（含佔位前端換真前端後嘅 smoke test）
- [ ] updater `pubkey` 已換真公鑰（唔再係佔位符）
- [ ] updater endpoint 已換真 URL（唔再係 `update.example.com`）
- [ ] Mac CI build＋簽名＋notarization 通過
- [ ] artifacts 已上 VPS，`latest.json` 可公開讀到
- [ ] 客戶 UAT 通過先當完成
