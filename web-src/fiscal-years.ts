/**
 * 由 scripts/extract.js 自 v3.15 index.html 自動拆分。
 * 零功能變更：邏輯與原 IIFE 內文一致（全域狀態引用改為 store.*）。
 */
import { createNewVoucher } from './vouchers';
import type { FiscalYear } from './types';
import { dateInFiscalYear } from './state';
import { manageOpeningBalances } from './accounts';
import { openingManager } from './accounts';
import { renderAccounts } from './accounts';
import { renderInvoiceNumberList } from './vouchers';
import { renderKPIs } from './reports';
import { renderLedger } from './ledger';
import { renderOpeningBalances } from './accounts';
import { renderReport } from './reports';
import { renderVoucherList } from './vouchers';
import { selectedFiscalYear } from './state';
import { setVoucher } from './vouchers';
import { store } from './state';

export const fiscalDataCount=(fy: FiscalYear)=>store.vouchers.filter(v=>dateInFiscalYear(v.date,fy)).length+store.salesInvoices.filter(r=>dateInFiscalYear(r[0],fy)).length+store.purchaseInvoices.filter(r=>dateInFiscalYear(r[0],fy)).length+Object.keys(store.openingBalances[fy.key]||{}).length;

export function fiscalLabelRange(fy: FiscalYear){return `${fy.from.replaceAll('-','/')} — ${fy.to.replaceAll('-','/')}`}

export function renderFiscalYears(){const fy=selectedFiscalYear(),select=(document.getElementById('fiscalYearSelect') as HTMLSelectElement);select.innerHTML=store.fiscalYears.map(x=>`<option value="${x.key}">${x.label}</option>`).join('');select.value=fy.key;(document.getElementById('fiscalRange') as HTMLElement).textContent=fiscalLabelRange(fy);(document.getElementById('dashboardFiscalRange') as HTMLElement).textContent=fiscalLabelRange(fy);(document.getElementById('sidebarFiscalYear') as HTMLElement).textContent=fy.label+' · HKD';(document.getElementById('voucherDate') as HTMLInputElement).min=fy.from;(document.getElementById('voucherDate') as HTMLInputElement).max=fy.to;renderInvoiceNumberList();(document.getElementById('fiscalYearList') as HTMLElement).innerHTML=store.fiscalYears.map(x=>`<div class="fy-list-row"><div><strong>${x.label}${x.key===fy.key?' · 使用中':''}</strong><small>${fiscalLabelRange(x)} · ${fiscalDataCount(x)} 筆資料</small></div><button class="btn danger delete-fy" type="button" data-key="${x.key}" ${store.fiscalYears.length===1?'disabled':''}>刪除</button></div>`).join('');document.querySelectorAll('.delete-fy').forEach(btn=>btn.addEventListener('click',()=>openDeleteFiscal((btn as HTMLElement).dataset.key)))}

export function refreshFiscalScope(){store.reportState.month=null;store.reportState.date='';store.editingIndex=null;renderFiscalYears();if(!openingManager.hidden)renderOpeningBalances();renderVoucherList();renderLedger();renderReport();renderAccounts();renderKPIs();(document.getElementById('ledgerCount') as HTMLElement).textContent=String(store.vouchers.filter(v=>dateInFiscalYear(v.date)).length);const bank=store.vouchers.find(v=>v.no==='B091423'&&dateInFiscalYear(v.date)),transfer=store.vouchers.find(v=>v.no==='T100223'&&dateInFiscalYear(v.date));(document.getElementById('loadBank') as HTMLButtonElement).disabled=!bank;(document.getElementById('loadTransfer') as HTMLButtonElement).disabled=!transfer;const first=store.vouchers.find(v=>dateInFiscalYear(v.date));if(first)setVoucher(first,store.vouchers.indexOf(first));else createNewVoucher()}

export const fiscalManager=(document.getElementById('fiscalManager') as HTMLElement);

export const manageFiscalYears=(document.getElementById('manageFiscalYears') as HTMLButtonElement);

export function toggleFiscalManager(open: boolean){fiscalManager.hidden=!open;manageFiscalYears.setAttribute('aria-expanded',String(open));if(open){openingManager.hidden=true;manageOpeningBalances.setAttribute('aria-expanded','false');(document.getElementById('fiscalStartYear') as HTMLInputElement).focus()}}

export function openDeleteFiscal(key: string | undefined){store.deleteFiscalCandidate=store.fiscalYears.find(fy=>fy.key===key);if(!store.deleteFiscalCandidate)return;store.deleteFiscalStep=1;renderDeleteFiscal();(document.getElementById('deleteFiscalModal') as HTMLElement).hidden=false;(document.getElementById('confirmDeleteFiscal') as HTMLButtonElement).focus()}

export function renderDeleteFiscal(){const fy=store.deleteFiscalCandidate;if(!fy)return;const count=fiscalDataCount(fy),body=(document.getElementById('deleteFiscalBody') as HTMLElement),button=(document.getElementById('confirmDeleteFiscal') as HTMLButtonElement);if(store.deleteFiscalStep===1){body.innerHTML=`<p>你正準備刪除 <strong>${fy.label}</strong>（${fiscalLabelRange(fy)}）。</p>${count?`<div class="modal-warning">此財年已有 ${count} 筆 Voucher／發票資料。繼續刪除會一併刪除該財年所有資料，不能復原。</div>`:'<p>此財年目前沒有 Voucher 或發票資料。</p>'}<p>按「繼續」進入第二次確認。</p>`;button.textContent='繼續';button.className='btn danger'}else{body.innerHTML=`<div class="modal-warning">第二次確認：確定永久刪除 ${fy.label}${count?' 及該財年全部 '+count+' 筆資料':''}？</div><p>此動作只影響今次開啟期間的原型資料。</p>`;button.textContent='確認刪除';button.className='btn danger'}}

export function closeDeleteFiscal(){(document.getElementById('deleteFiscalModal') as HTMLElement).hidden=true;store.deleteFiscalCandidate=null;store.deleteFiscalStep=1}
