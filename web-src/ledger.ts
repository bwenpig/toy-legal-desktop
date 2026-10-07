/**
 * 由 scripts/extract.js 自 v3.15 index.html 自動拆分。
 * 零功能變更：邏輯與原 IIFE 內文一致（全域狀態引用改為 store.*）。
 */
import { accountHasFiscalActivity } from './state';
import type { Account, FiscalYear, VoucherLine } from './types';
import type { Cents } from './money';
import { attachmentButtonHTML } from './vouchers';
import { bindAttachmentButtons } from './vouchers';
import { dateInFiscalYear } from './state';
import { esc } from './ui';
import { fmt } from './ui';
import { selectedFiscalYear } from './state';
import { signedFmt } from './ui';
import { store } from './state';

export function openingNaturalBalance(account: Account | null | undefined,fy: FiscalYear | undefined=selectedFiscalYear()): Cents{if(!account||!fy)return 0 as Cents;const entry=store.openingBalances[fy.key]&&store.openingBalances[fy.key][account.name];if(!entry)return 0 as Cents;const signed=typeof entry==='number'?0 as Cents:(entry.debit-entry.credit) as Cents;return (account.side==='dr'?signed:-signed) as Cents}

export function accountBalance(account: Account | null | undefined,fy: FiscalYear | undefined=selectedFiscalYear()): Cents{if(!account||!fy)return 0 as Cents;const base: Cents=fy.start===2023&&!store.deletedDataYears.has(fy.key)?account.importedBalance:0 as Cents;return (base+openingNaturalBalance(account,fy)+((store.balanceAdjustments[fy.key]&&store.balanceAdjustments[fy.key][account.name])||0)) as Cents}

export function accountSignedBalance(account: Account | null | undefined,fy: FiscalYear | undefined=selectedFiscalYear()): Cents{const natural=accountBalance(account,fy);return (natural*(account&&account.side==='cr'?-1:1)) as Cents}

export const fiscalAccounts=(fy=selectedFiscalYear())=>store.accounts.filter(a=>accountHasFiscalActivity(a,fy));

export function balanceLabel(account: Account | null | undefined,fy: FiscalYear | undefined=selectedFiscalYear()){const signed=accountSignedBalance(account,fy);return signed?signedFmt(signed)+' '+(signed<0?'Cr':'Dr'):'—'}

export function renderLedger(){const fy=selectedFiscalYear(),sel=(document.getElementById('ledgerAccount') as HTMLSelectElement),available=fiscalAccounts(fy),preferred=sel.value||'Current Account of Lam Hon Fai';sel.innerHTML=available.map(a=>`<option>${esc(a.name)}</option>`).join('');if(!available.length){(document.getElementById('ledgerBody') as HTMLTableSectionElement).innerHTML='<tr><td colspan="6" class="empty">所選財年未有期初數或過賬記錄</td></tr>';(document.getElementById('ledgerClosing') as HTMLElement).textContent='—';sel.disabled=true;return}sel.disabled=false;sel.value=available.some(a=>a.name===preferred)?preferred:available[0].name;const name=sel.value,a=store.accounts.find(x=>x.name===name),tx: (VoucherLine & { date: string; no: string; desc: string; voucherIndex: number })[]=[];store.vouchers.forEach((v,voucherIndex)=>{if(dateInFiscalYear(v.date,fy))v.lines.filter(l=>l.account===name).forEach(l=>tx.push({...l,date:v.date,no:v.no,desc:v.desc,voucherIndex}))});let running: Cents=accountSignedBalance(a,fy);[...tx].reverse().forEach(t=>{running=(running-(t.debit-t.credit)) as Cents});const openingSide=running<0?'Cr':'Dr',openingAmount=Math.abs(running);let html=`<tr><td data-label="日期">${fy.from}</td><td data-label="明細 Detail">期初結餘 Balance b/d</td><td data-label="Voucher">—</td><td class="num" data-label="Debit">${openingSide==='Dr'&&openingAmount?fmt(openingAmount):'—'}</td><td class="num" data-label="Credit">${openingSide==='Cr'&&openingAmount?fmt(openingAmount):'—'}</td><td class="num" data-label="結餘">${fmt(openingAmount)} ${openingSide}</td></tr>`;tx.sort((x,y)=>x.date.localeCompare(y.date)).forEach(t=>{running=(running+(t.debit-t.credit)) as Cents;html+=`<tr><td data-label="日期">${t.date}</td><td data-label="明細 Detail">${esc(t.detail||t.desc)}</td><td data-label="Voucher"><b>${esc(t.no)}</b>${attachmentButtonHTML(t.voucherIndex)}</td><td class="num" data-label="Debit">${t.debit?fmt(t.debit):'—'}</td><td class="num" data-label="Credit">${t.credit?fmt(t.credit):'—'}</td><td class="num" data-label="結餘">${fmt(running)} ${running<0?'Cr':'Dr'}</td></tr>`});(document.getElementById('ledgerBody') as HTMLTableSectionElement).innerHTML=html;(document.getElementById('ledgerClosing') as HTMLElement).textContent=balanceLabel(a,fy);bindAttachmentButtons((document.getElementById('ledgerBody') as HTMLTableSectionElement));}
