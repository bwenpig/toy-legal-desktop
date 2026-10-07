/**
 * 由 scripts/extract.js 自 v3.15 index.html 自動拆分。
 * 零功能變更：邏輯與原 IIFE 內文一致（全域狀態引用改為 store.*）。
 */
import type { BackupData, BackupPayload, InvoiceRow, Voucher } from './types';
import { APP_VERSION } from './version';
import { convertLegacyMoneyToCents } from './money';
import { closeAccountEdit } from './accounts';
import { closeDeleteFiscal } from './fiscal-years';
import { closeOpeningInvoiceEditor } from './accounts';
import { closeReconciliation } from './reports';
import { esc } from './ui';
import { makeFiscalYear } from './core/fiscal';
import { navigate } from './ui';
import { normalizeAttachments } from './vouchers';
import { refreshFiscalScope } from './fiscal-years';
import { renderAccounts } from './accounts';
import { renderInvoiceNumberList } from './vouchers';
import { renderKPIs } from './reports';
import { renderLedger } from './ledger';
import { renderReport } from './reports';
import { renderStaffNames } from './ui';
import { renderVoucherList } from './vouchers';
import { reportNames } from './reports';
import { serializeVoucher } from './vouchers';
import { setVoucher } from './vouchers';
import { sortAccounts } from './accounts';
import { store } from './state';
import { toggleFiscalManager } from './fiscal-years';
import { toggleOpeningManager } from './accounts';
import { toggleStaffManager } from './ui';

export const backupButton=(document.getElementById('backupData') as HTMLButtonElement);

export const copyBackupButton=(document.getElementById('copyBackupData') as HTMLButtonElement);

export const restoreButton=(document.getElementById('restoreData') as HTMLButtonElement);

export const restoreFileInput=(document.getElementById('restoreFile') as HTMLInputElement);

export const backupStatus=(document.getElementById('backupStatus') as HTMLElement);

export const restoreModal=(document.getElementById('restoreModal') as HTMLElement);

export const cloneJSON=<T,>(value: T): T=>JSON.parse(JSON.stringify(value));

export function replaceArray<T>(target: T[],source: T[] | null | undefined){target.splice(0,target.length,...cloneJSON(source||[]))}

export function replaceObject(target: Record<string, unknown>,source: Record<string, unknown> | null | undefined){Object.keys(target).forEach(key=>delete target[key]);const src=source||{};Object.keys(src).forEach(key=>{if(!['__proto__','prototype','constructor'].includes(key))target[key]=cloneJSON(src[key])})}

export function replaceSet(target: Set<string>,source: unknown[] | null | undefined){target.clear();(source||[]).forEach(value=>target.add(String(value)))}

export function hydrateVoucher(voucher: Voucher): Voucher{const plain={...cloneJSON(voucher)};plain.attachments=normalizeAttachments(plain);delete plain.supportingFile;delete plain.supportingName;delete plain.supportingAttachment;return plain}

export function captureWorkingVoucher(){const no=(document.getElementById('voucherNoInput') as HTMLInputElement).value.trim();if(!no&&!store.rows.length)return null;return{no,type:store.currentType,numberManual:store.numberManuallyEdited,date:(document.getElementById('voucherDate') as HTMLInputElement).value,desc:(document.getElementById('voucherDesc') as HTMLTextAreaElement).value,allocationInvoice:(document.getElementById('allocationInvoice') as HTMLInputElement).value.trim(),madeBy:(document.getElementById('madeBy') as HTMLInputElement).value.trim(),checkedBy:(document.getElementById('checkedBy') as HTMLInputElement).value.trim(),approvedBy:(document.getElementById('approvedBy') as HTMLInputElement).value.trim(),attachments:store.currentAttachments.map(item=>({...item})),lines:store.rows.map(line=>({...line}))}}

