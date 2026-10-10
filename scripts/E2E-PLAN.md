# E2E 自我測試用例設計（桌面版 v3.25.1）

> 目標：模擬用戶真實流程，自我發現問題、自我修復，形成可重複執行嘅 loop。
> 執行環境：本地沙箱（headless Chromium + mock Tauri plugin + 真 SQLite via node:sqlite）。
> 唔同現有 suite 嘅分工：smoke（65）做廣度冒煙、accept-v322（14）做附件流程、accept-v3242（10）做附件映射回歸；
> 本 E2E 專注**用戶端到端流程**同**客戶六條規則**（流向／源頭／分類／平衡／財年獨立／留底）最高風險嘅位。

## 測試數據設定

- 財年：FY2026（2026-04-01 至 2027-03-31，預設已有）；測試中途新增 FY2027。
- 科目：1000 Bank Saving Account（資產）、1101 Accounts Receivable of Toy Hunters（資產）、
  4000 Sales（收入）、4200 Other Income（收入）、5000 Purchase（成本）、
  2100 Accounts Payable of Supplier A（負債）。
- 金額一律整數分；日期用 2026-10 上旬（喺 FY2026 內）。

## 用例清單（38 項：P0＋A–H 組）

### A. 手動入賬（規則：平衡、分類）

| # | 用例 | 步驟 | 預期 |
|---|------|------|------|
| A1 | 正常銷貨 voucher | 建立 Voucher：日期 2026-10-02，Dr「Accounts Receivable of Toy Hunters」22,000／Cr「Sales」22,000，三簽名（製表／覆核／批核）→ 過賬 | 過賬成功；voucher_lines 整數分（2200000）；Trial Balance Dr=Cr |
| A2 | 借貸不平被擋 | Dr 100／Cr 90 → 睇 postBtn | postBtn disabled；balanceState 顯示差額 HK$10.00 |
| A3 | 無效科目被擋 | 科目打「唔存在嘅科目」→ 睇 postBtn | postBtn disabled；提示選有效科目 |
| A4 | 日期唔喺財年內被擋 | 日期改 2028-05-01（FY2026 外）→ 睇 postBtn | postBtn disabled（dateOK=false） |
| A5 | 欠簽名被擋 | 清空 approvedBy → 睇 postBtn | postBtn disabled |

### B. Voucher 修改＋重過賬（規則：流向、平衡、源頭）

| # | 用例 | 步驟 | 預期 |
|---|------|------|------|
| B1 | 修改金額重過賬 | 喺 voucher 列表㩒 A1 嗰張嘅「修改」，金額改 22,000→20,000 → 儲存修改並重新過賬 | Ledger／P&L Sales 變 20,000；舊分錄已沖回（balanceAdjustments 唔會 double count） |
| B2 | 修改後試算表仍平衡 | 睇 Trial Balance | Dr 總額＝Cr 總額 |
| B3 | 修改科目觸發報表重分類 | 將 Cr 科目由 Sales 改為「Other Income」（收入類）→ 睇 P&L | P&L 上 Sales 消失，Other Income 出現 20,000（分類跟科目行） |
| B4 | （觀察項）桌面版無 voucher 刪除 UI | 檢查 voucher 列表操作欄 | 只有「修改」掣 → 記為 open question（唔修，唔估產品意圖） |

### C. 收款對銷 FIFO（規則：流向、財年獨立）

| # | 用例 | 步驟 | 預期 |
|---|------|------|------|
| C1 | 兩張銷貨發票入賬 | 銷貨 voucher：Dr AR of Toy Hunters 10,000／Cr Sales 10,000，明細寫 INV001（日期 2026-10-03）；第二張 5,000／明細 INV002（日期 2026-10-05） | 兩張過賬成功；發票 INV001／INV002 衍生（voucherDerivedInvoices） |
| C2 | 收款唔指定發票 → FIFO | 收款 voucher：Dr Bank 8,000／Cr AR of Toy Hunters 8,000，allocationInvoice 吉（日期 2026-10-06） | INV001 對銷 8,000（最舊先） |
| C3 | AR 賬齡餘額 | 睇 AR 賬齡報告（Toy Hunters） | INV001 餘 2,000；INV002 餘 5,000 |
| C4 | 收款指定發票 | 收款 2,000，allocationInvoice=INV002 | INV002 餘 3,000；INV001 餘額不變 |
| C5 | AR 總額勾稽 | AR 賬齡總餘額 vs 科目餘額 | 兩者一致（2,000+3,000=5,000） |

### D. 財年獨立（規則：獨立）

| # | 用例 | 步驟 | 預期 |
|---|------|------|------|
| D1 | 新增財年 | 財年管理 → 開始年份填 2027 → 新增 | FY2027（2027-04-01 至 2028-03-31）建立並自動切換 |
| D2 | 新財年入賬唔影響舊年 | 切到 FY2027，入一張銷貨 voucher 30,000；切返 FY2026 睇 P&L | FY2026 P&L Sales 維持舊數（唔包 30,000） |
| D3 | FIFO 唔跨年 | FY2027 收一筆 AR of Toy Hunters 嘅款 | FY2026 嘅 INV001／INV002 餘額不變（唔被新年收款對銷） |
| D4 | 財年下拉隔離 | 切換 #fiscalYearSelect | voucher 列表只顯示當選財年嘅單 |

