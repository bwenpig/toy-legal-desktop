# SYNC-v3151.md — 桌面版同步 web v3.15.1＋關聯式 SQLite（schema v2）

日期：2026-10-07 · 桌面版 3.14.0 → **3.15.1** · schema v1（kv_store）→ **v2（關聯式）**

> 硬性紅線遵守：冇掂 `~/workspace/ts-spaces/space-2/index.html`、
> `~/workspace/hk-legal-dora/`（只讀）、已發佈公開連結。
> Web JSON 備份格式係交換標準——桌面版適應佢，唔反轉。

---

## 1. 同步內容（web v3.15.1 → 桌面 3.15.1）

### 1.1 做法：由 surgical transplant 轉做 esbuild 模塊化組裝

舊版（v3.14）用「字串抽 function」surgical transplant——因為 web v3.15.1 轉咗
esbuild IIFE bundle（唔再暴露全域變量），呢招玩唔到。今次改為乾淨做法：

- `scripts/build-desktop.cjs`（新）：
  1. 複製 `hk-legal-dora/src/` → `web-src/`（gitignored，**一字不改**；assert `APP_VERSION='3.15.1'`）
  2. esbuild `desktop/desktop-entry.ts` → `src/desktop-bundle.js`（IIFE）；
     plugin 將 web-src 內部 `from './ui'` 指向 `desktop/shims/ui.ts`
  3. esbuild `desktop/db/index.ts` → `src/db-layer.js`（IIFE，global `__TG_DB__`）
  4. HTML 殼取 `hk-legal-dora/dist/index.html`（去 bundle 留殼），換上 4 個 script tag
  5. `tsc --noEmit` 閘門（**必須 TS 5.9.3**——見 §5 坑）
- `src/index.html` 替換前已備份為 `src/index.html.v314.bak`
- `desktop/desktop-entry.ts`：`import` web-src 模組啟動 app，組 `window.__TG__`
 （`desktopVersion='3.15.1'`、`createBackupPayload`、`validateBackup`、
  `prepareRestore`、`applyPreparedRestore`、`buildReportRows`、`reportHTML`、
  `blankStart`、`beginRestore`、`importExcelData`、`fiscalLabel`、
  `setNativeDownload`、`toCents`）——全部係真正 import，唔係字串抽取
- `desktop/shims/ui.ts`：re-export web-src/ui；`openDownloadPopup(blob,filename,title)`
  改為經 `window.__tgNativeDownload` 攔截（Blob 直接寫檔，唔彈新視窗；
  回傳 sentinel 令狀態文案正常，之後非同步換成「已儲存：…」）
- `desktop/excel-rows.ts`：`buildReportRows()` 鏡像 web `exportCSV` 起行邏輯，
  金額出美元數字（cents/100）保 Excel 數值格
- 版本號：`package.json`、`src-tauri/tauri.conf.json`、`__TG__.desktopVersion` → 3.15.1

### 1.2 行為差異（相對舊桌面版，均為修正）

- Excel 匯入期初數：舊版寫浮點美元 plain number；新版按科目 side 拆
  `{debit,credit}` 整數分（同 app 自身 `convertLegacyMoneyToCents` 一致）
- `blankStart` 跟舊 `__tgBlankStart` 語義（手動清 store＋render），唔經
  `applyPreparedRestore`（後者喺零科目時觸發 `createNewVoucher` 會炸——debug 搵到嘅真 bug）

---

## 2. 關聯式 schema v2（`desktop/db/`）

### 2.1 設計要點

- **金額一律 INTEGER（分）**，絕不存浮點——同 web v3.15.1 一致
- **18 張表**：`schema_version`（沿用 v1 定義）＋
  `fiscal_years`、`accounts`、`vouchers`、`voucher_lines`、
  `attachments`（只存 `{name,mime,path}` metadata，**永不存 dataURL**）、
  `opening_balances`（`is_plain_number` 保留舊形狀語義）、
  `opening_invoices`（`invoices` tuple 截尾存）、`invoice_remarks`、
  `allocations`、`allocation_reviews`、`reconciliation_confirmations`、
  `staff_names`、`suppressed_staff_names`（兩表分開；重疊時 suppressed 贏，有損合併已註明）、
  `deleted_data_years`、`balance_adjustments`、`app_state`（settings／workingVoucher 等）
