# DESKTOP-3170 — 桌面版 3.17.0：Excel 完整支援

## 版本
- 桌面版 **3.17.0**（minor bump：桌面獨有功能）
- Web 核心維持 **v3.15.1**（badge、HTML 殼、web-src 一字不改）
- 改動：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`（3.17.0）、`desktop/desktop-entry.ts`（bridge＋版本）、`desktop/xlsx-polish.ts`（新增）、`desktop/excel-vouchers.ts`（新增）、`desktop/excel-export.ts`（新增）、`src/tauri-glue.js`（UI 主體）、`src/vendor/jszip.min.js`（新增）、`scripts/build-desktop.cjs`（加 jszip script tag）、`scripts/smoke-desktop.cjs`（X1–X4）

## 三個功能

### 1. Voucher 用 Excel 批量匯入
入口：桌面設置 → 「Excel — Voucher 批量匯入」→ 下載範本／匯入。

**欄位 spec**（每行 = 一條分錄行；voucher 層欄位重複）：
| 欄 | 內容 |
|---|---|
| A 日期 | YYYY-MM-DD，必須屬於已開立財年 |
| B Voucher No. | 吉＝自動編號（B040124 格式：類型+MM+序號2位+年份）；填咗就用指定編號 |
| C 類型 | B=銀行 / T=轉賬（也接受「銀行」「轉賬」） |
| D 摘要 | 吉＝「—」 |
| E/F 借方科目／金額 | 科目填編號或名稱（必須已存在）；金額美元數字 |
| G/H 貸方科目／金額 | 同上 |
| I 明細 | 分錄行明細 |
| J/K/L 製表／覆核／批核 | 三個都要填（同系統入賬規則一致） |

**分組規則**：按 B 欄 Voucher No. 分組；B 欄吉嘅行按「連續＋(日期,類型,摘要)相同」自動併做一張 voucher。

**驗證**（逐行＋逐張）：日期格式／真實日期／財年存在；類型；科目存在（編號或名稱）；每行只填借或貸一邊、金額＞0；Voucher No. 不可與系統已存在重複；借貸總額相等且＞0；三簽名齊全。錯誤列出行號＋原因，可「只匯入有效行」。

**入賬語義**：同 app 入賬按鈕等效——`applyVoucherBalance`＋`applyAllocation`（FIFO 自動對銷）＋人名＋lastVoucherDates＋重繪；匯入前先備份 DB。

**金額**：一律經 `toCents`（字串解析，唔經 float；Excel 數字 1000.5 → String → "1000.5" → 100050 分）。

### 2. Voucher 批量匯出 Excel（俾會計師）
入口：voucher 列表「匯出 Voucher Excel」掣 → 範圍 dialog（財年＋由／到月份）。

- 兩個 sheet：「總表 Vouchers」（每張一行：編號／類型／日期／摘要／借貸總額／三簽／附件）、「明細 Lines」（每條分錄一行）。
- 附件：複製去 zip 內 `attachments/<voucherNo>/`；總表「附件」格加 hyperlink（相對路徑，解壓後有效）。附件來源：dataURL 即場解碼，或 app data 內實體檔。
- 打包：JSZip（pure JS，已 vendor `src/vendor/jszip.min.js`）→ `Toys-Gallery-vouchers-<財年>_<範圍>.zip`（xlsx＋attachments）。
- 評估過唔用資料夾方案：zip 單一檔案俾會計師最方便，JSZip 經實測可靠。

### 3. 報表 xlsx 執靚
- 標題行加月份（全年／YYYY-MM）；欄寬、數字格式 `#,##0.00` 沿用；表頭加自動篩選（pl/bs 陳述式排版除外）。
- **凍結窗格＋列印標題＋標題加粗**：SheetJS Community Edition 不支援，經 `desktop/xlsx-polish.ts` 用 JSZip 直接注入 xlsx XML（`<pane state="frozen">`、`_xlnm.Print_Titles` definedName、styles.xml 加粗體 font）。數字零改動（只改呈現）。

## 設計決定
- **點解唔經 web-src**：全部桌面獨有邏輯放 `desktop/`＋`tauri-glue.js`；web-src 一字不改（diff 驗證過）。
- **點解匯入唔用 app 嘅 validate()**：`validate()` 讀 DOM（`store.rows`＋input），批量匯入直接寫 store，沿用同等語義（借貸平衡／科目存在／三簽／財年）但唔經 DOM。
- **點解附件 hyperlink 用相對路徑**：zip 解壓後 xlsx 同 attachments/ 並排，相對路徑先有效；絕對路徑喺會計師部機無意義。
- **printTitles／freeze 經 XML 注入而唔係換 library**：SheetJS CE 已夠做數字，換 Pro／ExcelJS 成本大；注入只係幾十行，smoke 有驗。

## 驗證
- `node scripts/build-desktop.cjs`：BUILD OK，typecheck 零 error。
- `node scripts/smoke-desktop.cjs`：**50/50 PASS**（T1–T15、S1–S11 沿用＋X1–X4 新增，零 pageerror）。
  - X1：範本下載有「說明」＋「範本」sheet，標題行正確。
  - X2：3 張草稿（2 有效＋1 借貸不平）→ 預覽列出 1 個錯誤 → 只匯入有效行 → DB ＋2 張；自動編號 `B100126`；分錄 120050 分借貸平衡。
  - X3：範圍 dialog → zip 落地 → xlsx＋`attachments/<no>/receipt.txt`（內容正確）→ 總表行數＝voucher 數 → hyperlink Target 含 `attachments/` → 總表凍結窗格。
  - X4：9 個 sheet 全開 → 9/9 凍結窗格 → 9/9 列印標題 → 試算表借＝貸 → 無浮點垃圾（全部數字精確到分）。
- 修咗兩個真 bug：`parseVoucherImport` 嘅 `seenNos` 誤判同編號多行（已改為按編號分組＋只驗系統重複）；匯出 hyperlink 行號冇計 3 行標題（改 r/c 座標＋glue 補標題行數）。

## 紅線
- `web-src/`（同 hk-legal-dora/src diff 一字不差）、`~/workspace/ts-spaces/`、`~/workspace/hk-legal-dora/`、公開連結：全部無掂。
- Web JSON 格式無變；無打包 binary；無 push（桌面項目唔喺 git）。

## 後續
- Mac source tarball 未出（3.16.0 版已俾過用戶；3.17.0 等用戶叫先打包）。
- 附件大檔（相片）匯出 zip 時會成個讀入記憶體；超大賬套可考慮改串流寫檔（JSZip 支援）。
