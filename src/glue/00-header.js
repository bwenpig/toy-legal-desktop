/* ============================================================================
 * Toys Gallery 會計系統 — Tauri 桌面版 glue（3.17.0）
 *
 * 職責：
 *  1. SQLite 持久化（關聯式 schema v2，經 db-layer.js 的 __TG_DB__）：
 *     - initDatabase：建表／PRAGMA／版本檢查
 *     - v1（kv_store）→ v2 migration：先備份 .db 檔，再經 app 自身
 *       prepareRestore() 正規化（v1 浮點→分）後寫入關聯表
 *     - 以 web 版 createBackupPayload() 做序列化出口、
 *       prepareRestore()+applyPreparedRestore() 做還原入口（經 window.__TG__）
 *  2. 自動儲存：監聽用戶互動（click/change/input/submit），debounce 1.5s，
 *     內容無變化（hash 比對）則跳過寫入；單一 transaction，crash-safe。
 *  3. 啟動：v2 有存檔 → 由關聯表還原；v1 → migration；全新 → 空白啟動。
 *  4. 附件：data URL → 存實體檔 <appData>/attachments/<voucherNo>/<檔名>；
 *     載入時讀返轉做 data URL，交返 app 原有邏輯。metadata 入 attachments 表。
 *  5. Excel：
 *     - 9 份報表匯出 .xlsx（SheetJS，本地 vendor bundle，離線可用），
 *       經 xlsx-polish 後期加工：凍結窗格、列印標題、標題加粗、自動篩選
 *     - 匯入科目表＋期初數；下載匯入範本
 *     - Voucher 批量匯入（範本→驗證→預覽→匯入有效行）
 *     - Voucher 批量匯出俾會計師（總表＋明細＋附件，打包 zip）
 *  6. JSON 備份匯入（web 版遷移）：dialog 揀檔 → app 原有 validate＋雙重確認 modal。
 *
 * 注意：app 本體（desktop-bundle.js）經 window.__TG__ 溝通；
 *       DB 轉換層（db-layer.js）經 window.__TG_DB__ 溝通。
 * ========================================================================== */
(function(){
'use strict';

