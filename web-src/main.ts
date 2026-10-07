/**
 * 由 scripts/extract.js 自 v3.15 index.html 自動拆分。
 * 零功能變更：邏輯與原 IIFE 內文一致（全域狀態引用改為 store.*）。
 */
import { APP_VERSION } from './version';
import type { Cents } from './money';
import { accountEditModal } from './accounts';
import { accountForm } from './accounts';
import { accountFormMessage } from './accounts';
import { accountHasEntries } from './accounts';
import { accountsChanged } from './vouchers';
import { appShell } from './ui';
import { applyAccountEdit } from './accounts';
import { applyAllocation } from './state';
import { applyPreparedRestore } from './backup';
import { applyVoucherBalance } from './vouchers';
import { authorizedPasswordHash } from './ui';
import { backupButton } from './backup';
import { backupStatus } from './backup';
import { clearLoginError } from './ui';
import { clearVoucherAllocations } from './vouchers';
import { closeAccountEdit } from './accounts';
import { closeAttachmentList } from './vouchers';
import { closeDeleteAccount } from './accounts';
import { closeDeleteFiscal } from './fiscal-years';
import { closeOpeningInvoiceEditor } from './accounts';
import { closeReconciliation } from './reports';
import { closeRestore } from './backup';
import { copyBackupButton } from './backup';
import { copyTextToClipboard } from './ui';
import { createBackupPayload } from './backup';
import { createNewVoucher } from './vouchers';
import { dateInFiscalYear } from './state';
import { deleteAccountModal } from './accounts';
import { fileToAttachment } from './vouchers';
import { fiscalManager } from './fiscal-years';
import { fiscalYearForDate } from './core/fiscal';
import { genNumber } from './vouchers';
import { hashLoginPassword } from './ui';
import { loginError } from './ui';
import { loginForm } from './ui';
import { loginPassword } from './ui';
import { loginUser } from './ui';
import { makeFiscalYear } from './core/fiscal';
import { manageFiscalYears } from './fiscal-years';
import { manageOpeningBalances } from './accounts';
import { manageStaffNames } from './ui';
import { monthNumber } from './ui';
import { navigate } from './ui';
import { openDownloadPopup } from './ui';
import { openingInvoiceModal } from './accounts';
import { openingManager } from './accounts';
import { prepareRestore } from './backup';
import { readOpeningDraft } from './accounts';
import { reconcileDraftMetrics } from './reports';
import { reconcileKey } from './reports';
import { reconcileModal } from './reports';
import { refreshFiscalScope } from './fiscal-years';
import { renderAccounts } from './accounts';
import { renderCurrentAttachments } from './vouchers';
import { renderDeleteAccount } from './accounts';
import { renderDeleteFiscal } from './fiscal-years';
import { renderFiscalYears } from './fiscal-years';
import { renderInvoiceNumberList } from './vouchers';
import { renderKPIs } from './reports';
import { renderLedger } from './ledger';
import { renderOpeningInvoiceRows } from './accounts';
import { renderReconcileDraft } from './reports';
import { renderReport } from './reports';
import { renderRestoreModal } from './backup';
import { renderRows } from './vouchers';
import { renderStaffNames } from './ui';
import { renderVoucherList } from './vouchers';
import { restoreButton } from './backup';
import { restoreFileInput } from './backup';
import { restoreModal } from './backup';
import { saveReconcileRecords } from './reports';
import { selectedFiscalYear } from './state';
import { setSidebarCollapsed } from './ui';
import { setVoucher } from './vouchers';
import { showAccountForm } from './accounts';
import { sidebarToggle } from './ui';
import { sortAccounts } from './accounts';
import { staffManager } from './ui';
import { store } from './state';
import { toggleAccountForm } from './accounts';
import { toggleFiscalManager } from './fiscal-years';
import { toggleOpeningManager } from './accounts';
import { toggleStaffManager } from './ui';
import { updateAccountCodeGuide } from './accounts';
import { updateReconcileSummary } from './reports';
import { validate } from './vouchers';
import { validateOpeningBalances } from './accounts';
import { validateOpeningInvoiceDraft } from './accounts';
import { voucherNumberError } from './vouchers';

