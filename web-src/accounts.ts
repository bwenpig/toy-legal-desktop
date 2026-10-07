/**
 * 由 scripts/extract.js 自 v3.15 index.html 自動拆分。
 * 零功能變更：邏輯與原 IIFE 內文一致（全域狀態引用改為 store.*）。
 */
import type { Account, OpeningEntry, OpeningInvoiceStatus } from './types';
import type { Cents } from './money';
import { fromCents, toCents } from './money';
import { accountBalance } from './ledger';
import { accountCodeCollator } from './ui';
import { accountsChanged } from './vouchers';
import { balanceLabel } from './ledger';
import { esc } from './ui';
import { fiscalYearForDate } from './core/fiscal';
import { fmt } from './ui';
import { makeFiscalYear } from './core/fiscal';
import { openingEntry } from './state';
import { openingInvoiceStatus } from './state';
import { renderVoucherList } from './vouchers';
import { selectedFiscalYear } from './state';
import { signedFmt } from './ui';
import { store } from './state';
import { toggleFiscalManager } from './fiscal-years';

export const sortAccounts=()=>store.accounts.sort((a,b)=>accountCodeCollator.compare(a.code,b.code)||a.name.localeCompare(b.name,'en',{sensitivity:'base'}));

export const accountForm=(document.getElementById('accountForm') as HTMLFormElement);

export const showAccountForm=(document.getElementById('showAccountForm') as HTMLButtonElement);

export const accountFormMessage=(document.getElementById('accountFormMessage') as HTMLElement);

export function updateAccountCodeGuide(prefill=false){const type=(document.getElementById('newAccountType') as HTMLSelectElement).value,codeInput=(document.getElementById('newAccountCode') as HTMLInputElement),same=store.accounts.filter(a=>!type||a.type===type).sort((a,b)=>accountCodeCollator.compare(a.code,b.code)),numeric=same.map(a=>Number(a.code)).filter(Number.isFinite),suggested=numeric.length?String(Math.ceil((Math.max(...numeric)+1)/10)*10):({資產:'1000',負債:'2000',權益:'3000',收入:'4000',成本:'5000',費用:'6000'}[type]||'');(document.getElementById('accountCodeSuggestion') as HTMLElement).textContent=type?`${type}類下一個建議編號：${suggested||'請自行輸入'}`:'先選擇類別，系統會建議下一個可用編號。';(document.getElementById('usedAccountCodes') as HTMLElement).innerHTML=(same.length?same:store.accounts).map(a=>`<span title="${esc(a.name)}">${esc(a.code)}</span>`).join('');if(prefill&&suggested&&!codeInput.value.trim())codeInput.value=suggested}

export function toggleAccountForm(open: boolean){accountForm.hidden=!open;showAccountForm.setAttribute('aria-expanded',String(open));if(open){accountFormMessage.textContent='';accountFormMessage.className='form-message';updateAccountCodeGuide();(document.getElementById('newAccountType') as HTMLSelectElement).focus()}}

export function renderAccounts(){sortAccounts();const q=(document.getElementById('accountSearch') as HTMLInputElement).value.toLowerCase(),type=(document.getElementById('accountType') as HTMLSelectElement).value,filtered=store.accounts.filter(a=>(!q||a.name.toLowerCase().includes(q)||a.code.includes(q))&&(!type||a.type===type)),body=(document.getElementById('accountBody') as HTMLTableSectionElement);(document.getElementById('accountCount') as HTMLElement).textContent=String(store.accounts.length);body.innerHTML=filtered.map(a=>{const balance=accountBalance(a);return `<tr><td data-label="編碼">${a.code}</td><td data-label="科目名稱"><b>${esc(a.name)}</b></td><td data-label="類別"><span class="type-tag">${a.type}</span></td><td class="num" data-label="所選財年結餘">${balance?balanceLabel(a):'—'}</td><td data-label="狀態"><span class="status-tag">啟用</span></td><td data-label="操作"><div class="account-row-actions"><button class="btn edit-account" type="button" data-code="${esc(a.code)}">修改</button><button class="btn danger delete-account" type="button" data-code="${esc(a.code)}">刪除</button></div></td></tr>`}).join('')||`<tr><td colspan="6" class="empty">找不到相符科目</td></tr>`;body.querySelectorAll('.edit-account').forEach(btn=>btn.addEventListener('click',()=>openAccountEdit((btn as HTMLElement).dataset.code)));body.querySelectorAll('.delete-account').forEach(btn=>btn.addEventListener('click',()=>openDeleteAccount((btn as HTMLElement).dataset.code)))}

