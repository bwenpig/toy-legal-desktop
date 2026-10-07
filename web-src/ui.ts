/**
 * 由 scripts/extract.js 自 v3.15 index.html 自動拆分。
 * 零功能變更：邏輯與原 IIFE 內文一致（全域狀態引用改為 store.*）。
 */
import { renderLedger } from './ledger';
import { renderReport } from './reports';
import { store } from './state';
import { syncAccountSelectors } from './vouchers';

export const loginForm=(document.getElementById('loginForm') as HTMLFormElement);

export const loginUser=(document.getElementById('loginUser') as HTMLInputElement);

export const loginPassword=(document.getElementById('loginPassword') as HTMLInputElement);

export const loginError=(document.getElementById('loginError') as HTMLElement);

export const authorizedPasswordHash='dd89871aa925e5084bcb39d2b562628fcf9373a3d6322d5365171449b88bf62c';

export async function hashLoginPassword(value: string){const bytes=new TextEncoder().encode(value),digest=await crypto.subtle.digest('SHA-256',bytes);return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('')}

export function clearLoginError(){loginError.classList.remove('show');loginUser.removeAttribute('aria-invalid');loginPassword.removeAttribute('aria-invalid')}

export const appShell=(document.getElementById('appShell') as HTMLElement);

export const sidebarToggle=(document.getElementById('sidebarToggle') as HTMLButtonElement);

export const sidebarContent=document.querySelectorAll('#desktopSidebar > :not(.sidebar-toggle)');

export function setSidebarCollapsed(collapsed: boolean){appShell.classList.toggle('sidebar-collapsed',collapsed);sidebarToggle.textContent=collapsed?'»':'«';sidebarToggle.setAttribute('aria-expanded',String(!collapsed));const label=collapsed?'展開左側工具欄':'收起左側工具欄';sidebarToggle.setAttribute('aria-label',label);sidebarToggle.title=label;sidebarContent.forEach(element=>{(element as HTMLElement).hidden=collapsed})}

import { formatCentsAbs, formatCentsSigned } from './money';

/** 金額顯示：內部一律整數分（見 money.ts），此處只做分→字串 */
export const fmt=(n: unknown)=>formatCentsAbs(n);

export const signedFmt=(n: unknown)=>formatCentsSigned(n);

export const money=(n: unknown)=>'HK$ '+signedFmt(n);