loginForm.addEventListener('submit',async event=>{event.preventDefault();clearLoginError();const submit=(loginForm.querySelector('[type="submit"]') as HTMLButtonElement);submit.disabled=true;try{const validUser=loginUser.value.trim()==='admin',validPassword=await hashLoginPassword(loginPassword.value);if(!validUser||validPassword!==authorizedPasswordHash){loginError.classList.add('show');loginUser.setAttribute('aria-invalid','true');loginPassword.setAttribute('aria-invalid','true');loginPassword.select();return}document.body.classList.add('authenticated');loginPassword.value='';(document.querySelector('.view.active h1') as HTMLElement | null)?.focus()}catch(error){loginError.textContent='暫時未能驗證登入資料，請重新載入後再試。';loginError.classList.add('show')}finally{submit.disabled=false}});

[loginUser,loginPassword].forEach(input=>input.addEventListener('input',clearLoginError));

sidebarToggle.addEventListener('click',()=>setSidebarCollapsed(!appShell.classList.contains('sidebar-collapsed')));

sortAccounts();

store.salesInvoices.forEach(r=>{const match=(store.invoiceRemarks[r[1]]||'').match(/paid on ([A-Za-z]{3}) (\d{4})/i);if(match)store.allocations.push({kind:'AR',invoiceNo:r[1],party:r[2],date:match[2]+'-'+monthNumber[match[1].toLowerCase()],amount:r[3],voucher:'Sales Report 備註',source:'來源備註（只提供月份）'})});

document.querySelectorAll('[data-route]').forEach(b=>b.addEventListener('click',()=>navigate((b as HTMLElement).dataset.route as string)));

;

renderInvoiceNumberList();

(document.getElementById('closeAttachmentModal') as HTMLButtonElement).addEventListener('click',closeAttachmentList);

(document.getElementById('attachmentModal') as HTMLElement).addEventListener('click',event=>{if((event.target as HTMLElement).id==='attachmentModal')closeAttachmentList()});

['madeBy','checkedBy','approvedBy'].forEach(id=>(document.getElementById(id) as HTMLInputElement).addEventListener('input',validate));

(document.getElementById('voucherNoInput') as HTMLInputElement).addEventListener('input',e=>{store.numberManuallyEdited=true;(document.getElementById('voucherNo') as HTMLElement).textContent=(e.target as HTMLInputElement).value.trim()||'—';validate()});

(document.getElementById('voucherSearch') as HTMLInputElement).addEventListener('input',renderVoucherList);

(document.getElementById('addRow') as HTMLButtonElement).addEventListener('click',()=>{store.rows.push({account:store.accounts[0].name,detail:'',debit:0 as Cents,credit:0 as Cents});renderRows()});

(document.getElementById('voucherDate') as HTMLInputElement).addEventListener('change',e=>{if((e.target as HTMLInputElement).value&&dateInFiscalYear((e.target as HTMLInputElement).value))store.lastVoucherDates[store.selectedFiscalKey]=(e.target as HTMLInputElement).value;genNumber()});

document.querySelectorAll('[data-vtype]').forEach(b=>b.addEventListener('click',()=>{store.currentType=(b as HTMLElement).dataset.vtype as string;document.querySelectorAll('[data-vtype]').forEach(x=>x.classList.toggle('active',x===b));(document.getElementById('voucherTitle') as HTMLElement).textContent=store.currentType==='B'?'BANK VOUCHER':'TRANSFER VOUCHER';genNumber()}));

(document.getElementById('voucherFile') as HTMLInputElement).addEventListener('change',async event=>{const files=[...((event.target as HTMLInputElement).files||[])];if(!files.length)return;const box=(document.getElementById('attachmentList') as HTMLElement);box.innerHTML='<div class="muted" style="font-size:11px">正在讀取附件…</div>';try{const added=await Promise.all(files.map(fileToAttachment));store.currentAttachments.push(...added);renderCurrentAttachments()}catch(error){renderCurrentAttachments();const note=document.createElement('div');note.className='form-message';note.textContent=(error as Error).message;box.appendChild(note)}});