- **陣列順序**用 `seq`／`line_index` 欄保留（vouchers／attachments／invoices／allocations）
- **Foreign keys**：`voucher_lines.voucher_no → vouchers(no) ON DELETE CASCADE`、
  `attachments.voucher_no → vouchers(no) ON DELETE CASCADE`、
  `*_fiscal_key → fiscal_years(key)`；
  **account-name-keyed 欄刻意唔加 FK**（JSON 係 name-keyed；科目改名由 app 層
  `moveNamedKey` 處理，DB 層只做忠實存取）
- `PRAGMA foreign_keys=ON`＋`journal_mode=WAL`＋`synchronous=NORMAL`
- SQL 一律 `?` placeholder（同時兼容 Tauri plugin-sql rusqlite 同 node:sqlite）
- `DbPort{execute,select}` 抽象：同一套 `convert.ts` 行喺 Tauri（經 `__TAURI_INTERNALS__.invoke`
  直調 plugin-sql）同 Node 測試（node:sqlite），零改 code

### 2.2 轉換層（`convert.ts`）

- `initDatabase(db)` → `{version, needsMigration, isFresh}`（version 0=全新／1=舊 kv／2=v2）
- `migrateFromPayload(db, payload)`：單一 transaction 全表重寫 → `DROP kv_store` → `schema_version=2`
- `persistPayload(db, payload)`：同上（全量重寫＋單 transaction；數據量細，簡單即係啱）
- `loadPayload(db)`：關聯式 → BackupPayload（round-trip deepStrictEqual；optional 欄缺席時唔輸出
  `undefined`、tuple 截尾、key 順序無關）
- **附件唔經 SQL**：`extractAttachments()`（tauri-glue.js）喺 persist 前將 dataURL 寫實體檔，
  SQL 只留 path；load 時讀返（讀唔到→該附件略過，唔炸）

### 2.3 v1 → v2 migration（保數據）

1. 啟動：`initDatabase` 驗到 v1 → **先成個 .db 檔備份**（`PRAGMA wal_checkpoint(TRUNCATE)` 落齊
   主檔 → `PRAGMA database_list` 攞真正路徑 → copy 去 `backups/toys-gallery-pre-migration-<stamp>.db`）
2. 讀 `kv_store.app_state`（舊 JSON blob）
3. 經 app 自身 `prepareRestore()` 做浮點→分正規化（重用 web v3.15.1 邏輯，唔手寫）
4. `migrateFromPayload()` 寫 18 張表（單 transaction）
5. 驗證每表筆數 → `schema_version=2`，`DROP kv_store`

---

## 3. 更穩健嘅存儲

- **自動持久化**：任何用戶互動（click/input/change/submit）→ debounce 1.5s →
  `createBackupPayload()` → hash 比對（無變唔寫）→ `extractAttachments()` → 單 transaction 寫 SQLite
- **Crash／斷電保證**：
  - 每次寫入係單一 SQLite transaction——要麼全寫入，要麼全冇，唔會有半寫狀態
  - WAL＋`synchronous=NORMAL`：已 commit 嘅 transaction 斷電唔會唔見；重啟 SQLite 自動由 WAL 恢復
  - migration 前成個 .db 備份（WAL checkpoint 後 copy）
  - 附件先寫檔、後寫 DB（順序保證：唔會有 DB 指向唔存在嘅檔；反向只會剩孤兒檔，無害）
  - 讀取失敗時 `dbWriteEnabled=false`＋「恢復自動儲存」掣——**唔會用空白覆蓋個庫**
- 附件繼續實體檔（`attachments/` 目錄），dataURL 永不入 SQL

---

## 4. 測試結果

### 4.1 DB 層（`node --test desktop/db/test-db.js`，node:sqlite 真庫）

| 測試 | 結果 |
|---|---|
| initDatabase：全新空庫 → isFresh；seedFresh 後正常 | ✅ |
| migration：v1（kv_store）→ v2，筆數＋抽查值 | ✅ |
| round-trip：persistPayload → loadPayload 零差異（含 workingVoucher 非 null） | ✅ |
| round-trip：空 payload；真空庫 loadPayload → null | ✅ |
| 附件：{name,mime,path} 存取；表內無 dataURL 殘留 | ✅ |
| edge：staffNames／suppressed 重疊 → suppressed 贏（有損，文件註明） | ✅ |
| **6/6 PASS** | |

### 4.2 前端 smoke（`node scripts/smoke-desktop.cjs`，headless Chromium＋mock invoke 接真 SQLite）