export async function createBackupPayload(){
  const working=captureWorkingVoucher();
  return{backupFormat:'toys-gallery-accounting',schemaVersion:2,appVersion:APP_VERSION,exportedAt:new Date().toISOString(),data:{
    vouchers:await Promise.all(store.vouchers.map(serializeVoucher)),accounts:cloneJSON(store.accounts),salesInvoices:cloneJSON(store.salesInvoices),purchaseInvoices:cloneJSON(store.purchaseInvoices),invoiceRemarks:cloneJSON(store.invoiceRemarks),allocations:cloneJSON(store.allocations),allocationReview:cloneJSON(store.allocationReview),fiscalYears:cloneJSON(store.fiscalYears),deletedDataYears:[...store.deletedDataYears],balanceAdjustments:cloneJSON(store.balanceAdjustments),openingBalances:cloneJSON(store.openingBalances),openingInvoiceDetails:cloneJSON(store.openingInvoiceDetails),reconciliationConfirmations:cloneJSON(store.reconciliationConfirmations),staffNames:[...store.staffNames],suppressedStaffNames:[...store.suppressedStaffNames],settings:{selectedFiscalKey:store.selectedFiscalKey,lastVoucherDates:cloneJSON(store.lastVoucherDates),reportState:cloneJSON(store.reportState),report:store.report,currentRoute:(document.querySelector('.view.active')||{}).id||'dashboard',editingIndex:store.editingIndex},workingVoucher:working?await serializeVoucher(working):null
  }};
}

export function validateBackup(payload: BackupPayload): BackupData{
  if(!payload||payload.backupFormat!=='toys-gallery-accounting'||![1,2].includes(Number(payload.schemaVersion))||!payload.data)throw new Error('這不是有效的 Toys Gallery JSON 備份檔。');
  const data=payload.data;
  if(!Array.isArray(data.accounts)||!data.accounts.length||!data.accounts.every(a=>a&&String(a.code||'').trim()&&String(a.name||'').trim()&&['資產','負債','權益','收入','成本','費用'].includes(a.type)))throw new Error('備份內的科目表不完整。');
  if(!Array.isArray(data.vouchers)||!data.vouchers.every(v=>v&&String(v.no||'').trim()&&/^\d{4}-\d{2}-\d{2}$/.test(String(v.date||''))&&Array.isArray(v.lines)&&v.lines.length>=2))throw new Error('備份內的 Voucher 資料不完整。');
  const voucherNos=data.vouchers.map(v=>String(v.no).toLowerCase());if(new Set(voucherNos).size!==voucherNos.length)throw new Error('備份內有重複的 Voucher number。');
  if(!Array.isArray(data.fiscalYears)||!data.fiscalYears.length||!data.fiscalYears.every(fy=>Number.isInteger(Number(fy.start))&&Number(fy.start)>=2000&&Number(fy.start)<=2099))throw new Error('備份內的財年資料不正確。');
  ['salesInvoices','purchaseInvoices','allocations','allocationReview','staffNames','suppressedStaffNames'].forEach(key=>{if(data[key]!==undefined&&!Array.isArray(data[key]))throw new Error('備份欄位 '+key+' 格式不正確。')});
  return data;
}

/**
 * schemaVersion 決定（方案2）：v2=整數分直接用；v1=美元浮點經 convertLegacyMoneyToCents
 * 轉分（見 money.ts；轉換欄數會記錄並顯示於還原摘要）。用版本號判別，唔用 heuristic。
 */
export async function prepareRestore(payload: BackupPayload): Promise<{prepared: BackupData;legacyConverted: number}>{const data=validateBackup(payload),prepared={...data};const legacyConverted=Number(payload.schemaVersion)===1?convertLegacyMoneyToCents(prepared):0;prepared.vouchers=data.vouchers.map(hydrateVoucher);prepared.workingVoucher=data.workingVoucher?hydrateVoucher(data.workingVoucher):null;prepared.fiscalYears=data.fiscalYears.map(fy=>makeFiscalYear(Number(fy.start))).filter((fy,i,list)=>list.findIndex(item=>item.key===fy.key)===i).sort((a,b)=>b.start-a.start);return{prepared,legacyConverted}}

export function restoreSummaryHTML(payload: BackupPayload,prepared: BackupData){const when=payload.exportedAt?new Date(payload.exportedAt).toLocaleString('zh-HK',{dateStyle:'medium',timeStyle:'short'}):'未提供',fileName=store.pendingRestore?store.pendingRestore.fileName:'JSON 備份',converted=store.pendingRestore&&store.pendingRestore.legacyConverted||0;return `<p>已讀取 <strong>${esc(fileName)}</strong>，請核對內容。</p><div class="restore-summary"><span>備份版本 <b>v${esc(payload.appVersion||'未知')}</b></span><span>匯出時間 <b>${esc(when)}</b></span><span>Voucher <b>${prepared.vouchers.length}</b> 張 · 科目 <b>${prepared.accounts.length}</b> 個 · 財年 <b>${prepared.fiscalYears.length}</b> 個</span></div>${converted?`<div class="modal-warning">舊版備份（schema v1）：已將 ${converted} 個金額欄位由美元轉為分（四捨五入到分），舊數據無遺失。</div>`:''}<div class="modal-warning">還原會覆蓋而家記憶體入面的全部資料。完成後請重新下載一份新備份。</div><p>第一次確認：按「繼續」查看最後確認。</p>`}