manageStaffNames.addEventListener('click',()=>toggleStaffManager(staffManager.hidden));

(document.getElementById('closeStaffManager') as HTMLButtonElement).addEventListener('click',()=>toggleStaffManager(false));

(document.getElementById('loadBank') as HTMLButtonElement).addEventListener('click',()=>setVoucher(store.vouchers[0],0,true));

(document.getElementById('loadTransfer') as HTMLButtonElement).addEventListener('click',()=>setVoucher(store.vouchers[1],1,true));

(document.getElementById('newVoucher') as HTMLButtonElement).addEventListener('click',createNewVoucher);

(document.getElementById('postBtn') as HTMLButtonElement).addEventListener('click',()=>{if(voucherNumberError())return validate();const v={no:(document.getElementById('voucherNoInput') as HTMLInputElement).value.trim(),type:store.currentType,numberManual:store.numberManuallyEdited,date:(document.getElementById('voucherDate') as HTMLInputElement).value,desc:(document.getElementById('voucherDesc') as HTMLTextAreaElement).value||'—',allocationInvoice:(document.getElementById('allocationInvoice') as HTMLInputElement).value.trim(),madeBy:(document.getElementById('madeBy') as HTMLInputElement).value.trim(),checkedBy:(document.getElementById('checkedBy') as HTMLInputElement).value.trim(),approvedBy:(document.getElementById('approvedBy') as HTMLInputElement).value.trim(),attachments:store.currentAttachments.map(item=>({...item})),lines:store.rows.map(x=>({...x}))};const wasEditing=store.editingIndex!==null,savedIndex=wasEditing?(store.editingIndex as number):store.vouchers.length,old=wasEditing?store.vouchers[savedIndex]:null;if(old){applyVoucherBalance(old,-1);clearVoucherAllocations(old.no);store.vouchers[savedIndex]=v}else store.vouchers.push(v);store.editingIndex=savedIndex;applyVoucherBalance(v,1);store.lastVoucherDates[fiscalYearForDate(v.date).key]=v.date;[v.madeBy,v.checkedBy,v.approvedBy].forEach(name=>{if(name&&!store.suppressedStaffNames.has(name))store.staffNames.add(name)});renderStaffNames();const needsReview=applyAllocation(v);(document.getElementById('ledgerCount') as HTMLElement).textContent=String(store.vouchers.filter(item=>dateInFiscalYear(item.date)).length);renderVoucherList();renderLedger();renderReport();renderAccounts();renderKPIs();setVoucher(v,savedIndex,true);const toast=(document.getElementById('postToast') as HTMLElement);toast.textContent=needsReview?'⚠ '+v.no+' 已'+(wasEditing?'重新':'')+'過賬；對銷差額標示為「待核對」，系統未建立夾數科目。':'✓ '+v.no+' 已'+(wasEditing?'儲存修改、重新':'')+'過賬及完成發票對銷；已停留在本張 Voucher，Ledger 及報表已更新。';toast.style.color=needsReview?'var(--warn)':'var(--good)';toast.classList.add('show');});

(document.getElementById('ledgerAccount') as HTMLSelectElement).addEventListener('change',renderLedger);

document.querySelectorAll('[data-report]').forEach(b=>b.addEventListener('click',()=>{store.report=(b as HTMLElement).dataset.report as string;document.querySelectorAll('[data-report]').forEach(x=>x.classList.toggle('active',x===b));renderReport()}));

showAccountForm.addEventListener('click',()=>toggleAccountForm(accountForm.hidden));

(document.getElementById('newAccountType') as HTMLSelectElement).addEventListener('change',()=>updateAccountCodeGuide(true));

(document.getElementById('cancelAccountForm') as HTMLButtonElement).addEventListener('click',()=>toggleAccountForm(false));