### E. 9 份報表（規則：流向、分類）

| # | 用例 | 步驟 | 預期 |
|---|------|------|------|
| E1 | 試算表平衡 | reports → trial | Dr 總額＝Cr 總額＞0 |
| E2 | 損益表 | reports → pl | Sales／Other Income 金額啱；費用分類正確 |
| E3 | 資產負債表 | reports → bs | 資產＝負債＋權益 |
| E4 | AR 賬齡 | reports → ar | 逐個客列出；Toy Hunters 餘額＝C5 |
| E5 | AP 賬齡 | reports → ap | 無數據唔報錯（空表正常顯示） |
| E6 | 採購報告 | reports → purchase | 月份 tab 存在；篩選正常 |
| E7 | 銷售報告 | reports → sales | 月份 tab 存在；Sales 金額啱 |
| E8 | Journal | reports → journal | 逐張 voucher、逐行分錄齊全 |
| E9 | Voucher Register | reports → register | 列表行數＝voucher 數 |
| E10 | 報表月份篩選 | P&L 揀 2026-10 單月 | 只計 10 月嘅數（同全年數唔同） |

### F. 匯入匯出整合（規則：留底、流向）

| # | 用例 | 步驟 | 預期 |
|---|------|------|------|
| F1 | Voucher 範本科目下拉 | 下載 voucher 範本 → 解 zip 睇 xlsx | 13 欄；借／貸方欄有 dataValidation 下拉（v3.24.0 功能回歸） |
| F2 | 資料夾匯入＋附件 | 資料夾放 Excel＋1 個附件 → 從資料夾匯入 | 匯入成功；附件入庫且 bytes 一致 |
| F3 | JSON 備份→還原端到端 | createBackupPayload 匯出 → 切新 DB → 設置頁 JSON 匯入 → 驗證 | voucher 數、科目數、附件數全部返嚟 |
| F4 | 報表匯出用公司名 | 見 G（公司名設定後，匯出 xlsx 標題含公司名） | — |

### G. 公司名（規則：留底識別；v3.25.0／v3.25.1 新功能）

| # | 用例 | 步驟 | 預期 |
|---|------|------|------|
| G1 | 修改公司名 | 工具欄㩒「修改」→ modal 輸入「E2E 測試公司」→ 確定 | 工具欄顯示「公司：E2E 測試公司」 |
| G2 | 吉名被拒 | 開 modal → 清空 → 確定 | 顯示「請輸入公司名稱」；舊名保留 |
| G3 | reload 持久化 | reload → 睇工具欄＋app_state 表 | 公司名仲喺度 |
| G4 | 匯出標題用公司名 | 匯出 Excel 報表 → 睇 xlsx 標題 | 標題含「E2E 測試公司」 |

### H. 明細 Detail 顯示（規則：源頭）

| # | 用例 | 步驟 | 預期 |
|---|------|------|------|
| H1 | 有 Detail 逐行顯示 | 入一張 voucher，兩行分錄各填唔同 Detail → 睇 Journal | Journal 逐行顯示各自 Detail |
| H2 | 吉 Detail 跌返摘要 | 入一張 voucher，Detail 吉晒 → 睇 Journal | Journal 用 voucher 摘要顯示 |

## 截圖清單（存 scripts/e2e-shots/，報告逐個引用）

1. `a1-voucher-form.png` — A1 入賬畫面（借貸平衡＋三簽名）
2. `a2-unbalanced.png` — A2 借貸不平狀態
3. `b1-edit.png` — B1 修改並重過賬
4. `c3-ar-aging.png` — C3 AR 賬齡
5. `d1-fiscal.png` — D1 財年管理
6. `e1-trial.png` … `e9-register.png` — 9 份報表
7. `f1-template.png` — F1 範本下載（或只驗 dataValidation，唔截圖）
8. `g1-company-modal.png` — G1 公司名 modal
9. `h1-journal-detail.png` — H1 Journal 明細顯示

## 執行方式

`node scripts/e2e-selfcheck.cjs` — 一個命令跑晒 38 項；每個用例記錄
步驟／預期／實際／PASS-FAIL／耗時；自動生成 `scripts/E2E-REPORT.md`（含截圖引用）。

## 已知唔覆蓋（要用戶知）

- Mac 真機原生 dialog／TCC 權限（沙箱係 Linux headless mock）。
- 深色模式等視覺細節。
- B4：桌面版無 voucher 刪除功能（open question，唔修）。
- 附件喺真 Tauri 係 ArrayBuffer；mock 回傳 Array（已知坑，glue 照樣識轉）。
