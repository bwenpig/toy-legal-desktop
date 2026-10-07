# DESKTOP-3160 — 桌面版 3.16.0：設置畫面（數據位置／表預覽／JSON 匯入）

## 版本
- 桌面版 **3.16.0**（minor bump：桌面獨有功能）
- Web 核心維持 **v3.15.1**（badge、HTML 殼、web-src 一字不改）
- 改動檔案：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`desktop/desktop-entry.ts`（desktopVersion）、`src/tauri-glue.js`（主體）、`scripts/smoke-desktop.cjs`（測試）

## 三個功能

### 1. 指定數據位置
- 設置畫面顯示目前 SQLite 檔真實路徑（由 `PRAGMA database_list` 攞，唔估路徑）。
- 「選擇數據庫檔案…」（.db 檔）／「選擇資料夾…」（用入面嘅 `toys-gallery.db`）／「重設為預設位置」。
- 選擇存於 `<AppConfig>/tg-config.json`（`{"dbPath": "..."}`）。

**設計決定：點解 config 放 AppConfig 而唔係 DB 入面**
- 雞同雞蛋：要開 DB 先要知 DB 喺邊，所以 config 一定要喺 DB 出面。
- 點解唔用 AppData：config 係設定，平台慣例放 AppConfig（macOS 下同 AppData 同目錄，Linux 係 `~/.config`）。附件／備份繼續放 AppData。

**切換流程（安全第一）**
1. 先 `persistNow()` 將未儲存改動寫入舊庫，再暫停自動儲存。
2. 目標已存在 → 確認面板 → 關舊連接 → 開新庫 → v2 直接載入／v1 先備份再 migration。
3. 目標係新 → 二揀一：「將目前賬套複製過去」（WAL checkpoint 後複製 bytes，**源檔保留唔刪除**）或「建立空白賬套」。
4. 成功先寫 `tg-config.json`；任何一步失敗 → 關閉新連接、重開舊庫、還原舊狀態，**永遠唔留空白庫**。
5. 路徑無效／開唔到 → 報錯＋還原。

**技術要點**
- Rust 側（main.rs）完全唔持有 DB 連接——連接由前端經 `plugin:sql` 管理，所以切換路徑**唔使改 Rust**。
- plugin-sql 2.5.0 嘅 `path_mapper` 用 `PathBuf::push`：傳 `sqlite:/絕對路徑` 會成個取代預設目錄，實測可行（讀咗 `~/.cargo` 嘅 plugin 源碼確認）。
- 切換用 `plugin:sql|close`（db handle）關舊池，再 `load` 新路徑。
- 附件繼續放 `<AppData>/attachments/`，不隨 DB 位置改變（設置畫面有註明）。

### 2. 數據庫表預覽（只讀）
- `sqlite_master` 列出全部表＋每表 `COUNT(*)`；撳入去 `PRAGMA table_info` 攞欄名＋`SELECT * LIMIT 100` 通用渲染。
- 表名經 `quoteIdent` 轉義；長文字截 80 字；NULL 標示。唔提供任何寫入。

### 3. 從 Web JSON 匯入到 SQLite
- dialog 揀 `.json` → `TG.validateBackup`（唔啱即 throw）→ `TG.prepareRestore`（v1 浮點→分，沿用 app 邏輯）。
- 匯入摘要：檔名、備份版本、schema 版本、匯出時間、voucher／科目／財年數；v1 會註明「N 個金額欄位由美元轉為分」。
- 用戶確認 → **先 `backupDbFile('pre-settings-import')` 備份目前 DB** → `extractAttachments` → `DB.persistPayload` 單一 transaction → 由 DB 重載 app（`loadAppStateFromDb`）。
- 重用現有轉換層（`__TG_DB__`），無另起爐灶。附件 dataURL 抽出存實體檔後先入庫（同現有 migration 一致）。

## UI 做法
- 側欄 nav 注入「桌面設置」掣（無 `data-route`，web-src `navigate()` 唔會理；經 `#desktopSidebar nav.nav` 定位）。
- 設置係桌面獨有 overlay view（`#tgSettingsView`，fixed 全屏），開啟時 `display:none` 隱藏 `#appShell`，關閉還原；Esc 可關。
- 全部 DOM／CSS 由 `tauri-glue.js` 擁有，web-src 零改動。版本區寫明「桌面版 v3.16.0 ＋ Web 核心 v3.15.1」＋桌面版更新日誌。

## 驗證
- `node scripts/build-desktop.cjs`：BUILD OK，typecheck 零 error。
- `node scripts/smoke-desktop.cjs`：**33/33 PASS**（T1–T15 原有＋S1–S11 新增，零 pageerror）。
  - S1/S2：設置開啟＋隱藏 app；版本字樣正確。
  - S3/S4：17 張表列出＋筆數；vouchers 預覽 1 行 13 欄。
  - S5：切換到新目錄（複製賬套）→ DB 檔建立、config 寫入、新庫有數據。
  - S6：重設預設位置 → config 無 dbPath。
  - S7/S8：關閉還原 app；voucher 還在。
  - S9：v2 JSON 匯入 → 摘要＋完成＋voucher 數一致。
  - S10：v1 JSON 匯入 → 轉分提示＋100.1→10010 分正確。
  - S11：v1 舊庫切換 → 自動 migration 到 schema v2，數據在。
- Smoke mock 升級：多 DB 檔支援（conn string → DatabaseSync map）、`plugin:sql|close`、`plugin:fs|exists`、dialog open queue、directory 13（AppConfig）。
- 修咗一個真 bug：`doSwitch` 先調 `hideSwitchConfirm()` 清咗 `pendingSwitch` 才讀，導致切換永遠無反應（smoke S5b 捉到）。

## 紅線
- `web-src/`（web 版源碼）一字不改；`~/workspace/ts-spaces/`、`~/workspace/hk-legal-dora/`、公開連結無掂。
- Web JSON 備份格式無變（v1／v2 照舊）。
- 無打包 binary（等用戶叫先出）；無 push（桌面項目唔喺 git）。

## 遺留／注意
- 切換數據位置後，舊位置嘅 `-wal`／`-shm` 檔會留低（無害）。
- 附件唔跟 DB 位置走（設計決定，見上）。
- `tg-config.json` 壞咗／唔見咗 → 靜默用預設位置。