export const openingManager=(document.getElementById('openingManager') as HTMLElement);

export const manageOpeningBalances=(document.getElementById('manageOpeningBalances') as HTMLButtonElement);

export function openingProgressHTML(status: OpeningInvoiceStatus | null,drill=false){if(!status||status.state==='unsplit')return'';const pending=status.state==='pending',label=pending?'待完成':'已完成';return `<div class="opening-progress ${pending?'pending':'complete'}${drill?' drill':''}"><div><span class="${pending?'review-tag':'status-tag'}">${label}</span><strong>仲差 HK$ ${signedFmt(status.difference)}</strong></div><small>期初發票明細狀態：${label}</small></div>`}

export function readOpeningDraft(): Record<string, OpeningEntry>{const draft: Record<string, OpeningEntry>={};document.querySelectorAll('#openingBalanceBody tr[data-account]').forEach(row=>{const debit=toCents((row.querySelector('.opening-debit') as HTMLInputElement).value),credit=toCents((row.querySelector('.opening-credit') as HTMLInputElement).value);if(debit||credit)draft[(row as HTMLElement).dataset.account as string]={debit,credit}});return draft}

export function openingDetailCheck(row: Element){const accountName=((row as HTMLElement).dataset.account as string),kind=accountName.startsWith('Accounts Receivable of ')?'AR':accountName.startsWith('Accounts Payable of ')?'AP':'',expected=kind==='AR'?toCents((row.querySelector('.opening-debit') as HTMLInputElement).value):toCents((row.querySelector('.opening-credit') as HTMLInputElement).value);return openingInvoiceStatus(accountName,selectedFiscalYear(),expected)}

export function validateOpeningBalances(){let dr=0 as Cents,cr=0 as Cents;document.querySelectorAll('#openingBalanceBody tr[data-account]').forEach(row=>{dr=(dr+toCents((row.querySelector('.opening-debit') as HTMLInputElement).value)) as Cents;cr=(cr+toCents((row.querySelector('.opening-credit') as HTMLInputElement).value)) as Cents;const target=row.querySelector('.opening-detail-state');if(target)target.innerHTML=openingProgressHTML(openingDetailCheck(row))});const balanced=dr===cr,state=(document.getElementById('openingBalanceState') as HTMLElement);state.className='opening-status '+(balanced?'ok':'bad');state.textContent=balanced?'✓ 借貸平衡':'差額 HK$ '+fmt(dr-cr)+' '+(dr>cr?'Dr':'Cr');(document.getElementById('openingBalanceTotals') as HTMLElement).textContent=`Dr ${fmt(dr)} · Cr ${fmt(cr)}`;(document.getElementById('saveOpeningBalances') as HTMLButtonElement).disabled=!balanced;return balanced}

export function bindOpeningInputs(){document.querySelectorAll('#openingBalanceBody tr[data-account]').forEach(row=>{const debit=(row.querySelector('.opening-debit') as HTMLInputElement),credit=(row.querySelector('.opening-credit') as HTMLInputElement);debit.addEventListener('input',()=>{if(toCents(debit.value)>0)credit.value='';validateOpeningBalances()});credit.addEventListener('input',()=>{if(toCents(credit.value)>0)debit.value='';validateOpeningBalances()})});document.querySelectorAll('.opening-detail-btn').forEach(btn=>btn.addEventListener('click',()=>openOpeningInvoiceEditor((btn as HTMLElement).dataset.account as string)))}

