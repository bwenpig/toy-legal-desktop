/**
 * 由 scripts/extract.js 自 v3.15 index.html 自動拆分。
 * 零功能變更：邏輯與原 IIFE 內文一致（全域狀態引用改為 store.*）。
 */
import { accountCodeCollator } from './ui';
import type { Account, Attachment, InvoiceRow, Voucher, VoucherLine } from './types';
import type { Cents } from './money';
import { fromCents, toCents } from './money';
import { dataURLToFile } from './ui';
import { dateInFiscalYear } from './state';
import { esc } from './ui';
import { fileToDataURL } from './ui';
import { fiscalYearForDate } from './core/fiscal';
import { fmt } from './ui';
import { openingInvoiceStatus } from './state';
import { openingManager } from './accounts';
import { renderAccounts } from './accounts';
import { renderKPIs } from './reports';
import { renderLedger } from './ledger';
import { renderOpeningBalances } from './accounts';
import { renderReport } from './reports';
import { selectedFiscalYear } from './state';
import { sortAccounts } from './accounts';
import { store } from './state';
import { todayISO } from './ui';

export function renderAccountOptions(){sortAccounts()}

export function syncAccountSelectors(){
  sortAccounts();
  renderAccountOptions();
  renderLedger();
  if(!openingManager.hidden)renderOpeningBalances();
  validate();
}

export function accountsChanged(){
  syncAccountSelectors();
  renderAccounts();
  renderReport();
  renderKPIs();
}

export function resolveAccount(value: unknown){const term=String(value||'').trim().toLowerCase();return store.accounts.find(a=>a.name.toLowerCase()===term||a.code.toLowerCase()===term)}

export function renderInvoiceNumberList(){const fy=selectedFiscalYear(),opening=Object.entries(store.openingInvoiceDetails[fy.key]||{}).flatMap(([accountName,items])=>openingInvoiceStatus(accountName,fy).state==='complete'?items.map((item): InvoiceRow=>[item.date,item.invoiceNo,accountName.replace(/^Accounts (Receivable|Payable) of /,''),item.amount,'opening']):[]);(document.getElementById('invoiceNumberList') as HTMLElement).innerHTML=[...store.salesInvoices,...store.purchaseInvoices,...opening].filter(r=>(r[4]==='opening'||dateInFiscalYear(r[0],fy))&&r[1]&&r[1]!=='—').map(r=>`<option value="${esc(r[1])}">${esc(r[2])}</option>`).join('')}

export function normalizeAttachments(voucher: Voucher | null | undefined): Attachment[]{
  const atts=voucher&&voucher.attachments;
  if(Array.isArray(atts))return atts.filter(item=>item&&item.dataURL).map(item=>({name:item.name||'attachment',type:item.type||'application/octet-stream',dataURL:String(item.dataURL)}));
  const legacy=voucher&&voucher.supportingAttachment;
  if(legacy&&legacy.data&&voucher)return[{name:legacy.name||voucher.supportingName||'attachment',type:legacy.type||'application/octet-stream',dataURL:String(legacy.data)}];
  return[];
}

export function renderCurrentAttachments(){const box=(document.getElementById('attachmentList') as HTMLElement);box.innerHTML=store.currentAttachments.length?store.currentAttachments.map((item,index)=>`<div class="attachment-item"><span class="attachment-item-name">${esc(item.name)}</span><button class="btn danger remove-attachment" type="button" data-index="${index}">刪除</button></div>`).join(''):'<div class="muted" style="font-size:11px">未選擇文件</div>';box.querySelectorAll('.remove-attachment').forEach(button=>button.addEventListener('click',()=>{store.currentAttachments.splice(Number((button as HTMLElement).dataset.index),1);renderCurrentAttachments()}));(document.getElementById('voucherFile') as HTMLInputElement).value=''}

export function fileToAttachment(file: File): Promise<Attachment>{return new Promise<Attachment>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve({name:file.name||'attachment',type:file.type||'application/octet-stream',dataURL:String(reader.result)});reader.onerror=()=>reject(new Error('附件讀取失敗：'+(file.name||'未命名文件')));reader.readAsDataURL(file)})}

