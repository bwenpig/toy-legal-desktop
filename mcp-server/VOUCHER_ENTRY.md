# 手寫 Voucher 入賬流程（Codex 用）

> 客戶兩位老闆堅持手寫簽名，紙本 voucher 影相傳上嚟，經 AI 識別後入賬。
> 識別喺 Codex（有 vision）做，MCP 只做驗證＋排隊，唔做圖像識別。

## 流程

```
客戶影相 → 用戶傳相俾 Codex → Codex 識別關鍵欄位 → 列出俾用戶確認 →
用戶確認 → Codex 調 create_voucher → 待匯入 → 用戶喺桌面版一鍵匯入
```

**唔好跳過用戶確認。** 識別錯咗入錯賬好麻煩。

## 識別：要抽嘅關鍵欄位

手寫 voucher 通常係 Bank／Transfer Voucher 格式，抽：

| 欄位 | 說明 |
|---|---|
| `date` | 日期（YYYY-MM-DD；手寫日期轉返） |
| `type` | B=銀行 voucher / T=轉賬 voucher（睇單頭） |
| `desc` | 摘要（單頭大字） |
| `voucher_no` | 如有手寫編號；無就唔填（匯入時自動編 B040124 格式） |
| `lines[]` | 逐行分錄：`account`（科目名）、借方金額、貸方金額、`detail`（明細欄） |
| `made_by` / `checked_by` / `approved_by` | 製表／覆核／批核簽名（盡量辨認；認唔到就空字串，唔好亂估） |
| 附件 | 原相做附件（`name`、`mime`、`data_base64`） |

金額：逐字睇，手寫 1/7、0/6 易撈亂，唔肯定就標註。傳俾 `create_voucher` 時用
`debit_cents`／`credit_cents`（整數分）或 `debit`／`credit`（"1234.56" 字串）。

## 確認模板（俾用戶睇）

```
識別結果（請確認）：
日期：2026-10-07　類型：B（銀行）　摘要：XXX
分錄：
  借 Bank Saving Account　$1,428.00　（明細：…）
  貸 Sales　　　　　　　　$1,428.00
簽名：製表 A／覆核 B／批核 C
借貸平衡：✅　附件：原相 1 張

確認無誤我先入賬（會排入待匯入，唔會直接寫賬套）。
```

## create_voucher 之後

- 回傳 `pending_id`；話俾用戶知去桌面版「設置 → 待匯入 Voucher」一鍵匯入。
- 用戶亦可調 `list_pending_vouchers` 睇住先，唔啱用 `reject_pending_voucher` 駁回。

## 驗證規則（MCP 會擋）

- 借貸必須平衡（分整數計）且大過 0
- 科目必須喺賬套存在（用 `query` 查 `accounts` 表先對名）
- 日期要有效；Voucher No. 唔可以重
- 一行唔可以同時有借貸數