export const esc=(s: unknown)=>String(s??'').replace(/[&<>"]/g,(c: string)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'} as Record<string, string>)[c]);

export const pad2=(n: number | string)=>String(n).padStart(2,'0');

export const today=new Date();

export const todayISO=`${today.getFullYear()}-${pad2(today.getMonth()+1)}-${pad2(today.getDate())}`;

export const currentFiscalStart=today.getMonth()>=3?today.getFullYear():today.getFullYear()-1;

export const accountCodeCollator=new Intl.Collator('en',{numeric:true,sensitivity:'base'});

export const monthNumber: Record<string, string>={jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'};

export function navigate(id: string){document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===id));document.querySelectorAll('[data-route]').forEach(b=>b.classList.toggle('active',(b as HTMLElement).dataset.route===id));window.scrollTo({top:0,behavior:'smooth'});if(id==='voucher')syncAccountSelectors();if(id==='ledger')renderLedger();if(id==='reports')renderReport();}

export const salesChannels=[{key:'ar',label:'AR 賒銷'},{key:'online',label:'Online Sales'},{key:'pmq',label:'PMQ 門市'}];

export function renderStaffNames(){const names=[...store.staffNames].filter(name=>!store.suppressedStaffNames.has(name)).sort((a,b)=>a.localeCompare(b));(document.getElementById('staffNameList') as HTMLElement).innerHTML=names.map(name=>`<option value="${esc(name)}"></option>`).join('');const manager=(document.getElementById('staffNameListManager') as HTMLElement);manager.innerHTML=names.length?names.map(name=>`<div class="staff-name-row"><span>${esc(name)}</span><button class="btn danger remove-staff-name" type="button" data-name="${esc(name)}">刪除</button></div>`).join(''):'<div class="empty">未有已儲存的常用人名</div>';manager.querySelectorAll('.remove-staff-name').forEach(btn=>btn.addEventListener('click',()=>{const name=(btn as HTMLElement).dataset.name as string;store.suppressedStaffNames.add(name);store.staffNames.delete(name);renderStaffNames()}))}

export const staffManager=(document.getElementById('staffManager') as HTMLElement);

export const manageStaffNames=(document.getElementById('manageStaffNames') as HTMLButtonElement);

export function toggleStaffManager(open: boolean){staffManager.hidden=!open;manageStaffNames.setAttribute('aria-expanded',String(open));if(open)renderStaffNames()}

export function openDownloadPopup(blob: Blob,filename: string,title: string){
  const url=URL.createObjectURL(blob),w=window.open('','_blank');
  if(!w||w.closed){try{URL.revokeObjectURL(url)}catch(e){}return null}
  w.document.write('<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+esc(title)+'</title><style>body{font-family:-apple-system,"PingFang HK","Microsoft JhengHei",sans-serif;padding:36px 20px;text-align:center;line-height:1.9;color:#222}h1{font-size:22px;margin:0 0 20px}#dl{display:inline-block;font-size:20px;font-weight:700;padding:16px 30px;border:2px solid #1a73e8;border-radius:12px;color:#1a73e8;text-decoration:none}.tip{color:#666;font-size:15px;margin-top:18px}</style></head><body><h1>'+esc(title)+'</h1><a id="dl" href="'+url+'" download="'+esc(filename)+'">撳呢度下載 '+esc(filename)+'</a><p class="tip">如果冇自動開始，請撳上面條連結</p><script>setTimeout(function(){(document.getElementById("dl") as HTMLAnchorElement).click();},300);<\/script></body></html>');
  w.document.close();
  setTimeout(()=>{try{URL.revokeObjectURL(url)}catch(e){}},5*60*1000);
  return{win:w,url:url};
}

export async function copyTextToClipboard(text: string,statusEl: HTMLElement | null){
  const showCopied=(ok: boolean)=>{try{if(!statusEl)return;let note=statusEl.querySelector('.copy-note');if(!note){note=document.createElement('span');note.className='copy-note';statusEl.appendChild(note)}note.textContent=' · '+(ok?'✓ 已複製，可貼上任何地方儲存':'複製失敗，請手動長按複製')}catch(e){}};
  let ok=false;
  try{if(navigator.clipboard&&navigator.clipboard.writeText){await navigator.clipboard.writeText(text);ok=true}}catch(e){ok=false}
  if(!ok){
    try{
      const ta=document.createElement('textarea');
      ta.value=text;ta.setAttribute('readonly','');ta.style.position='fixed';ta.style.top='0';ta.style.left='0';ta.style.opacity='0';
      document.body.appendChild(ta);
      try{ta.focus();ta.select();try{ta.setSelectionRange(0,ta.value.length)}catch(e){}ok=document.execCommand('copy')}catch(e){ok=false}
      ta.remove();
    }catch(e){ok=false}
  }
  showCopied(ok);
  return ok;
}

export interface AttachmentData {
  name: string;
  type: string;
  lastModified: number;
  data: string;
}
export function fileToDataURL(file: File): Promise<AttachmentData | null> {return new Promise<AttachmentData | null>((resolve,reject)=>{if(!file||typeof FileReader==='undefined'){resolve(null);return}const reader=new FileReader();reader.onload=()=>resolve({name:file.name||'attachment',type:file.type||'application/octet-stream',lastModified:Number(file.lastModified)||0,data:String(reader.result)});reader.onerror=()=>reject(new Error('附件讀取失敗：'+(file.name||'未命名文件')));reader.readAsDataURL(file)})}

export function dataURLToFile(saved: { name: string; type: string; data: string; lastModified?: number }): File;
export function dataURLToFile(saved: { name?: string; type?: string; data?: string; lastModified?: number } | null | undefined): File | null;
export function dataURLToFile(saved: { name?: string; type?: string; data?: string; lastModified?: number } | null | undefined): File | null {if(!saved||!saved.data)return null;const match=String(saved.data).match(/^data:([^;,]*)(;base64)?,(.*)$/s);if(!match)throw new Error('備份內的附件格式不正確。');const raw=match[2]?atob(match[3]):decodeURIComponent(match[3]),bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);return new File([bytes],saved.name||'attachment',{type:saved.type||match[1]||'application/octet-stream',lastModified:Number(saved.lastModified)||Date.now()})}