export function attachmentButtonHTML(voucherIndex: number){const list=normalizeAttachments(store.vouchers[voucherIndex]);return list.length?`<button class="attachment-btn" type="button" data-voucher-index="${voucherIndex}" aria-label="查看 ${list.length} 個附件">📎 ${list.length}</button>`:''}

export function bindAttachmentButtons(root: ParentNode=document){root.querySelectorAll('.attachment-btn').forEach(button=>button.addEventListener('click',()=>openAttachmentList(Number((button as HTMLElement).dataset.voucherIndex))))}

export function openAttachmentFile(attachment: Attachment){const popup=window.open('','_blank');if(!popup||popup.closed)return;try{const file=dataURLToFile({name:attachment.name,type:attachment.type,data:attachment.dataURL}),url=URL.createObjectURL(file),title=esc(attachment.name),content=String(attachment.type||'').startsWith('image/')?`<img src="${url}" alt="${title}">`:`<iframe src="${url}" title="${title}"></iframe>`;popup.document.write(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>html,body{margin:0;min-height:100%;background:#202124;color:#fff}body{display:grid;place-items:center}img{display:block;max-width:100%;max-height:100vh}iframe{width:100vw;height:100vh;border:0;background:#fff}</style></head><body>${content}</body></html>`);popup.document.close();setTimeout(()=>URL.revokeObjectURL(url),5*60*1000)}catch(error){popup.close()}}

export function openAttachmentList(voucherIndex: number){const voucher=store.vouchers[voucherIndex],list=normalizeAttachments(voucher);if(!voucher||!list.length)return;(document.getElementById('attachmentModalTitle') as HTMLElement).textContent=`${voucher.no} · ${list.length} 個附件`;(document.getElementById('attachmentModalHelp') as HTMLElement).textContent='撳檔名會喺新視窗開啟圖片或 PDF。';const box=(document.getElementById('attachmentModalList') as HTMLElement);box.innerHTML=list.map((item,index)=>`<button class="btn attachment-open" type="button" data-index="${index}"><span>${esc(item.name)}</span><small>開啟 ↗</small></button>`).join('');box.querySelectorAll('.attachment-open').forEach(button=>button.addEventListener('click',()=>openAttachmentFile(list[Number((button as HTMLElement).dataset.index)])));(document.getElementById('attachmentModal') as HTMLElement).hidden=false;(document.getElementById('closeAttachmentModal') as HTMLButtonElement).focus()}

export function closeAttachmentList(){(document.getElementById('attachmentModal') as HTMLElement).hidden=true}

export function updateVoucherMode(){const editing=store.editingIndex!==null;(document.getElementById('postPanelTitle') as HTMLElement).textContent=editing?'修改並重新過賬':'過賬前檢查';(document.getElementById('postBtn') as HTMLButtonElement).textContent=editing?'儲存修改並重新過賬':'過賬到 General Ledger'}

export function setVoucher(data: Voucher,index: number | null=store.vouchers.indexOf(data),rememberDate=false){const safeIndex=index??-1;store.editingIndex=safeIndex>=0?safeIndex:null;store.currentType=data.type;store.numberManuallyEdited=Boolean(data.numberManual);document.querySelectorAll('[data-vtype]').forEach(b=>b.classList.toggle('active',(b as HTMLElement).dataset.vtype===store.currentType));(document.getElementById('voucherTitle') as HTMLElement).textContent=store.currentType==='B'?'BANK VOUCHER':'TRANSFER VOUCHER';(document.getElementById('voucherDate') as HTMLInputElement).value=data.date;if(rememberDate&&data.date)store.lastVoucherDates[fiscalYearForDate(data.date).key]=data.date;(document.getElementById('voucherDesc') as HTMLTextAreaElement).value=data.desc;(document.getElementById('allocationInvoice') as HTMLInputElement).value=data.allocationInvoice||'';(['madeBy','checkedBy','approvedBy'] as const).forEach(id=>(document.getElementById(id) as HTMLInputElement).value=data[id]||'');store.rows=data.lines.map(x=>({...x}));store.currentAttachments=normalizeAttachments(data);setNumber(data.no);renderCurrentAttachments();(document.getElementById('postToast') as HTMLElement).classList.remove('show');updateVoucherMode();renderRows();validate();}

export function setNumber(no: string){(document.getElementById('voucherNo') as HTMLElement).textContent=no||'—';(document.getElementById('voucherNoInput') as HTMLInputElement).value=no}

export function voucherNumberError(){const no=(document.getElementById('voucherNoInput') as HTMLInputElement).value.trim();if(!no)return'請輸入 Voucher number。';if(store.vouchers.some((v,i)=>i!==store.editingIndex&&v.no.toLowerCase()===no.toLowerCase()))return'此 Voucher number 已存在，請使用另一個編號。';return''}

export function voucherYearSuffix(date: string){const year=String(date||'').slice(0,4);return /^\d{4}$/.test(year)?year.slice(-2):''}

export function nextVoucherNumber(date: string,type: string=store.currentType){const yy=voucherYearSuffix(date),mm=String(date||'').slice(5,7);if(!yy||!/^\d{2}$/.test(mm))return'';const pattern=new RegExp('^'+type+mm+'(\\d{2})'+yy+'$','i');let max=0;store.vouchers.forEach((v,i)=>{if(i===store.editingIndex)return;const match=String(v.no||'').match(pattern);if(match)max=Math.max(max,Number(match[1])||0)});let seq=max+1,no='';do{no=type+mm+String(seq++).padStart(2,'0')+yy}while(store.vouchers.some((v,i)=>i!==store.editingIndex&&v.no.toLowerCase()===no.toLowerCase()));return no}

export function genNumber(){if(store.numberManuallyEdited)return;const fy=selectedFiscalYear(),d=(document.getElementById('voucherDate') as HTMLInputElement).value||store.lastVoucherDates[fy.key]||(dateInFiscalYear(todayISO,fy)?todayISO:fy.from),no=nextVoucherNumber(d);if(no)setNumber(no);validate()}

export function clearApproval(){['madeBy','checkedBy','approvedBy'].forEach(id=>(document.getElementById(id) as HTMLInputElement).value='');store.currentAttachments=[];renderCurrentAttachments();(document.getElementById('postToast') as HTMLElement).classList.remove('show');validate();}

export function renderAccountChoices(list: HTMLElement,filtered: Account[],activeIndex: number){list.innerHTML=filtered.length?filtered.map((account,index)=>`<button class="account-option${index===activeIndex?' active':''}" type="button" role="option" aria-selected="${index===activeIndex}" data-code="${esc(account.code)}"><span class="account-option-code">${esc(account.code)}</span><span class="account-option-name">${esc(account.name)}</span></button>`).join(''):'<div class="account-options-empty">找不到相符會計科目</div>';list.hidden=false;}

export function setupAccountCombobox(el: Element,i: number){
  const acct=(el.querySelector('.acct') as HTMLInputElement),list=el.querySelector('.account-options') as HTMLElement;let filtered: Account[]=[],activeIndex=-1,blurTimer: number | null=null;
  const close=()=>{list.hidden=true;acct.setAttribute('aria-expanded','false');activeIndex=-1};
  const filter=()=>{const term=acct.value.trim().toLowerCase(),rank=(account: Account)=>{const code=account.code.toLowerCase(),name=account.name.toLowerCase();if(!term)return 0;if(code===term||name===term)return 0;if(code.startsWith(term)||name.startsWith(term))return 1;return 2};filtered=store.accounts.filter(account=>!term||account.code.toLowerCase().includes(term)||account.name.toLowerCase().includes(term)).sort((a,b)=>rank(a)-rank(b)||accountCodeCollator.compare(a.code,b.code));activeIndex=filtered.length?0:-1;renderAccountChoices(list,filtered,activeIndex);acct.setAttribute('aria-expanded','true')};
  const select=(account: Account | undefined)=>{if(!account)return;acct.value=account.name;syncRow(i,el);close()};
  acct.addEventListener('focus',()=>{filter();requestAnimationFrame(()=>acct.select())});
  acct.addEventListener('input',()=>{syncRow(i,el);filter()});
  acct.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();close();return}
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();if(list.hidden)filter();if(!filtered.length)return;activeIndex=event.key==='ArrowDown'?Math.min(activeIndex+1,filtered.length-1):Math.max(activeIndex-1,0);renderAccountChoices(list,filtered,activeIndex);list.querySelector('.active')?.scrollIntoView({block:'nearest'});return
    }
    if(event.key==='Enter'&&!list.hidden&&activeIndex>=0){event.preventDefault();select(filtered[activeIndex])}
  });
  acct.addEventListener('blur',()=>{blurTimer=setTimeout(()=>{const match=resolveAccount(acct.value);if(match){acct.value=match.name;syncRow(i,el)}close()},120)});
  list.addEventListener('mousedown',event=>{const option=(event.target as HTMLElement).closest('.account-option');if(!option)return;event.preventDefault();if(blurTimer)clearTimeout(blurTimer);select(store.accounts.find(account=>account.code===(option as HTMLElement).dataset.code))});
}