accountForm.addEventListener('submit',e=>{
  e.preventDefault();
  const code=(document.getElementById('newAccountCode') as HTMLInputElement).value.trim(),name=(document.getElementById('newAccountName') as HTMLInputElement).value.trim(),type=(document.getElementById('newAccountType') as HTMLSelectElement).value;
  let error='';
  if(!code||!name||!type)error='請填寫科目編號、科目名稱及類別。';
  else if(!/^[A-Za-z0-9][A-Za-z0-9-]{0,19}$/.test(code))error='科目編號只可用英文字母、數字及連字號，最多 20 個字元。';
  else if(store.accounts.some(a=>a.code.toLowerCase()===code.toLowerCase()))error='此科目編號已存在，請使用另一個編號。';
  else if(store.accounts.some(a=>a.name.toLowerCase()===name.toLowerCase()))error='此科目名稱已存在，請使用另一個名稱。';
  if(error){accountFormMessage.textContent=error;accountFormMessage.className='form-message';return}
  const side=(type==='資產'||type==='費用'||type==='成本')?'dr':'cr';
  store.accounts.push({code,name,type,balance:0 as Cents,importedBalance:0 as Cents,side,custom:true,createdFiscalKey:store.selectedFiscalKey});
  accountForm.reset();
  updateAccountCodeGuide();
  accountFormMessage.textContent=`✓ 已新增 ${code} · ${name}，可即時用於 Voucher、General Ledger 及相關報表。`;
  accountFormMessage.className='form-message success';
  accountsChanged();
  (document.getElementById('newAccountCode') as HTMLInputElement).focus();
});

(document.getElementById('accountSearch') as HTMLInputElement).addEventListener('input',renderAccounts);

(document.getElementById('accountType') as HTMLSelectElement).addEventListener('change',renderAccounts);

manageOpeningBalances.addEventListener('click',()=>toggleOpeningManager(openingManager.hidden));

(document.getElementById('closeOpeningManager') as HTMLButtonElement).addEventListener('click',()=>toggleOpeningManager(false));

(document.getElementById('saveOpeningBalances') as HTMLButtonElement).addEventListener('click',()=>{if(!validateOpeningBalances())return;const fy=selectedFiscalYear();store.openingBalances[fy.key]=readOpeningDraft();renderLedger();renderReport();renderAccounts();renderKPIs();const state=(document.getElementById('openingBalanceState') as HTMLElement);state.className='opening-status ok';state.textContent=`✓ ${fy.label} 期初數已儲存，Ledger 及報表已更新`;});

(document.getElementById('fiscalYearSelect') as HTMLSelectElement).addEventListener('change',e=>{store.selectedFiscalKey=(e.target as HTMLInputElement).value;refreshFiscalScope()});

manageFiscalYears.addEventListener('click',()=>toggleFiscalManager(fiscalManager.hidden));

(document.getElementById('closeFiscalManager') as HTMLButtonElement).addEventListener('click',()=>toggleFiscalManager(false));

(document.getElementById('fiscalYearForm') as HTMLFormElement).addEventListener('submit',e=>{e.preventDefault();const input=(document.getElementById('fiscalStartYear') as HTMLInputElement),message=(document.getElementById('fiscalFormMessage') as HTMLElement),start=Number(input.value);message.className='form-message';if(!Number.isInteger(start)||start<2000||start>2099){message.textContent='請輸入 2000 至 2099 之間的開始年份。';return}if(store.fiscalYears.some(fy=>fy.start===start)){message.textContent=`FY${start}/${String(start+1).slice(-2)} 已存在。`;return}const fy=makeFiscalYear(start);store.fiscalYears.push(fy);store.fiscalYears.sort((a,b)=>b.start-a.start);store.selectedFiscalKey=fy.key;input.value='';message.textContent=`✓ 已新增並切換至 ${fy.label}。`;message.className='form-message success';refreshFiscalScope();toggleFiscalManager(false);toggleOpeningManager(true)});

(document.getElementById('cancelDeleteFiscal') as HTMLButtonElement).addEventListener('click',closeDeleteFiscal);

(document.getElementById('deleteFiscalModal') as HTMLElement).addEventListener('click',e=>{if((e.target as HTMLElement).id==='deleteFiscalModal')closeDeleteFiscal()});

