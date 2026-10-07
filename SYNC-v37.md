# SYNC-v37.md — Web v3.7 → 桌面版同步報告（2026-10-05）

## 同步內容

- Web v3.7 `~/workspace/ts-spaces/space-2/index.html`（35/35 驗收 PASS）→ `src/index.html`
- Web source **無改動**（只讀取）。
- 7 個 surgical edits 逐一重新施加（由 v3.6 desktop copy 抽出，機械式重放）：
  1. `createNewVoucher` 空白賬套保底 wrapper（科目唔夠兩個唔炸）
  2. 由 `exportCSV` 抽出 `buildReportRows(key)`（Excel 匯出 reuse）
  3. `exportCSV` 狀態行經 `__tgDownloadHint`
  4. 備份 JSON 下載狀態行經 `__tgDownloadHint`
  5. Desktop glue API block（`__tgReportHTML`／`__tgBlankStart`／`__tgBeginRestore`／`__tgImportExcelData`／native 下載 hook／`window.__TG__`，`desktopVersion:'3.7.0'`）
  6. 尾部 `<script src="vendor/xlsx.full.min.js">`＋`<script src="tauri-glue.js">`
  7. v3.7 三項新功能原樣保留：modal 捲動 CSS、P&L/BS 期初歸位、科目 combobox
- `src/tauri-glue.js` 本身**無需改動**（v3.7 無新增持久化 state；`draft`／`paidByInvoice` 係 function-local；`makeFiscalYear` 仍在 IIFE scope）。
- 版本三處對齊 **3.7.0**：`src-tauri/tauri.conf.json`、`package.json`、`src-tauri/Cargo.toml`；glue 內「桌面版 v3.7.0」標籤同步。

## Native 下載（代碼層面確認）

- v3.6 web 版嘅 `openDownloadPopup`（window.open 新視窗）喺 desktop copy 被 surgical wrapper 攔截：
  `__tgNativeDownload` 已設定時改行 `nativeDownload()` → Tauri `plugin:dialog|save` 揀位 ＋ `plugin:fs|write_file` 落檔，**唔經 `window.open`**。
- `tauri-glue.js` `startup()` 有 `TG.setNativeDownload(nativeDownload)` 註冊。
- 實測（headless Chromium＋mock invoke）：撳報表「下載 CSV」→ `window.open` **無被呼叫**，檔經 dialog 路徑寫出，狀態顯示「已儲存：dl-out.csv」，CSV 內容正確 → **NATIVE DOWNLOAD PASS**。

## Build 產物（Linux，`npx tauri build` EXIT 0）

- `src-tauri/target/release/toys-gallery-accounting`（binary）
- `src-tauri/target/release/bundle/deb/Toys Gallery 會計系統_3.7.0_amd64.deb`（6.88 MiB）
- `src-tauri/target/release/bundle/rpm/Toys Gallery 會計系統-3.7.0-1.x86_64.rpm`（6.88 MiB）
- `src-tauri/target/release/bundle/appimage/Toys Gallery 會計系統_3.7.0_amd64.AppImage`（81.51 MiB）

注意：首次 `npx tauri build` 失敗係因為 `cargo` 唔喺 PATH（`~/.cargo/bin`），加返 `PATH` 即過；唔係代碼問題。

## Smoke test（12/12 PASS）

真機 binary：xvfb 下啟動成功、process 在生、WebKit 渲染、plugin-sql 初始化建表（`kv_store`、`schema_version`）。

前端＋glue 邏輯（headless Chromium 載入實際 `src/index.html`，Tauri invoke mock 接真 SQLite）：

| # | 檢查 | 結果 |
|---|---|---|
| 1 | version badge 顯示 v3.7 | PASS |
| 2 | `__TG__.desktopVersion` = 3.7.0 | PASS |
| 3 | SQLite 建表 | PASS |
| 4 | `importExcelData` 匯入 2 科目 | PASS |
| 5 | voucher 借貸平衡 | PASS |
| 6 | v3.7 combobox 打字選中 Bank Current Account | PASS |
| 7 | voucher 過賬（B100126） | PASS |
| 8 | `app_state` 寫入 SQLite | PASS |
| 9 | payload 內有該 voucher（2 行分錄） | PASS |
| 10 | reload 後由 SQLite hydrate（已載入本機賬套） | PASS |
| 11 | reload 後 voucher 可見（ledgerCount=1） | PASS |
| 12 | 無 pageerror | PASS |

測試腳本：`/tmp/tgtest/smoke.js`（可重跑，需 `/tmp/v37test/node_modules/puppeteer-core`）。

## 未做／已知

- Mac 簽名／notarization／Gatekeeper：唔喺呢次範圍，需 macOS 真機。
- updater `pubkey` 仍係佔位符、`endpoints` 仍係 `update.example.com`（同之前一樣，未到發佈階段）。
- 真機截圖攞唔到（xvfb :100 嘅 xauth 問題，影到隔籬 WhatsApp）；改用 binary 行為＋前端實測代替。