export function renderRows(){renderAccountOptions();const box=(document.getElementById('entryRows') as HTMLElement);box.innerHTML=store.rows.map((r,i)=>`<div class="entry-row" data-i="${i}"><span class="row-index">${String(i+1).padStart(2,'0')}</span><div class="entry-account entry-field"><span class="entry-field-label">會計科目 Account</span><input class="acct account-combobox" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="account-options-${i}" aria-label="會計科目（可按編號或名稱搜尋）" autocomplete="off" value="${esc(r.account)}" placeholder="輸入編號或科目名稱"><div class="account-options" id="account-options-${i}" role="listbox" hidden></div></div><div class="entry-detail entry-field"><span class="entry-field-label">明細 Detail</span><input class="detail" aria-label="明細" value="${esc(r.detail)}"></div><div class="entry-debit entry-field"><span class="entry-field-label">借方 Debit</span><input class="num debit" aria-label="借方" type="number" min="0" step="0.01" value="${r.debit?fromCents(r.debit):''}" placeholder="0.00"></div><div class="entry-credit entry-field"><span class="entry-field-label">貸方 Credit</span><input class="num credit" aria-label="貸方" type="number" min="0" step="0.01" value="${r.credit?fromCents(r.credit):''}" placeholder="0.00"></div><button class="icon-btn remove" aria-label="刪除此行">×</button></div>`).join('');box.querySelectorAll('.entry-row').forEach((el,i)=>{el.querySelectorAll('input:not(.acct)').forEach(inp=>inp.addEventListener('input',()=>syncRow(i,el)));setupAccountCombobox(el,i);(el.querySelector('.remove') as HTMLElement).addEventListener('click',()=>{if(store.rows.length>2){store.rows.splice(i,1);renderRows()}})});validate();}