(document.getElementById('confirmDeleteFiscal') as HTMLButtonElement).addEventListener('click',()=>{if(!store.deleteFiscalCandidate)return;if(store.deleteFiscalStep===1){store.deleteFiscalStep=2;renderDeleteFiscal();return}const fy=store.deleteFiscalCandidate,removedNos=new Set(store.vouchers.filter(v=>dateInFiscalYear(v.date,fy)).map(v=>v.no));for(let i=store.vouchers.length-1;i>=0;i--)if(dateInFiscalYear(store.vouchers[i].date,fy))store.vouchers.splice(i,1);for(let i=store.salesInvoices.length-1;i>=0;i--)if(dateInFiscalYear(store.salesInvoices[i][0],fy))store.salesInvoices.splice(i,1);for(let i=store.purchaseInvoices.length-1;i>=0;i--)if(dateInFiscalYear(store.purchaseInvoices[i][0],fy))store.purchaseInvoices.splice(i,1);for(let i=store.allocations.length-1;i>=0;i--)if(removedNos.has(store.allocations[i].voucher)||dateInFiscalYear(store.allocations[i].date,fy))store.allocations.splice(i,1);for(let i=store.allocationReview.length-1;i>=0;i--)if(removedNos.has(store.allocationReview[i].voucher))store.allocationReview.splice(i,1);delete store.balanceAdjustments[fy.key];delete store.openingBalances[fy.key];delete store.openingInvoiceDetails[fy.key];store.deletedDataYears.add(fy.key);store.fiscalYears=store.fiscalYears.filter(x=>x.key!==fy.key);if(store.selectedFiscalKey===fy.key)store.selectedFiscalKey=store.fiscalYears[0].key;closeDeleteFiscal();refreshFiscalScope()});

(document.getElementById('saveAccountEdit') as HTMLButtonElement).addEventListener('click',()=>{if(!store.editingAccount)return;const name=(document.getElementById('editAccountName') as HTMLInputElement).value.trim(),type=(document.getElementById('editAccountType') as HTMLSelectElement).value,message=(document.getElementById('accountEditMessage') as HTMLElement);message.className='form-message';if(!name||!type){message.textContent='請填寫科目名稱及類別。';return}if(store.accounts.some(a=>a!==store.editingAccount&&a.name.toLowerCase()===name.toLowerCase())){message.textContent='此科目名稱已存在，請使用另一個名稱。';return}if(name===store.editingAccount.name&&type===store.editingAccount.type){closeAccountEdit();return}if(store.accountEditStep===1&&accountHasEntries(store.editingAccount)){store.accountEditStep=2;const warning=(document.getElementById('accountEditWarning') as HTMLElement);warning.hidden=false;warning.textContent='此科目已有匯入結餘、期初數或 Voucher 分錄。確認後，現有分錄會保留並轉用新名稱／類別，所有報表位置會即時更新。';(document.getElementById('saveAccountEdit') as HTMLButtonElement).textContent='確認並更新所有報表';return}applyAccountEdit()});

(document.getElementById('cancelAccountEdit') as HTMLButtonElement).addEventListener('click',closeAccountEdit);

accountEditModal.addEventListener('click',e=>{if(e.target===accountEditModal)closeAccountEdit()});

['editAccountName','editAccountType'].forEach(id=>(document.getElementById(id) as HTMLElement).addEventListener('input',()=>{if(store.accountEditStep===2){store.accountEditStep=1;(document.getElementById('accountEditWarning') as HTMLElement).hidden=true;(document.getElementById('saveAccountEdit') as HTMLButtonElement).textContent='儲存修改'}}));

(document.getElementById('cancelDeleteAccount') as HTMLButtonElement).addEventListener('click',closeDeleteAccount);

deleteAccountModal.addEventListener('click',event=>{if(event.target===deleteAccountModal)closeDeleteAccount()});

(document.getElementById('confirmDeleteAccount') as HTMLButtonElement).addEventListener('click',()=>{if(!store.deletingAccount)return;if(store.deleteAccountUsage.length){closeDeleteAccount();return}if(store.deleteAccountStep===1){store.deleteAccountStep=2;renderDeleteAccount();return}const code=store.deletingAccount.code,name=store.deletingAccount.name,index=store.accounts.indexOf(store.deletingAccount);if(index>=0)store.accounts.splice(index,1);[store.openingBalances,store.openingInvoiceDetails,store.balanceAdjustments].forEach(store=>Object.values(store).forEach(year=>{if(year)delete year[name]}));closeDeleteAccount();updateAccountCodeGuide();renderInvoiceNumberList();accountsChanged();accountFormMessage.textContent=`✓ 已刪除 ${code} · ${name}，Voucher 科目搜尋、Ledger 及報表已更新。`;accountFormMessage.className='form-message success'});

