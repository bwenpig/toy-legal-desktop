# Toys Gallery 會計系統 — 桌面版 SQLite Schema 設計（v1）

> 來源：web 版 v3.2 `~/workspace/ts-spaces/space-2/index.html`（memory-only，狀態全放 JS 變量）。
> 第一版用 **KV 表**同 web 語義 1:1 對應，零轉換風險；將來數據量大再正規化（relational），經 migration 升級。

## 1. 表結構

```sql
CREATE TABLE IF NOT EXISTS kv_store (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL            -- JSON 字串
);

CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY, -- 由 1 開始
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- 初始：INSERT INTO schema_version(version) VALUES (1);
```

## 2. KV keys（全部 value 係 JSON）

| key | 內容 | 來源變量 |
|---|---|---|
| `vouchers` | voucher 陣列：`{no,type,numberManual,date,desc,allocationInvoice,madeBy,checkedBy,approvedBy,supportingName,supportingPath,lines:[{account,debit,credit,detail}]}` | `vouchers` |
| `accounts` | 科目表：`[{code,name,type,balance,importedBalance,side}]`（用戶可增改） | `accounts` |
| `openingBalances` | `{[fyKey]: {[accountName]: amount}}` | `openingBalances` |
| `openingInvoiceDetails` | `{[fyKey]: {[accountName]: [{no,date,amount}]}}` | `openingInvoiceDetails` |
| `balanceAdjustments` | `{[fyKey]: …}` 期初調整 | `balanceAdjustments` |
| `fiscalYears` | `[{key,start,label,from,to}]` | `fiscalYears` |
| `selectedFiscalKey` | 當前財年 key | `selectedFiscalKey` |
| `deletedDataYears` | 已刪除財年 key 陣列 | `deletedDataYears`（Set→array） |
| `salesInvoices` | 銷售發票登記：`[[date,no,customer,amount]…]` | `salesInvoices` |
| `purchaseInvoices` | 採購發票登記：`[[date,no,supplier,amount]…]` | `purchaseInvoices` |
| `invoiceRemarks` | `{invoiceNo: remark}` | `invoiceRemarks` |
| `allocations` | FIFO 對銷記錄：`[{kind,voucher,invoiceNo,party,amount,date}]` | `allocations` |
| `allocationReview` | 待核對項目陣列 | `allocationReview` |
| `reconciliationConfirmations` | `{accountKey: {by,date,note,snapshot}}` 已核對確認 | `reconciliationConfirmations` |
| `staffNames` | 常用人名陣列 | `staffNames`（Set→array） |
| `suppressedStaffNames` | 已刪除人名陣列 | `suppressedStaffNames`（Set→array） |
| `lastVoucherDates` | `{[fyKey]: date}` 上次用嘅 voucher 日期 | `lastVoucherDates` |

UI-only 狀態（`reportState`、`editingIndex`、`rows` 草稿等）**唔入庫**。

## 3. 附件處理

- web 版 `supportingFile` 係瀏覽器 File 物件（memory-only），JSON 備份帶唔走 binary。
- 桌面版：附件存實體檔，路徑放 app data dir 下 `attachments/<voucherNo>/`，voucher 記 `supportingPath`。
- web JSON 匯入時：只保留 `supportingName`（顯示用），`supportingFile` 懸空，用戶需要可重新附加。此限制要寫入更新說明。

## 4. StorageAdapter 介面（前端 v3.3 會實現，桌面版共用）

```js
interface StorageAdapter {
  load(key: string)        : Promise<string | null>
  save(key: string, value: string): Promise<void>
  remove(key: string)      : Promise<void>
  keys()                   : Promise<string[]>
}
```

桌面版實現 `src/storage/sqlite-adapter.js`（經 `@tauri-apps/plugin-sql`）：

- `init()`：開 `sqlite:toys-gallery.db`，建表，`schema_version` 無記錄則 seed v1；空庫時寫入 demo seed（同 web 首跑一致）。
- `save` = `INSERT INTO kv_store(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`
- 另加桌面專用：`importAll(obj)`（JSON 備份匯入，transaction 包住）、`exportAll()`（備份匯出）、`backupDbFile()`（更新前複製 .db 檔）。
- 附件讀寫經 `@tauri-apps/plugin-fs` + `@tauri-apps/plugin-dialog`，唔經 SQL。

## 5. 將來 migration 機制

- `schema_version` 而家 = 1（KV）。
- 日後要正規化（例如 vouchers 獨立成表）：寫 migration script，讀 `kv_store` → 寫新表 → `INSERT schema_version`  bump。
- Migration 喺 adapter `init()` 開頭跑，跑之前自動備份 .db。

## 6. 數據庫檔位置

- macOS：`~/Library/Application Support/com.toysgallery.accounting/toys-gallery.db`
- 備份：同目錄 `backups/toys-gallery-YYYYMMDD-HHMMSS.db`
- 附件：同目錄 `attachments/`
