# SYNC-v314.md — Web v3.14 → 桌面版同步報告（2026-10-06）

## 同步內容

- Web v3.14 `~/workspace/ts-spaces/space-2/index.html`（22/22 獨立驗收 PASS，含 invoiceMatches 財年過濾 bugfix）→ `src/index.html`
- Web source **無改動**（只讀取）。
- 7 個 surgical edits 機械式重放（由 v3.8 desktop copy 抽出，經 `/tmp/sync-v314.py` 自動 transplant＋assert 驗證；腳本已加 `node --check` 閘門）：
  1. `createNewVoucher` 空白賬套保底 wrapper（原樣 transplant）
  2. `buildReportRows(key)` —— **今次由 web v3.14 嘅 exportCSV 重新抽取**（舊 desktop copy 係 v3.8 年代產物，仲用 `reportState.month==='all'`；v3.10 改咗做 `null`／`{key}` 形狀，舊版會錯；新版亦已包含 v3.14 AR/AP CSV 衍生發票邏輯）
  3. `exportCSV` 狀態行經 `__tgDownloadHint`
  4. 備份 JSON 下載狀態行經 `__tgDownloadHint`（檔名已係 `Toys-Gallery-backup-v3.14-…`）
  5. Desktop glue API block（`__tgReportHTML`／`__tgBlankStart`／`__tgBeginRestore`／`__tgImportExcelData`／native 下載 hook／`window.__TG__`，`desktopVersion:'3.14.0'`）
  6. 尾部 `<script src="vendor/xlsx.full.min.js">`＋`<script src="tauri-glue.js">`
  7. v3.8 兩個 bug fix（`profitLossAccountAmount`、核對 modal `openingWasDisplayed`）——已在 web v3.14，只驗證存在，無需 transplant

### 同步過程修正（記錄在案）

1. 初版 transplant 腳本 E2（`buildReportRows` 抽取）將 `web[:estart]`（已含 `function exportCSV…{` header）＋新 header 串埋，製造咗個孤兒 function header 導致括號失衡；`node --check` 閘門捉到，已改用 `m.start()` 做 prefix 邊界。最終 `ALL SYNC CHECKS PASS`＋`JS SYNTAX OK`。
2. 沿用 v38 教訓：`</body>` 用 `rfind`。
3. **真問題（desktop glue stale）**：`__tgBlankStart` 仲用 v3.8 年代 `reportState={month:'all',…}`，但 web v3.10+ 嘅月份形狀係 `null`（全年）／`{key}`。後果：`exportCSV` 計 `period` 時 `'all'.key` → `undefined` → `period.replace` 炸 `TypeError`（smoke T17 捉到），CSV 下載死咗。已改做 `{month:null,…}`（同 web 初始值一致），並寫入 transplant 腳本 E8。以後 web 改 `reportState` 形狀要同步檢查呢個 glue。

## Native 下載（代碼＋實測確認）

- `openDownloadPopup` wrapper 照舊：`__tgNativeDownload` 已設定時改行 Tauri `dialog|save`＋`fs|write_file`，唔經 `window.open`。
- 實測（headless Chromium＋mock invoke）：報表「下載 CSV」→ `window.open` **無被呼叫**，`dialog|save` 有叫，檔案經 fs 落地，CSV 內容正確（BOM＋header）→ **NATIVE DOWNLOAD PASS**。

## Build 產物（Linux，`npx tauri build` EXIT 0）

- `src-tauri/target/release/toys-gallery-accounting`（binary，20.99 MiB）
- `src-tauri/target/release/bundle/deb/Toys Gallery 會計系統_3.14.0_amd64.deb`（7.22 MiB）
- `src-tauri/target/release/bundle/rpm/Toys Gallery 會計系統-3.14.0-1.x86_64.rpm`（7.22 MiB）
- `src-tauri/target/release/bundle/appimage/Toys Gallery 會計系統_3.14.0_amd64.AppImage`（85.47 MiB）

注意：
- 今次 build 初時一樣撞返 v38 嗰個 link 問題（VM 重啟後 `/usr` 系統庫唔見：`cannot find -lwebkit2gtk-4.1` 等）——照舊用 `/var/cache/apt/archives` 嘅 cached .deb 經 `dpkg -i` 裝返即過；唔係代碼問題。
- 另發現：`npx tauri build 2>&1 | tail` 會食咗真正 exit code（tail 永遠 0）；以後 build output 落 file 再睇 `EXIT=`。
- `cargo` 唔喺預設 PATH，要 `export PATH="$HOME/.cargo/bin:$PATH"`。

## Smoke test（18/18 PASS）

headless Chromium 載入實際 `src/index.html`（Tauri invoke mock 接真 SQLite 檔）：

| # | 檢查 | 結果 |
|---|---|---|
| 1 | version badge 顯示 v3.14 | PASS |
| 2 | `__TG__.desktopVersion` = 3.14.0 | PASS |
| 3 | `importExcelData` 匯入 3 科目 | PASS |
| 4 | voucher 有 2 行分錄 | PASS |
| 5 | combobox 打字選中應收賬科目 | PASS |
| 6 | combobox 打字選中 Sales | PASS |
| 7 | voucher 借貸平衡 | PASS |
| 8 | 銷貨 voucher 過賬（Dr AR／Cr Sales 22,000，Detail `Inv#SMOKE001`） | PASS |
| 9 | **v3.14：AR drill-down 認 voucher 衍生發票 INVSMOKE001**（唔再「來源報表未有相符發票」） | PASS |
| 10 | **v3.14：收款 voucher FIFO 全數對銷 INVSMOKE001（已收 22,000、結欠 0）** | PASS |
| 11 | **P&L Sales = 22,000（冇 double count，BUG-1 回歸）** | PASS |
| 12 | native 下載：`window.open` 無被呼叫 | PASS |
| 13 | native 下載：`dialog\|save` 有叫 | PASS |
| 14 | native 下載：檔案落地 | PASS |
| 15 | CSV 內容正確（BOM＋格式） | PASS |
| 16 | SQLite `app_state` 有該 voucher（B100126、B100226） | PASS |
| 17 | 無 pageerror | PASS |

（18 項：T10 拆咗做過賬＋FIFO 兩項。）

真機 binary：xvfb 下啟動成功、跑足 25 秒無 crash／panic（exit 124 係 timeout 預期；libEGL warning 係 VM 無 GPU，harmless）。

測試腳本：`~/workspace/smoke314-run/smoke.js`（可重跑；mock invoke 經 `sqlite3` CLI 接 `~/workspace/smoke314-work/tg.db`；**注意 script 同 work dir 已分開**，唔好合併——舊版 script 試過自己刪咗自己）。

## 未做／已知

- Mac 簽名／notarization／Gatekeeper：唔喺呢次範圍，需 macOS 真機。
- updater `pubkey` 仍係佔位符、`endpoints` 仍係 `update.example.com`（同之前一樣）。
- Desktop Excel 匯出嘅 P&L／BS 沿用 TB 式行列（`buildReportRows` 嘅 `else` 分支）——v3.6 起既有行為，今次無改；但 `buildReportRows` 嘅 AR/AP／sales／purchase／journal／register 分支而家同 web v3.14 一致（含衍生發票）。
- 公開 web 連結無掂；web source 無改過。