| 測試 | 結果 |
|---|---|
| T1 badge v3.15.1／T2 `__TG__.desktopVersion`／T3 `__TG_DB__` 存在 | ✅ |
| T4 啟動狀態「已建立本機賬套（空白）」 | ✅ |
| T5 schema_version=2／T6 18 張關聯表齊全 | ✅ |
| T7 匯入 3 科目／T8 UI 入銷貨 voucher（B100126） | ✅ |
| T9 vouchers 表有 1 張／T10 voucher_lines 整數分（2200000／0） | ✅ |
| T11 accounts 表 3 科目／T12 reload 後 voucher 還在 | ✅ |
| T13 P&L 有 Sales 22,000／T14 native CSV 下載落地 | ✅ |
| T15 零 pageerror／零 console error | ✅ |
| **15/15 PASS** | |

### 4.3 備份格式相容

- 匯出：`createBackupPayload()` 係 web-src 原函數——格式同 web v3.15.1 一字不差
  （`schemaVersion: 2`、整數分、`appVersion: '3.15.1'`）
- 匯入：v1 浮點舊備份經 `prepareRestore()` 正規化入 v2；v2 直接入

---

## 5. 環境坑（記錄低，下次唔再踩）

1. **TS 版本**：`typescript@7.0.2` 將 `HTMLElement.hidden` 改成 `string|boolean`，
   令 web-src typecheck 炸；**pin `typescript@5.9`**。tsc 閘門照過。
2. **package.json 係 `"type":"module"`**：build script 要叫 `.cjs`；esbuild
   sync API 唔支援 plugin，要轉 async。
3. **`page.exposeFunction` 序列化**：Uint8Array 過唔到，會變 `{0:..,1:..}` plain object——
   smoke mock 嘅 `write_file` handler 要還原返（production Tauri IPC 行 raw body，無此問題；
   glue 寫法同官方 plugin-fs `writeFile` 一字一樣，已對照 `dist-js/index.js`）。
4. **apt lock**：系統 os-intent replay 嘅 `apt-get update` 卡住（12 分鐘零進度），
   唔好同佢爭 lock；等佢完或者佢 timeout 先裝 webkit2gtk。
5. Tauri build：`export PATH="$HOME/.cargo/bin:$PATH"`；output 落 file 睇 exit code，唔好 pipe tail。

---

## 6. 產物清單

- `src/index.html`（新組裝，61.8KB；舊版備份 `src/index.html.v314.bak`）
- `src/desktop-bundle.js`（198KB，web app＋桌面橋）
- `src/db-layer.js`（30KB，`__TG_DB__` 關聯式轉換層）
- `src/tauri-glue.js`（26.8KB，重寫：init／migration／persist／load／native 下載／Excel）
- `scripts/build-desktop.cjs`（一鍵 build＋typecheck 閘門）
- `scripts/smoke-desktop.cjs`（15 項 headless smoke）
- `desktop/db/{schema,convert,index}.ts`＋`test-db.js`（6 項 DB 測試）
- `package.json`／`src-tauri/tauri.conf.json` → 3.15.1
- ⏳ `npx tauri build`（deb／rpm／AppImage／binary）——等 webkit2gtk 依賴裝好
  - ✅ 已完成（2026-10-07）：`TAURI_BUILD_EXIT=0`
  - `Toys Gallery 會計系統_3.15.1_amd64.deb`（7.0M，dpkg Version: 3.15.1 ✓）
  - `Toys Gallery 會計系統-3.15.1-1.x86_64.rpm`（7.0M）
  - `Toys Gallery 會計系統_3.15.1_amd64.AppImage`（82M）
  - `src-tauri/target/release/toys-gallery-accounting`（21M binary）
  - 依賴用手動 .deb 下載＋`dpkg -i` 裝（系統 apt 卡死，見 §5.4）
  - `src-tauri/Cargo.toml` 版本已統一為 3.15.1

## 7. 桌面獨有優勢（相對 web 版）

1. **真正關聯式查詢**：18 張表＋FK，將來跨財年對賬、審計抽查直接行 SQL，唔使撈 JSON
   （例如：`SELECT * FROM voucher_lines WHERE account_name LIKE 'Accounts Receivable%'` 一句搞掂）
2. **自動持久化＋crash-safe**：web 版 memory-only（reload 唔見晒），桌面版 debounce 自動寫
   SQLite（單 transaction＋WAL），啟動還原
3. **附件實體檔**：唔塞入 JSON／SQL，備份細、讀寫快
4. **Excel 原生**：報表經 `xlsx` 寫真 .xlsx（數值格），唔係 CSV 扮嘢；CSV 下載直接落檔唔彈窗
5. **備份互通**：JSON 備份格式同 web 一字不差，兩邊匯入匯出無縫