(document.getElementById('addOpeningInvoice') as HTMLButtonElement).addEventListener('click',()=>{store.openingInvoiceDraft.push({date:selectedFiscalYear().from,invoiceNo:'',amount:0 as Cents});renderOpeningInvoiceRows();const rows=document.querySelectorAll('.invoice-editor-row');if(rows.length)(rows[rows.length-1].querySelector('.invoice-number') as HTMLInputElement).focus()});

(document.getElementById('saveOpeningInvoice') as HTMLButtonElement).addEventListener('click',()=>{if(!validateOpeningInvoiceDraft())return;const accountName=store.openingInvoiceAccount,count=store.openingInvoiceDraft.length;store.openingInvoiceDetails[store.selectedFiscalKey]??={};if(count)store.openingInvoiceDetails[store.selectedFiscalKey][accountName]=store.openingInvoiceDraft.map(item=>({...item,invoiceNo:item.invoiceNo.trim()}));else delete store.openingInvoiceDetails[store.selectedFiscalKey][accountName];closeOpeningInvoiceEditor();const row=[...document.querySelectorAll('#openingBalanceBody tr[data-account]')].find(el=>(el as HTMLElement).dataset.account===accountName),button=row&&row.querySelector('.opening-detail-btn');if(button)button.textContent=count?'修改 '+count+' 張':'＋ 拆分發票';validateOpeningBalances();renderInvoiceNumberList();renderReport()});

(document.getElementById('cancelOpeningInvoice') as HTMLButtonElement).addEventListener('click',closeOpeningInvoiceEditor);

openingInvoiceModal.addEventListener('click',e=>{if(e.target===openingInvoiceModal)closeOpeningInvoiceEditor()});

(document.getElementById('addReconcileInvoice') as HTMLButtonElement).addEventListener('click',()=>{if(!store.reconciliationContext)return;const fy=selectedFiscalYear(),date=store.reconciliationContext.month===null?fy.from:store.reconciliationContext.month.key+'-01';store.reconcileInvoiceDraft.push({date,invoiceNo:'',amount:0 as Cents,origin:'invoice'});renderReconcileDraft();const inputs=document.querySelectorAll('.recon-invoice-no');if(inputs.length)(inputs[inputs.length-1] as HTMLInputElement).focus()});

(document.getElementById('addReconcilePayment') as HTMLButtonElement).addEventListener('click',()=>{if(!store.reconcileInvoiceDraft.length){const message=(document.getElementById('reconcileMessage') as HTMLElement);message.textContent='請先新增發票，收／付款記錄需要選擇對銷發票。';message.className='form-message';return}const date=store.reconciliationContext!.month===null?selectedFiscalYear().from:store.reconciliationContext!.month.key+'-01';store.reconcilePaymentDraft.push({date,voucher:'',invoiceNo:store.reconcileInvoiceDraft[0].invoiceNo,amount:0 as Cents,source:'人工記錄'});renderReconcileDraft();const inputs=document.querySelectorAll('.recon-payment-voucher');if(inputs.length)(inputs[inputs.length-1] as HTMLInputElement).focus()});

(document.getElementById('saveReconcileRecords') as HTMLButtonElement).addEventListener('click',()=>{if(saveReconcileRecords())updateReconcileSummary()});