export function renderOpeningBalances(){const fy=selectedFiscalYear();(document.getElementById('openingFiscalLabel') as HTMLElement).textContent=`${fy.label} · ${fy.from} 期初`;(document.getElementById('openingBalanceBody') as HTMLTableSectionElement).innerHTML=store.accounts.map(a=>{const value=openingEntry(fy,a.name),canDetail=a.name.startsWith('Accounts Receivable of ')||a.name.startsWith('Accounts Payable of '),detailCount=((store.openingInvoiceDetails[fy.key]&&store.openingInvoiceDetails[fy.key][a.name])||[]).length,detailStatus=canDetail?openingInvoiceStatus(a.name,fy):null;return `<tr data-account="${esc(a.name)}"><td data-label="編碼">${esc(a.code)}</td><td data-label="會計科目"><b>${esc(a.name)}</b></td><td data-label="類別"><span class="type-tag">${esc(a.type)}</span></td><td class="num" data-label="期初借方"><input class="opening-input opening-debit" type="number" min="0" step="0.01" inputmode="decimal" aria-label="${esc(a.name)} 期初借方" value="${value.debit?fromCents(value.debit):''}" placeholder="0.00"></td><td class="num" data-label="期初貸方"><input class="opening-input opening-credit" type="number" min="0" step="0.01" inputmode="decimal" aria-label="${esc(a.name)} 期初貸方" value="${value.credit?fromCents(value.credit):''}" placeholder="0.00"></td><td data-label="發票明細">${canDetail?`<div class="opening-detail-cell"><button class="btn opening-detail-btn" type="button" data-account="${esc(a.name)}">${detailCount?'修改 '+detailCount+' 張':'＋ 拆分發票'}</button><div class="opening-detail-state">${openingProgressHTML(detailStatus)}</div></div>`:'—'}</td></tr>`}).join('');bindOpeningInputs();validateOpeningBalances()}

export function toggleOpeningManager(open: boolean){openingManager.hidden=!open;manageOpeningBalances.setAttribute('aria-expanded',String(open));if(open){toggleFiscalManager(false);renderOpeningBalances()}}

export const accountEditModal=(document.getElementById('accountEditModal') as HTMLElement);

export function accountHasEntries(account: Account){return Boolean(account.importedBalance||store.vouchers.some(v=>v.lines.some(line=>line.account===account.name))||Object.values(store.openingBalances).some(store=>store&&store[account.name]))}

export function openAccountEdit(code: string | undefined){store.editingAccount=store.accounts.find(a=>a.code===code);if(!store.editingAccount)return;store.accountEditStep=1;(document.getElementById('editAccountCode') as HTMLInputElement).value=store.editingAccount.code;(document.getElementById('editAccountName') as HTMLInputElement).value=store.editingAccount.name;(document.getElementById('editAccountType') as HTMLSelectElement).value=store.editingAccount.type;(document.getElementById('accountEditMessage') as HTMLElement).textContent='';(document.getElementById('accountEditWarning') as HTMLElement).hidden=true;(document.getElementById('saveAccountEdit') as HTMLButtonElement).textContent='儲存修改';accountEditModal.hidden=false;(document.getElementById('editAccountName') as HTMLInputElement).focus()}

export function closeAccountEdit(){accountEditModal.hidden=true;store.editingAccount=null;store.accountEditStep=1}

export function moveNamedKey(store: Record<string, Record<string, unknown>>,oldName: string,newName: string){Object.values(store).forEach(year=>{if(year&&Object.prototype.hasOwnProperty.call(year,oldName)){year[newName]=year[oldName];delete year[oldName]}})}

export function applyAccountEdit(){if(!store.editingAccount)return;const oldName=store.editingAccount.name,newName=(document.getElementById('editAccountName') as HTMLInputElement).value.trim(),newType=(document.getElementById('editAccountType') as HTMLSelectElement).value;store.vouchers.forEach(v=>v.lines.forEach(line=>{if(line.account===oldName)line.account=newName}));moveNamedKey(store.openingBalances,oldName,newName);moveNamedKey(store.openingInvoiceDetails,oldName,newName);moveNamedKey(store.balanceAdjustments,oldName,newName);store.rows.forEach(line=>{if(line.account===oldName)line.account=newName});store.editingAccount.originalName??=oldName;store.editingAccount.name=newName;const oldSide=store.editingAccount.side,newSide=(newType==='資產'||newType==='費用'||newType==='成本')?'dr':'cr';if(oldSide!==newSide){store.editingAccount.balance=(-store.editingAccount.balance) as Cents;store.editingAccount.importedBalance=(-store.editingAccount.importedBalance) as Cents;Object.values(store.balanceAdjustments).forEach(year=>{if(year&&Object.prototype.hasOwnProperty.call(year,newName))year[newName]=(-year[newName]) as Cents})}store.editingAccount.type=newType;store.editingAccount.side=newSide;store.editingAccount.custom=true;store.editingAccount.edited=true;closeAccountEdit();accountsChanged();renderVoucherList();if(!openingManager.hidden)renderOpeningBalances()}