export function syncRow(i: number,el: Element){const raw=(el.querySelector('.acct') as HTMLInputElement).value,match=resolveAccount(raw);store.rows[i]={account:match?match.name:raw,detail:(el.querySelector('.detail') as HTMLInputElement).value,debit:toCents((el.querySelector('.debit') as HTMLInputElement).value),credit:toCents((el.querySelector('.credit') as HTMLInputElement).value)};validate();}

export function validate(){const dr=store.rows.reduce((s,r)=>s+r.debit,0) as Cents,cr=store.rows.reduce((s,r)=>s+r.credit,0) as Cents,accountsOK=store.rows.every(r=>Boolean(resolveAccount(r.account))),balanced=dr>0&&dr===cr,noError=voucherNumberError(),numberOK=!noError,dateOK=dateInFiscalYear((document.getElementById('voucherDate') as HTMLInputElement).value);(document.getElementById('debitTotal') as HTMLElement).textContent=fmt(dr);(document.getElementById('creditTotal') as HTMLElement).textContent=fmt(cr);const state=(document.getElementById('balanceState') as HTMLElement);state.className='balance-state '+(balanced&&accountsOK?'ok':'bad');state.textContent=!accountsOK?'請從搜尋結果選擇有效會計科目':(balanced?'✓ 借貸平衡':'差額 HK$ '+fmt(dr-cr));const signed=['madeBy','checkedBy','approvedBy'].every(id=>(document.getElementById(id) as HTMLInputElement).value.trim());(document.getElementById('voucherNoError') as HTMLElement).textContent=noError;(document.getElementById('checkVoucherNo') as HTMLLIElement).style.color=numberOK?'var(--good)':'var(--bad)';(document.getElementById('checkBalance') as HTMLLIElement).style.color=balanced&&accountsOK?'var(--good)':'var(--bad)';(document.getElementById('checkSign') as HTMLLIElement).style.color=signed?'var(--good)':'var(--warn)';(document.getElementById('postBtn') as HTMLButtonElement).disabled=!(numberOK&&balanced&&accountsOK&&signed&&dateOK);}

