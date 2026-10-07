# SYNC-v38.md — Web v3.8 → 桌面版同步報告（2026-10-05）

## 同步內容

- Web v3.8 `~/workspace/ts-spaces/space-2/index.html`（32/32 驗收 PASS）→ `src/index.html`
- Web source **無改動**（只讀取）。
- 7 個 surgical edits 機械式重放（由 v3.7 desktop copy 抽出，經 `/tmp/sync-v38.py` 自動 transplant＋assert 驗證）：
  1. `createNewVoucher` 空白賬套保底 wrapper
  2. `buildReportRows(key)` 抽取（Excel 匯出 reuse）
  3. `exportCSV` 狀態行經 `__tgDownloadHint`
  4. 備份 JSON 下載狀態行經 `__tgDownloadHint`（檔名已改 `v3.8`）
  5. Desktop glue API block（`__tgReportHTML`／`__tgBlankStart`／`__tgBeginRestore`／`__tgImportExcelData`／native 下載 hook／`window.__TG__`，`desktopVersion:'3.8.0'`）
  6. 尾部 `<script src="vendor/xlsx.full.min.js">`＋`<script src="tauri-glue.js">`
  7. v3.8 兩個 bug fix 原樣保留：P&L／dashboard Sales／Purchases 行 GL 結餘（`profitLossAccountAmount`）、核對 modal `openingWasDisplayed` 期初保護
- `src/tauri-glue.js` 邏輯**無需改動**（v3.8 無新增持久化 state）；「桌面版 v3.8.0」標籤已更新。
- 版本三處對齊 **3.8.0**：`src-tauri/tauri.conf.json`、`package.json`、`src-tauri/Cargo.toml`。

### 同步過程修正（記錄在案）
- 初版 transplant 腳本 Edit 6 用 `replace("</body>", …, 1)` 誤中 download-popup `document.write` 字串內嘅 `</body>`，導致 inline JS syntax error；已改用 `rfind("</body>")`，並加 `node --check` 閘門。最終 `ALL SYNC CHECKS PASS`。

## Native 下載（代碼＋實測確認）

- `openDownloadPopup` wrapper 照舊：`__tgNativeDownload` 已設定時改行 Tauri `dialog|save`＋`fs|write_file`，唔經 `window.open`。
- 實測（headless Chromium＋mock invoke）：報表「下載 CSV」→ `window.open` **無被呼叫**，`dialog|save` 有叫，檔案經 fs 落地，CSV 內容正確 → **NATIVE DOWNLOAD PASS**。

## Build 產物（Linux，`npx tauri build` EXIT 0）

- `src-tauri/target/release/toys-gallery-accounting`（binary）
- `src-tauri/target/release/bundle/deb/Toys Gallery 會計系統_3.8.0_amd64.deb`（6.92 MiB）
- `src-tauri/target/release/bundle/rpm/Toys Gallery 會計系統-3.8.0-1.x86_64.rpm`（6.92 MiB）
- `src-tauri/target/release/bundle/appimage/Toys Gallery 會計系統_3.8.0_amd64.AppImage`（81.56 MiB）

注意：今次 build 初時 link 失敗（`cannot find -lwebkit2gtk-4.1` 等）——VM 重啟後 `/usr` 下嘅系統庫唔見咗。用 `/var/cache/apt/archives` 嘅 cached .deb 經 `dpkg -i` 裝返即過；唔係代碼問題。下次如再見到同樣 link error，照做即可。

## Smoke test（17/17 PASS）

headless Chromium 載入實際 `src/index.html`（Tauri invoke mock 接真 SQLite 檔）：

| # | 檢查 | 結果 |
|---|---|---|
| 1 | version badge 顯示 v3.8 | PASS |
| 2 | `__TG__.desktopVersion` = 3.8.0 | PASS |
| 3 | `importExcelData` 匯入 3 科目 | PASS |
| 4 | voucher 有 2 行分錄 | PASS |
| 5 | v3.8 combobox 打字選中應收賬科目 | PASS |
| 6 | v3.8 combobox 打字選中 Sales | PASS |
| 7 | voucher 借貸平衡 | PASS |
| 8 | 銷售 voucher 過賬（Dr AR／Cr Sales 22,000） | PASS |
| 9 | AR 核對 modal 有 reconcile 掣 | PASS |
| 10 | 經核對 modal 登記發票 INV-SMOKE 22,000 | PASS |
| 11 | **P&L Sales = 22,000（冇 double count，BUG-1 回歸）** | PASS |
| 12 | native 下載：`window.open` 無被呼叫 | PASS |
| 13 | native 下載：`dialog\|save` 有叫 | PASS |
| 14 | native 下載：檔案落地 | PASS |
| 15 | CSV 內容正確（BOM＋格式） | PASS |
| 16 | SQLite `app_state` 有該 voucher | PASS |
| 17 | 無 pageerror | PASS |

真機 binary：xvfb 下啟動成功、跑足 25 秒無 crash／panic（exit 124 係 timeout 預期）。

測試腳本：`/tmp/smoke38/smoke.js`（可重跑；mock invoke 經 `sqlite3` CLI 接 `/tmp/smoke38/tg.db`）。

## 未做／已知

- Mac 簽名／notarization／Gatekeeper：唔喺呢次範圍，需 macOS 真機。
- updater `pubkey` 仍係佔位符、`endpoints` 仍係 `update.example.com`（同之前一樣）。
- Desktop Excel 匯出嘅 P&L／BS 沿用 TB 式行列（`buildReportRows` 嘅 `else` 分支）——v3.6 起既有行為，今次無改。