export const deleteAccountModal=(document.getElementById('deleteAccountModal') as HTMLElement);

export function fiscalNameForKey(key: string){const saved=store.fiscalYears.find(fy=>fy.key===String(key)),start=Number(key);return saved?saved.label:Number.isFinite(start)?makeFiscalYear(start).label:String(key)}

export function accountUsageLocations(account: Account){
  const usage=[],name=account.name,voucherMatches=store.vouchers.filter(v=>v.lines.some(line=>line.account===name));
  const voucherYears=[...new Set(voucherMatches.map(v=>fiscalYearForDate(v.date).key))];
  voucherYears.forEach(key=>{const matches=voucherMatches.filter(v=>fiscalYearForDate(v.date).key===key),sample=matches.slice(0,5).map(v=>v.no).join('、'),more=matches.length>5?` 等 ${matches.length} 張`:'';usage.push(`Voucher 分錄：${fiscalNameForKey(key)}（${sample}${more}）`)});
  Object.entries(store.openingBalances).forEach(([key,store])=>{if(store&&Object.prototype.hasOwnProperty.call(store,name))usage.push(`期初數：${fiscalNameForKey(key)}`)});
  Object.entries(store.openingInvoiceDetails).forEach(([key,store])=>{const items=store&&store[name];if(Array.isArray(items)&&items.length)usage.push(`期初發票明細：${fiscalNameForKey(key)}（${items.length} 張）`)});
  if(account.importedBalance)usage.push('來源工作簿匯入結餘：FY2023/24');
  Object.entries(store.balanceAdjustments).forEach(([key,store])=>{if(store&&store[name]&&!voucherYears.includes(String(key)))usage.push(`已過賬結餘：${fiscalNameForKey(key)}`)});
  if(store.rows.some(line=>line.account===name))usage.push('目前未過賬的 Voucher 分錄');
  return usage;
}

export function renderDeleteAccount(){if(!store.deletingAccount)return;
  const title=(document.getElementById('deleteAccountTitle') as HTMLElement),body=(document.getElementById('deleteAccountBody') as HTMLElement),cancel=(document.getElementById('cancelDeleteAccount') as HTMLButtonElement),button=(document.getElementById('confirmDeleteAccount') as HTMLButtonElement);
  if(store.deleteAccountUsage.length){title.textContent='無法刪除會計科目';body.innerHTML=`<p><strong>${esc(store.deletingAccount.code)} · ${esc(store.deletingAccount.name)}</strong> 正在以下位置使用：</p><div class="modal-warning"><ul>${store.deleteAccountUsage.map(item=>`<li>${esc(item)}</li>`).join('')}</ul></div><p>請先移除相關分錄／期初資料，之後先可以刪除呢個科目。</p>`;cancel.hidden=true;button.textContent='知道';button.className='btn primary';return}
  cancel.hidden=false;button.className='btn danger';
  if(store.deleteAccountStep===1){title.textContent='刪除會計科目';body.innerHTML=`<p>你正準備刪除 <strong>${esc(store.deletingAccount.code)} · ${esc(store.deletingAccount.name)}</strong>。</p><p>系統已檢查所有財年：未有 Voucher 分錄、期初數或期初發票明細。按「繼續」進入第二次確認。</p>`;button.textContent='繼續'}else{title.textContent='再次確認刪除';body.innerHTML=`<div class="modal-warning">第二次確認：確定刪除 ${esc(store.deletingAccount.code)} · ${esc(store.deletingAccount.name)}？</div><p>刪除後，Voucher 科目搜尋、Ledger 及報表會即時更新。</p>`;button.textContent='確認刪除'}
}

export function openDeleteAccount(code: string | undefined){store.deletingAccount=store.accounts.find(account=>account.code===code);if(!store.deletingAccount)return;store.deleteAccountStep=1;store.deleteAccountUsage=accountUsageLocations(store.deletingAccount);renderDeleteAccount();deleteAccountModal.hidden=false;(document.getElementById('confirmDeleteAccount') as HTMLButtonElement).focus()}

export function closeDeleteAccount(){deleteAccountModal.hidden=true;store.deletingAccount=null;store.deleteAccountStep=1;store.deleteAccountUsage=[];(document.getElementById('cancelDeleteAccount') as HTMLButtonElement).hidden=false}

export const openingInvoiceModal=(document.getElementById('openingInvoiceModal') as HTMLElement);