export function renderRestoreModal(){const body=(document.getElementById('restoreModalBody') as HTMLElement),button=(document.getElementById('confirmRestore') as HTMLButtonElement);(document.getElementById('restoreMessage') as HTMLElement).textContent='';if(!store.pendingRestore)return;if(store.restoreStep===1){body.innerHTML=restoreSummaryHTML(store.pendingRestore.payload,store.pendingRestore.prepared);button.textContent='繼續';button.className='btn danger'}else{body.innerHTML='<div class="modal-warning">第二次確認：確定用所選 JSON 備份覆蓋目前全部 Voucher、科目、期初數、發票、核對記錄、財年及設定？</div><p>此動作只改變今次開啟期間的記憶體資料，完成後不能在頁內復原。</p>';button.textContent='確認還原';button.className='btn danger'}}

export function closeRestore(){restoreModal.hidden=true;store.pendingRestore=null;store.restoreStep=1;restoreFileInput.value=''}

export function applyPreparedRestore(data: BackupData){
  replaceArray(store.accounts,data.accounts);sortAccounts();store.vouchers.splice(0,store.vouchers.length,...data.vouchers.map(voucher=>({...voucher,lines:voucher.lines.map(line=>({...line}))})));replaceArray(store.salesInvoices,data.salesInvoices||[]);replaceArray(store.purchaseInvoices,data.purchaseInvoices||[]);replaceObject(store.invoiceRemarks,data.invoiceRemarks||{});replaceArray(store.allocations,data.allocations||[]);replaceArray(store.allocationReview,data.allocationReview||[]);replaceObject(store.balanceAdjustments,data.balanceAdjustments||{});replaceObject(store.openingBalances,data.openingBalances||{});replaceObject(store.openingInvoiceDetails,data.openingInvoiceDetails||{});replaceObject(store.reconciliationConfirmations,data.reconciliationConfirmations||{});replaceSet(store.deletedDataYears,data.deletedDataYears||[]);replaceSet(store.staffNames,data.staffNames||[]);replaceSet(store.suppressedStaffNames,data.suppressedStaffNames||[]);replaceObject(store.lastVoucherDates,(data.settings&&data.settings.lastVoucherDates)||{});
  store.fiscalYears=data.fiscalYears;store.selectedFiscalKey=data.settings&&store.fiscalYears.some(fy=>fy.key===String(data.settings.selectedFiscalKey))?String(data.settings.selectedFiscalKey):store.fiscalYears[0].key;replaceObject(store.reportState,(data.settings&&data.settings.reportState)||{month:null,date:'',nameQuery:'',invoiceQuery:''});if(typeof store.reportState.month==='string')store.reportState.month=store.reportState.month==='all'?null:{key:store.reportState.month};store.report=reportNames[data.settings&&data.settings.report]?data.settings.report:'trial';document.querySelectorAll('[data-report]').forEach(button=>button.classList.toggle('active',(button as HTMLElement).dataset.report===store.report));
  closeDeleteFiscal();closeAccountEdit();closeOpeningInvoiceEditor();closeReconciliation();toggleFiscalManager(false);toggleOpeningManager(false);toggleStaffManager(false);renderStaffNames();refreshFiscalScope();
  const savedIndex=Number(data.settings&&data.settings.editingIndex),restoreIndex=Number.isInteger(savedIndex)&&savedIndex>=0&&savedIndex<store.vouchers.length?savedIndex:null;if(data.workingVoucher)setVoucher(data.workingVoucher,restoreIndex,true);const route=['dashboard','voucher','ledger','reports','accounts'].includes(data.settings&&data.settings.currentRoute)?data.settings.currentRoute:'dashboard';navigate(route);renderInvoiceNumberList();renderVoucherList();renderLedger();renderReport();renderAccounts();renderKPIs();
}