(document.getElementById('confirmReconcile') as HTMLButtonElement).addEventListener('click',()=>{if(!store.reconciliationContext)return;const confirmedBy=(document.getElementById('reconcileConfirmedBy') as HTMLInputElement).value.trim(),date=(document.getElementById('reconcileConfirmedDate') as HTMLInputElement).value,note=(document.getElementById('reconcileNote') as HTMLTextAreaElement).value.trim(),message=(document.getElementById('reconcileMessage') as HTMLElement);if(!confirmedBy||!date){message.textContent='請填寫確認人及確認日期。';message.className='form-message';return}if(!saveReconcileRecords())return;const metrics=reconcileDraftMetrics(),key=reconcileKey(store.reconciliationContext.kind,store.reconciliationContext.party,store.reconciliationContext.month);store.reconciliationConfirmations[key]={confirmedBy,date,note,invoiceOutstanding:metrics.invoiceOutstanding,accountBalance:metrics.accountBalance,difference:metrics.difference};renderReport();closeReconciliation()});

(document.getElementById('cancelReconcile') as HTMLButtonElement).addEventListener('click',closeReconciliation);

reconcileModal.addEventListener('click',e=>{if(e.target===reconcileModal)closeReconciliation()});

backupButton.addEventListener('click',async()=>{backupButton.disabled=true;copyBackupButton.disabled=true;backupStatus.textContent='正在整理全部資料及附件…';try{const payload=await createBackupPayload(),stamp=payload.exportedAt.slice(0,19).replace(/[:T]/g,'-'),blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json;charset=utf-8'}),filename=`Toys-Gallery-backup-v${APP_VERSION}-${stamp}.json`,opened=openDownloadPopup(blob,filename,'備份檔下載');backupStatus.textContent=opened?`已開新視窗，請喺新視窗撳「撳呢度下載」完成下載 · ${store.vouchers.length} 張 Voucher`:'瀏覽器阻擋咗新視窗，請用旁邊的「複製備份內容」掣'}catch(error){backupStatus.textContent='備份失敗：'+(error as Error).message}finally{backupButton.disabled=false;copyBackupButton.disabled=false}});

copyBackupButton.addEventListener('click',async()=>{backupButton.disabled=true;copyBackupButton.disabled=true;backupStatus.textContent='正在整理全部資料及附件…';try{const payload=await createBackupPayload();backupStatus.textContent='正在複製完整 JSON 備份…';await copyTextToClipboard(JSON.stringify(payload,null,2),backupStatus)}catch(error){backupStatus.textContent='複製備份失敗：'+(error as Error).message}finally{backupButton.disabled=false;copyBackupButton.disabled=false}});

restoreButton.addEventListener('click',()=>{restoreFileInput.value='';restoreFileInput.click()});

restoreFileInput.addEventListener('change',async()=>{const file=(restoreFileInput.files||[])[0];if(!file)return;if(file.size>100*1024*1024){backupStatus.textContent='還原失敗：JSON 備份超過 100 MB。';restoreFileInput.value='';return}restoreButton.disabled=true;backupStatus.textContent='正在檢查備份檔…';try{const payload=JSON.parse(await file.text()),{prepared,legacyConverted}=await prepareRestore(payload);store.pendingRestore={fileName:file.name,payload,prepared,legacyConverted};store.restoreStep=1;renderRestoreModal();restoreModal.hidden=false;(document.getElementById('confirmRestore') as HTMLButtonElement).focus();backupStatus.textContent='備份檔已驗證，等待二次確認'}catch(error){backupStatus.textContent='還原失敗：'+(error as Error).message;restoreFileInput.value=''}finally{restoreButton.disabled=false}});

(document.getElementById('cancelRestore') as HTMLButtonElement).addEventListener('click',closeRestore);

restoreModal.addEventListener('click',event=>{if(event.target===restoreModal)closeRestore()});

(document.getElementById('confirmRestore') as HTMLButtonElement).addEventListener('click',()=>{if(!store.pendingRestore)return;if(store.restoreStep===1){store.restoreStep=2;renderRestoreModal();return}try{const count=store.pendingRestore.prepared.vouchers.length;applyPreparedRestore(store.pendingRestore.prepared);closeRestore();backupStatus.textContent=`✓ 已還原 ${count} 張 Voucher；請立即下載新備份`}catch(error){(document.getElementById('restoreMessage') as HTMLElement).textContent='還原失敗：'+(error as Error).message}});

renderStaffNames();

renderFiscalYears();

refreshFiscalScope();