export function applyVoucherBalance(v: Voucher,mult: number){const fy=fiscalYearForDate(v.date);store.balanceAdjustments[fy.key]??={};v.lines.forEach(l=>{const a=store.accounts.find(x=>x.name===l.account);if(a){const delta=((l.debit-l.credit)*mult*(a.side==='dr'?1:-1)) as Cents;store.balanceAdjustments[fy.key][a.name]=((store.balanceAdjustments[fy.key][a.name]||0)+delta) as Cents}})}

export function clearVoucherAllocations(no: string){for(let i=store.allocations.length-1;i>=0;i--)if(store.allocations[i].voucher===no)store.allocations.splice(i,1);for(let i=store.allocationReview.length-1;i>=0;i--)if(store.allocationReview[i].voucher===no)store.allocationReview.splice(i,1)}

export function renderVoucherList(){const q=(document.getElementById('voucherSearch') as HTMLInputElement).value.trim().toLowerCase(),body=(document.getElementById('voucherListBody') as HTMLTableSectionElement);const visible=store.vouchers.map((v,index)=>({v,index})).filter(({v})=>dateInFiscalYear(v.date)&&[v.no,v.desc,v.allocationInvoice,v.madeBy,v.checkedBy,v.approvedBy].some(value=>String(value||'').toLowerCase().includes(q)));body.innerHTML=visible.map(({v,index})=>`<tr><td data-label="日期">${esc(v.date)}</td><td data-label="Voucher"><b>${esc(v.no)}</b></td><td data-label="摘要">${esc(v.desc)}</td><td class="num" data-label="金額">${fmt(v.lines.reduce((s,l)=>s+l.debit,0))}</td><td data-label="製表／覆核／批核">${[v.madeBy,v.checkedBy,v.approvedBy].filter(Boolean).map(esc).join(' ／ ')||'—'}</td><td data-label="操作"><div class="voucher-list-actions"><button class="btn edit-voucher" type="button" data-index="${index}">修改</button></div></td></tr>`).join('')||'<tr><td colspan="6" class="empty">找不到相符 Voucher</td></tr>';body.querySelectorAll('.edit-voucher').forEach(btn=>btn.addEventListener('click',()=>{setVoucher(store.vouchers[Number((btn as HTMLElement).dataset.index)],Number((btn as HTMLElement).dataset.index),true);(document.querySelector('.voucher-paper') as HTMLElement).scrollIntoView({behavior:'smooth',block:'start'})}))}

export function createNewVoucher(){const fy=selectedFiscalYear(),remembered=store.lastVoucherDates[fy.key];store.editingIndex=null;store.currentType='B';store.numberManuallyEdited=false;document.querySelectorAll('[data-vtype]').forEach(b=>b.classList.toggle('active',(b as HTMLElement).dataset.vtype==='B'));(document.getElementById('voucherTitle') as HTMLElement).textContent='BANK VOUCHER';(document.getElementById('voucherDate') as HTMLInputElement).value=remembered&&dateInFiscalYear(remembered,fy)?remembered:(dateInFiscalYear(todayISO,fy)?todayISO:fy.from);(document.getElementById('voucherDesc') as HTMLTextAreaElement).value='';(document.getElementById('allocationInvoice') as HTMLInputElement).value='';store.rows=[{account:(store.accounts.find(a=>a.code==='1000')||store.accounts[0]).name,detail:'',debit:0 as Cents,credit:0 as Cents},{account:(store.accounts.find(a=>a.code==='2100')||store.accounts[1]).name,detail:'',debit:0 as Cents,credit:0 as Cents}];updateVoucherMode();genNumber();renderRows();clearApproval()}

export async function serializeVoucher(voucher: Voucher){const plain={...voucher},attachments=normalizeAttachments(voucher);if(!attachments.length&&voucher.supportingFile){const saved=await fileToDataURL(voucher.supportingFile);if(saved)attachments.push({name:saved.name,type:saved.type,dataURL:saved.data})}plain.attachments=attachments;delete plain.supportingFile;delete plain.supportingName;delete plain.supportingAttachment;return plain}
