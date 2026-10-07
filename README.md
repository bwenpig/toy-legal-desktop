# Toys Gallery 會計系統 — Mac 桌面版（Tauri 2.x）

> 狀態：**v3.6.0** — web v3.6 前端已接入，SQLite 持久化＋Excel 讀寫已實現（Linux 驗證中）。
> 架構方向：SQLite 做 single source of truth；API service（FastAPI）喺另一 track 起；桌面版 local SQLite 做離線模式。

## 目錄

```
toys-gallery-desktop/
├── src/
│   ├── index.html          # web v3.5 的 desktop copy（surgical edits：buildReportRows 抽出＋__TG__ 暴露）
│   ├── tauri-glue.js      # 桌面 glue：SQLite 持久化／自動儲存／Excel／附件／JSON 匯入
│   └── vendor/
│       └── xlsx.full.min.js # SheetJS 本地 bundle（npm xlsx，離線可用）
├── src-tauri/
│   ├── src/main.rs         # 註冊 plugins：sql / dialog / fs / updater
│   ├── tauri.conf.json     # productName「Toys Gallery 會計系統」，updater endpoint 佔位
│   ├── capabilities/default.json
│   └── icons/
├── SCHEMA.md               # SQLite schema（KV 表＋將來 migration）
├── SYNC.md                 # web→桌面同步→VPS 發佈流程
└── package.json            # @tauri-apps/* 2.x ＋ xlsx
```

## 運作原理（glue）

web 前端係 IIFE 單文件，無從外部呼叫。因此 desktop copy 尾部 surgical 暴露
`window.__TG__`（`createBackupPayload`／`prepareRestore`／`applyPreparedRestore`／
`buildReportRows`／`reportHTML`／`blankStart`／`beginRestore`／`importExcelData`／
`fiscalLabel`），glue 經佢溝通，唔重構 app 內部。原檔 `~/workspace/ts-spaces/space-2/` 永不改動。

- **啟動**：讀 `kv_store[app_state]` → 附件路徑還原 data URL → hydrate；
  無存檔 → 空白啟動（唔載 demo 數據）。
- **自動儲存**：document 級互動事件 → debounce 1.5s → payload hash 無變化跳過；
  附件 data URL 抽出存 `<appData>/attachments/<voucherNo>/`。
- **Excel 匯出**：9 sheets；pl/bs 用 app 自己 render 嘅 table（數字同畫面一致）。
- **Excel 匯入**：「下載匯入範本」拎 3-sheet 範本（說明／科目表／期初數）；
  「匯入 Excel」只新增唔存在的科目編號，期初數要求財年＋科目存在。

## 快速開始（Linux 驗證）

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd ~/workspace/toys-gallery-desktop
npm install
npx tauri build --debug   # debug bundle；release 用 npx tauri build
```

系統依賴（Ubuntu）：`libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`

## 正式 Mac 版

經 GitHub Actions `macos-latest` runner：build → Developer ID 簽名 → notarization → scp 上 VPS。
詳見 SYNC.md。

## 已知限制

- WKWebView（macOS）兼容未驗證——Linux 只驗 WebKitGTK＋邏輯；最終要 Mac／CI 驗。
- `pagehide` flush 係 best-effort；正常用靠 1.5s debounce 自動儲存。
- Excel 匯出無圖表（SheetJS 社區版唔寫圖表）；pl/bs 數字格來自畫面表格文字的保守轉換。
- Voucher 明細 Excel 匯入未做（下一步）。
- updater `pubkey`＋endpoint 仍係佔位符，上線前要換真值。