export function openingExpected(accountName: string): Cents{const row=[...document.querySelectorAll('#openingBalanceBody tr[data-account]')].find(el=>(el as HTMLElement).dataset.account===accountName);if(!row)return 0 as Cents;return accountName.startsWith('Accounts Receivable of ')?toCents((row.querySelector('.opening-debit') as HTMLInputElement).value):toCents((row.querySelector('.opening-credit') as HTMLInputElement).value)}

export function validateOpeningInvoiceDraft(){const expected=openingExpected(store.openingInvoiceAccount),complete=store.openingInvoiceDraft.every(item=>item.date&&item.invoiceNo.trim()&&item.amount>0),unique=new Set(store.openingInvoiceDraft.map(item=>item.invoiceNo.trim().toLowerCase())).size===store.openingInvoiceDraft.length,total=store.openingInvoiceDraft.reduce((sum,item)=>sum+item.amount,0) as Cents,split=store.openingInvoiceDraft.length>0,difference=(expected-total) as Cents,finished=difference===0,canSave=!split||(complete&&unique),state=(document.getElementById('openingInvoiceState') as HTMLElement);(document.getElementById('openingInvoiceExpected') as HTMLElement).textContent=`期初總數 ${fmt(expected)} · 明細合計 ${fmt(total)}`;state.style.color=!split||finished?'var(--good)':complete&&unique?'var(--warn)':'var(--bad)';state.textContent=!split?'未拆分（保持總數入賬）':!complete?'請完成每張發票資料':!unique?'發票編號不可重複':finished?'✓ 已完成 · 仲差 HK$ 0.00':`待完成 · 仲差 HK$ ${signedFmt(difference)}`;(document.getElementById('saveOpeningInvoice') as HTMLButtonElement).disabled=!canSave;return canSave}

export function renderOpeningInvoiceRows(){const box=(document.getElementById('openingInvoiceRows') as HTMLElement);box.innerHTML=store.openingInvoiceDraft.map((item,i)=>`<div class="invoice-editor-row" data-index="${i}"><input class="invoice-date" type="date" aria-label="發票日期" value="${esc(item.date)}"><input class="invoice-number" aria-label="發票編號" autocomplete="off" value="${esc(item.invoiceNo)}" placeholder="例如 INV-240401"><input class="invoice-amount" type="number" min="0.01" step="0.01" inputmode="decimal" aria-label="發票金額" value="${item.amount?fromCents(item.amount):''}" placeholder="0.00"><button class="icon-btn remove-opening-invoice" type="button" aria-label="刪除此發票">×</button></div>`).join('')||'<div class="empty">尚未拆分發票明細</div>';box.querySelectorAll('.invoice-editor-row').forEach((row,i)=>{const sync=()=>{store.openingInvoiceDraft[i]={date:(row.querySelector('.invoice-date') as HTMLInputElement).value,invoiceNo:(row.querySelector('.invoice-number') as HTMLInputElement).value,amount:toCents((row.querySelector('.invoice-amount') as HTMLInputElement).value)};validateOpeningInvoiceDraft()};row.querySelectorAll('input').forEach(input=>input.addEventListener('input',sync));(row.querySelector('.remove-opening-invoice') as HTMLElement).addEventListener('click',()=>{store.openingInvoiceDraft.splice(i,1);renderOpeningInvoiceRows()})});validateOpeningInvoiceDraft()}

export function openOpeningInvoiceEditor(accountName: string){store.openingInvoiceAccount=accountName;const saved=(store.openingInvoiceDetails[store.selectedFiscalKey]&&store.openingInvoiceDetails[store.selectedFiscalKey][accountName])||[];store.openingInvoiceDraft=saved.map(item=>({...item}));(document.getElementById('openingInvoiceTitle') as HTMLElement).textContent=(accountName.startsWith('Accounts Receivable of ')?'應收賬款':'應付賬款')+'期初未清發票明細';(document.getElementById('openingInvoiceHelp') as HTMLElement).textContent=accountName+' · 可暫存並繼續新增；差額歸零後才依發票日期進行 FIFO 對銷';openingInvoiceModal.hidden=false;renderOpeningInvoiceRows()}

export function closeOpeningInvoiceEditor(){openingInvoiceModal.hidden=true;store.openingInvoiceAccount='';store.openingInvoiceDraft=[]}
