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

/* ---------- 0. 環境偵測 ---------- */
var IS_TAURI = !!(window.__TAURI_INTERNALS__ || window.__TAURI__);
if(!IS_TAURI) return;                       // 瀏覽器開呢個檔：當普通 web 版跑
if(!window.__TG__){ console.error('[desktop] __TG__ bridge missing'); return; }
if(!window.__TG_DB__){ console.error('[desktop] __TG_DB__ missing (db-layer.js 未載入)'); return; }
var TG = window.__TG__;
var DB = window.__TG_DB__;
var invoke = function(cmd, args, options){
  return window.__TAURI_INTERNALS__.invoke(cmd, args, options || {});
};

/* ---------- 1. SQL（plugin-sql raw invoke → DbPort） ---------- */
/* 數據位置：customDbPath 為絕對路徑（tg-config.json）；null = 預設。
 * 注意 plugin-sql 嘅 path_mapper 用 PathBuf::push——絕對路徑會成個取代，
 * 所以 'sqlite:/abs/path.db' 開到任意位置；相對路徑解做 app config dir。 */
var customDbPath = null, dbHandle = null, dbPort = null;
function dbConnString(){
  return customDbPath ? ('sqlite:' + customDbPath) : 'sqlite:toys-gallery.db';
}
async function sqlInit(){
  dbHandle = await invoke('plugin:sql|load', { db: dbConnString() });
  dbPort = {
    execute: function(query, values){ return invoke('plugin:sql|execute', { db: dbHandle, query: query, values: values || [] }); },
    select: function(query, values){ return invoke('plugin:sql|select', { db: dbHandle, query: query, values: values || [] }); }
  };
  return DB.initDatabase(dbPort);
}
/* v1 遺留 kv 讀取（只供 migration 用） */
async function kvGetLegacy(key){
  var rows = await dbPort.select('SELECT value FROM kv_store WHERE key = ?', [key]);
  return rows.length ? rows[0].value : null;
}
/* 關閉目前 DB 連接（切換數據位置前用） */
async function closeDb(){
  if(dbHandle === null || dbHandle === undefined) return;
  try{ await invoke('plugin:sql|close', { db: dbHandle }); }
  catch(e){ console.warn('[desktop] 關閉 DB 連接失敗：', e); }
  dbHandle = null; dbPort = null;
}
/* 由 PRAGMA database_list 攞目前 DB 檔真實路徑（唔估路徑） */
async function currentDbFilePath(){
  try{
    var rows = await dbPort.select('PRAGMA database_list');
    for(var i = 0; i < rows.length; i++)
      if(rows[i].name === 'main' && rows[i].file) return String(rows[i].file);
  }catch(e){}
  return null;
}
async function fsExists(path){
  try{ return !!(await invoke('plugin:fs|exists', { path: path })); }
  catch(e){ try{ await fsReadBytes(path); return true; }catch(e2){ return false; } }
}
/* 複製 DB 檔：先 WAL checkpoint（落齊主檔），再讀寫 bytes */
async function copyDbFile(src, dest){
  await dbPort.execute('PRAGMA wal_checkpoint(TRUNCATE)');
  var bytes = await fsReadBytes(src);
  var dir = String(dest).replace(/[/\\][^/\\]*$/, '');
  if(dir) await fsMkdir(dir);
  await fsWriteBytes(dest, bytes);
}
/* migration 前備份成個 .db 檔：先 WAL checkpoint（落齊主檔），
   再經 PRAGMA database_list 攞真正路徑（唔估路徑） */
async function backupDbFile(tag){
  try{
    await dbPort.execute('PRAGMA wal_checkpoint(TRUNCATE)');
    var dblist = await dbPort.select('PRAGMA database_list');
    var main = null;
    for(var i = 0; i < dblist.length; i++) if(dblist[i].name === 'main') main = dblist[i];
    var src = main && main.file;
    if(!src){ console.warn('[desktop] 搵唔到 db 檔路徑，跳過備份'); return; }
    var bytes = await fsReadBytes(src);
    var base = await appDataDir();
    var stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
    await fsMkdir(base + '/backups');
    var dest = base + '/backups/toys-gallery-' + (tag || 'pre-migration') + '-' + stamp + '.db';
    await fsWriteBytes(dest, bytes);
    console.log('[desktop] db 已備份：' + dest);
  }catch(e){ console.warn('[desktop] db 備份失敗（繼續 migration）：', e); }
}

/* ---------- 2. Dialog / FS / Path ---------- */
async function dlgOpen(opts){ return invoke('plugin:dialog|open', { options: opts || {} }); }
async function dlgSave(opts){ return invoke('plugin:dialog|save', { options: opts || {} }); }
async function fsMkdir(path){
  await invoke('plugin:fs|mkdir', { path: path, options: { recursive: true } });
}
async function fsReadBytes(path){
  var arr = await invoke('plugin:fs|read_file', { path: path });
  // 真 Tauri 回傳 ArrayBuffer（唔係 Uint8Array 亦唔係 Array）；
  // Uint8Array.from(arrayBuffer) 會靜靜出空 array，必須先轉。
  // （對齊 @tauri-apps/plugin-fs 官方 readFile 寫法）
  if(arr instanceof Uint8Array) return arr;
  if(arr instanceof ArrayBuffer) return new Uint8Array(arr);
  if(Array.isArray(arr)) return Uint8Array.from(arr);
  if(arr && typeof arr === 'object'){ // {0:..,1:..} plain object fallback
    var keys = Object.keys(arr).filter(function(k){ return /^\d+$/.test(k); })
      .map(Number).sort(function(a,b){ return a - b; });
    var out = new Uint8Array(keys.length);
    for(var i = 0; i < keys.length; i++) out[i] = arr[keys[i]] & 0xff;
    return out;
  }
  throw new Error('讀檔回傳格式異常（' + (arr === null ? 'null' : typeof arr) + '）');
}
async function fsReadText(path){
  return new TextDecoder().decode(await fsReadBytes(path));
}
async function fsWriteBytes(path, data){ // data: Uint8Array
  await invoke('plugin:fs|write_file', data, {
    headers: { path: encodeURIComponent(path), options: JSON.stringify({}) }
  });
}
var _appDataDir = null;
async function appDataDir(){
  if(!_appDataDir)
    // 注意：BaseDirectory 係 numeric enum（AppData=14），唔可以傳 string！
    _appDataDir = await invoke('plugin:path|resolve_directory', { directory: 14 });
  return String(_appDataDir).replace(/\/+$/, '');
}
/* ---------- 2b. 桌面版 config（tg-config.json，AppConfig 目錄） ----------
 * 點解唔存 DB 入面：雞同雞蛋——要開 DB 先要知 DB 喺邊。
 * 點解唔用 AppData：config 係設定，平台慣例放 AppConfig（macOS 同 AppData
 * 同目錄，Linux 係 ~/.config）。 */
var _appConfigDir = null;
async function appConfigDir(){
  if(!_appConfigDir)
    // BaseDirectory numeric enum：AppConfig=13
    _appConfigDir = await invoke('plugin:path|resolve_directory', { directory: 13 });
  return String(_appConfigDir).replace(/\/+$/, '');
}
var CONFIG_FILE = 'tg-config.json';
async function readConfig(){
  try{
    var txt = await fsReadText(await appConfigDir() + '/' + CONFIG_FILE);
    var cfg = JSON.parse(txt);
    if(cfg && typeof cfg === 'object') return cfg;
  }catch(e){ /* 無 config／壞咗 = 用預設 */ }
  return {};
}
async function writeConfig(cfg){
  var dir = await appConfigDir();
  await fsMkdir(dir);
  await fsWriteBytes(dir + '/' + CONFIG_FILE,
    new TextEncoder().encode(JSON.stringify(cfg, null, 2)));
}
/* 預設 DB 路徑（同 plugin-sql 內部 resolve 一致：app_config_dir + 檔名） */
async function defaultDbPath(){
  return await appConfigDir() + '/toys-gallery.db';
}

/* ---------- 3. 附件：data URL <-> 實體檔 ---------- */
function sanitizeName(n){
  return String(n || 'attachment').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'attachment';
}
function dataURLToParts(dataURL){
  var m = String(dataURL).match(/^data:([^;,]*)(;base64)?,(.*)$/s);
  if(!m) throw new Error('附件 data URL 格式不正確');
  var mime = m[1] || 'application/octet-stream';
  var bytes = m[2] ? Uint8Array.from(atob(m[3]), function(c){ return c.charCodeAt(0); })
                   : new TextEncoder().encode(decodeURIComponent(m[3]));
  return { mime: mime, bytes: bytes };
}
function bytesToBase64(bytes){
  var bin = '', CH = 0x8000, i;
  for(i = 0; i < bytes.length; i += CH)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}
function bytesToDataURL(bytes, mime){
  return 'data:' + (mime || 'application/octet-stream') + ';base64,' + bytesToBase64(bytes);
}
function guessMime(name){
  var ext = String(name || '').split('.').pop().toLowerCase();
  var map = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', heic: 'image/heic',
    txt: 'text/plain', csv: 'text/csv', xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  return map[ext] || 'application/octet-stream';
}
function eachVoucherWithAttachment(payload, fn){
  var vs = (payload.data && payload.data.vouchers) || [];
  if(payload.data && payload.data.workingVoucher) vs = vs.concat([payload.data.workingVoucher]);
  vs.forEach(fn);
}
/* persist 前：data URL 抽出 base64 存 SQLite（v3 起唔再寫實體檔）。
 * attachment 改記 {name, mime, dataB64}，db-layer 寫入 attachments.data_b64。 */
function extractAttachments(payload){
  eachVoucherWithAttachment(payload, function(v){
    var atts = v && v.attachments;
    if(!Array.isArray(atts)) return;
    atts.forEach(function(att){
      if(att && typeof att.dataURL === 'string' && att.dataURL.indexOf('data:') === 0){
        var parts = dataURLToParts(att.dataURL);
        att.dataB64 = bytesToBase64(parts.bytes);
        att.mime = parts.mime;
        delete att.dataURL;
        delete att.path;   // v3 起唔用檔案制
        delete att.relPath;
      }
    });
  });
}
/* hydrate 前：dataB64 還原做 data URL，交返 app 原有邏輯。
 * v2 舊制（有 path 無 dataB64）fallback 讀檔，讀唔到就當無附件。 */
async function reconstituteAttachments(payload){
  var base = await appDataDir();
  var jobs = [];
  eachVoucherWithAttachment(payload, function(v){
    var atts = v && v.attachments;
    if(!Array.isArray(atts)) return;
    atts.forEach(function(att){
      if(att && att.dataB64 && !att.dataURL){
        att.dataURL = 'data:' + (att.mime || att.type || 'application/octet-stream') +
          ';base64,' + att.dataB64;
      }else if(att && att.path && !att.dataURL && !att.dataB64){
        jobs.push((async function(){
          try{
            var bytes = await fsReadBytes(base + '/' + att.path);
            att.dataURL = bytesToDataURL(bytes, att.mime || att.type);
          }catch(e){ /* 檔案唔見咗：留空，app 會當無附件 */ }
        })());
      }
    });
  });
  await Promise.all(jobs);
}

/* ---------- 3b. v2→v3 migration：附件檔案入 SQLite ---------- */
async function migrateAttachmentsToDb(){
  var base = await appDataDir();
  try{ await dbPort.execute('ALTER TABLE attachments ADD COLUMN data_b64 TEXT'); }
  catch(e){ /* 欄已存在（全新 v3 schema），繼續 */ }
  var rows = [];
  try{
    rows = await dbPort.select(
      'SELECT id, path FROM attachments WHERE path IS NOT NULL AND data_b64 IS NULL');
  }catch(e){ console.warn('[desktop] v2→v3：讀附件列表失敗', e); }
  var ok = 0, fail = 0;
  for(var i = 0; i < rows.length; i++){
    try{
      var bytes = await fsReadBytes(base + '/' + rows[i].path);
      await dbPort.execute('UPDATE attachments SET data_b64 = ? WHERE id = ?',
        [bytesToBase64(bytes), rows[i].id]);
      ok++;
    }catch(e){ fail++; console.warn('[desktop] v2→v3：附件入庫失敗 ' + rows[i].path, e); }
  }
  // 舊附件目錄改名做備份（app 之後唔再讀寫佢；用戶確認無誤可手動刪除）
  try{
    await invoke('plugin:fs|rename',
      { oldPath: base + '/attachments', newPath: base + '/attachments.pre-v3-backup' });
  }catch(e){ /* 無目錄／改名失敗都唔阻 migration */ }
  await dbPort.execute('INSERT OR IGNORE INTO schema_version(version) VALUES (4)');
  console.log('[desktop] v2→v3 附件入庫完成：' + ok + ' 成功，' + fail + ' 失敗');
  return { ok: ok, fail: fail };
}

/* ---------- 4. 持久化（debounced + hash 去重，單一 transaction） ---------- */
var lastStableHash = null, persistTimer = null, dbWriteEnabled = true;
var currentCompanyName = ''; // v3.25.0：當前數據庫嘅公司名（存 app_state.company_name）
function stablePayloadString(payload){
  var d = payload.data || {};
  return JSON.stringify([d.vouchers, d.accounts, d.openingBalances, d.openingInvoiceDetails,
    d.fiscalYears, d.salesInvoices, d.purchaseInvoices, d.allocations, d.allocationReview,
    d.reconciliationConfirmations, d.balanceAdjustments, d.invoiceRemarks,
    d.staffNames, d.suppressedStaffNames, d.deletedDataYears, d.settings,
    d.lastVoucherDates, d.reportState, d.currentRoute, d.workingVoucher]);
}
function strHash(s){
  var h = 0, i;
  for(i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h + '_' + s.length;
}
function setStatus(t){
  var el = document.getElementById('backupStatus');
  if(el) el.textContent = t;
}
/* ---------- 4b. Native 下載（經 __TG__.setNativeDownload 掛入 shim 的 openDownloadPopup） ----------
 * 桌面版唔彈 OS browser 新視窗：直接用 Tauri dialog 揀位＋fs 寫檔。
 * 回傳 {desktopSaved} / {desktopCancelled} / null（失敗），由 shim 轉做狀態文字。 */
async function nativeDownload(blob, filename, title){
  var buf = new Uint8Array(await blob.arrayBuffer());
  var path = await dlgSave({ title: title || '儲存檔案', defaultPath: filename });
  if(!path) return { desktopCancelled: true };
  if(Array.isArray(path)) path = path[0];
  await fsWriteBytes(path, buf);
  return { desktopSaved: String(path).split('/').pop() };
}
/* 持久化互斥：SQLite 係單連接，兩個 persist 重疊會令第二次 BEGIN 失敗。
 * 2026-10-08 修：debounced persist（任何 click 觸發）曾經同 doImportVouchers
 * 嘅直接 persistNow 重疊，import 嗰次寫庫靜默失敗、UI 照報成功 → 丟數據。
 * 而家所有 persist 排隊執行，唔會再有兩個 transaction 同時進行。 */
var persistChain = Promise.resolve();
function persistNow(){
  if(!dbWriteEnabled) return Promise.resolve();
  var run = persistChain.then(persistNowInner);
  persistChain = run.catch(function(){}); // 斷鏈保護：失敗唔影響之後排隊
  return run;
}
async function persistNowInner(){
  try{
    var payload = await TG.createBackupPayload();
    // v3.25.0：注入公司名（桌面版獨有，web BackupSettings 無此欄）
    try{
      if(!payload.data) payload.data = {};
      if(!payload.data.settings) payload.data.settings = {};
      payload.data.settings.companyName = currentCompanyName || '';
    }catch(e){}
    var h = strHash(stablePayloadString(payload));
    if(h === lastStableHash){ return; }
    // 空白賬套（0 科目）唔寫庫：app 自身 validateBackup 要求至少一個科目，
    // 寫咗 reload 讀唔返；blankStart 係 deterministic，reload 重做即可。
    var d = payload.data || {};
    if(!d.accounts || !d.accounts.length){
      lastStableHash = h;
      return;
    }
    await extractAttachments(payload);
    await DB.persistPayload(dbPort, payload);   // 單一 transaction，crash-safe
    lastStableHash = h;
    setStatus('已自動儲存 · ' + new Date().toLocaleTimeString('zh-HK', {hour:'2-digit',minute:'2-digit',second:'2-digit'}));
  }catch(e){ console.error('[desktop] persist failed:', e); }
}
function schedulePersist(){
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, 1500);
}

/* ---------- 5. 啟動 ---------- */
async function startup(){
  try{
    var cfg = await readConfig();
    if(cfg.dbPath && typeof cfg.dbPath === 'string') customDbPath = cfg.dbPath;
  }catch(e){ console.warn('[desktop] 讀 config 失敗，用預設數據位置：', e); }
  var init;
  try{ init = await sqlInit(); }
  catch(e){ setStatus('SQLite 初始化失敗：' + (e.message || e)); return; }

  injectDesktopUI();
  injectVoucherExportBtn();
  injectSettingsNav();
  injectSettingsView();

  // 桌面版下載改行 native：備份 JSON／CSV 唔經 window.open popup，直接 dialog＋fs 落檔
  try{ TG.setNativeDownload(nativeDownload); }
  catch(e){ console.error('[desktop] setNativeDownload failed:', e); }

  // v3.22.1: voucher 列表加附件按鈕（桌面獨有 patch，唔改 web-src）
  // 原生 renderVoucherList 唔顯示附件；各處（入賬／匯入／還原／搜尋）都係直接
  // import 呼叫原函數，wrap TG 橋接版本唔會生效（v3.22.0 曾經咁做但實際無效）。
  // 改用 MutationObserver 監察 #voucherListBody：任何重繪後自動補上 📎 按鈕。
  try{
    if(TG.attachmentButtonHTML && TG.openAttachmentList){
      var decorating = false;
      var decorateVoucherList = function(){
        try{
          var body = document.getElementById('voucherListBody');
          if(!body) return;
          var rows = body.querySelectorAll('tr');
          for(var i = 0; i < rows.length; i++){
            var row = rows[i];
            if(row.querySelector('.attachment-btn')) continue; // 呢行已處理
            var editBtn = row.querySelector('.edit-voucher');
            if(!editBtn) continue;
            var idx = Number(editBtn.getAttribute('data-index'));
            if(isNaN(idx)) continue;
            var btnHtml = TG.attachmentButtonHTML(idx);
            if(!btnHtml) continue; // 無附件唔加
            var cells = row.querySelectorAll('td');
            var b = cells.length > 1 && cells[1].querySelector('b');
            if(!b) continue;
            b.insertAdjacentHTML('afterend', btnHtml);
            var newBtn = cells[1].querySelector('.attachment-btn');
            if(newBtn){
              // 只綁新加嘅按鈕，唔重綁舊嘅（避免重複 listener）
              (function(index, btn){
                btn.addEventListener('click', function(){ TG.openAttachmentList(index); });
              })(idx, newBtn);
            }
          }
        }catch(e){ console.error('[desktop] voucher list attachment patch failed:', e); }
      };
      var voucherListBody = document.getElementById('voucherListBody');
      if(voucherListBody){
        var voucherListObs = new MutationObserver(function(){
          if(decorating) return;
          decorating = true;
          try{ decorateVoucherList(); }finally{ decorating = false; }
        });
        voucherListObs.observe(voucherListBody, { childList: true, subtree: true });
        decorateVoucherList(); // 初次渲染都 patch
      }
    }
  }catch(e){ console.error('[desktop] voucher list attachment observer failed:', e); }

  // 工具欄 JSON 還原（app 原生 modal）完成後：無論 dbWriteEnabled 係咩狀態，
  // 只要有數據就直接寫庫。唔依賴 debounced persist，確保一定寫入。
  // 注意：modal 係直接 import backup.ts 嘅 applyPreparedRestore，唔經 TG，所以攔截掣。
  document.addEventListener('click', function(e){
    try{
      var t = e.target;
      if(!t || t.id !== 'confirmRestore') return;
      // 兩步確認：第一步係「繼續」，第二步先係「確認還原」
      if(t.textContent.indexOf('確認還原') < 0) return;
      setTimeout(function(){
        (async function(){
          try{
            var payload = await TG.createBackupPayload();
            var d = payload && payload.data;
            if(d && d.accounts && d.accounts.length){
              console.log('[desktop] 工具欄還原後直接寫庫…');
              await DB.persistPayload(dbPort, payload);
              lastStableHash = strHash(stablePayloadString(payload));
              // 如果之前暫停咗自動儲存，而家恢復
              if(!dbWriteEnabled){
                dbWriteEnabled = true;
                var rb = document.getElementById('tgResumeSave');
                if(rb) rb.remove();
              }
              try{ await refreshTableList(); }catch(e2){}
              console.log('[desktop] 工具欄還原寫庫完成');
            }else{
              console.log('[desktop] 工具欄還原後無數據，跳過寫庫');
            }
          }catch(err){ 
            console.error('[desktop] toolbar restore persist failed:', err);
            try{ setStatus('還原後寫入數據庫失敗：' + (err.message || err)); }catch(e2){}
          }
        })();
      }, 800);
    }catch(err){}
  }, true);

  // 任何用戶互動 → debounced persist（唔靠 app 內部 hook，唔會漏）
  ['click', 'change', 'input', 'submit'].forEach(function(ev){
    document.addEventListener(ev, function(){ schedulePersist(); }, { capture: true, passive: true });
  });
  // 盡量喺離開前 flush
  document.addEventListener('visibilitychange', function(){
    if(document.visibilityState === 'hidden'){ clearTimeout(persistTimer); persistNow(); }
  });
  window.addEventListener('pagehide', function(){ clearTimeout(persistTimer); persistNow(); });

  try{
    await loadAppStateFromDb(init, true);
  }catch(e){
    // 讀取失敗：唔好用空白覆蓋個庫——暫停自動儲存，等用戶用「匯入 JSON 備份」還原
    console.error('[desktop] 啟動還原失敗：', e);
    dbWriteEnabled = false;
    try{ TG.blankStart(); }catch(e2){}
    setStatus('本機賬套讀取失敗，已暫停自動儲存，請用「匯入 JSON 備份」還原');
    showResumeSaveButton();
  }
}

/* 由已連接嘅 DB 載入 app 狀態（啟動＋切換數據位置＋匯入後共用）。
 * isStartup 只影響狀態文字。 */
async function loadAppStateFromDb(init, isStartup){
  if(init.isFresh){
    // 全新：建 schema_version(3)，空白賬套起步
    await DB.seedFresh(dbPort);
    TG.blankStart();
    lastStableHash = null;
    await persistNow();
    setStatus(isStartup ? '已建立本機賬套（空白）' : '已在新位置建立空白賬套');
    return;
  }
  if(init.needsMigration){
    // v1 → v2/v3：先備份 .db，再經 app 自身 prepareRestore 正規化後寫入關聯表
    //（附件經 extractAttachments 已轉 dataB64，直接入 v3）
    setStatus('正在升級本機數據庫（v1→v3）…');
    await backupDbFile('pre-v2-migration');
    var raw = await kvGetLegacy('app_state');
    if(raw){
      var legacyPayload = JSON.parse(raw);
      await extractAttachments(legacyPayload);
      var res = await TG.prepareRestore(legacyPayload);  // v1 浮點→分，沿用 app 邏輯
      var normalized = {
        backupFormat: 'toys-gallery-accounting',
        schemaVersion: 2,
        appVersion: TG.desktopVersion,
        exportedAt: new Date().toISOString(),
        data: res.prepared
      };
      var counts = await DB.migrateFromPayload(dbPort, normalized);
      console.log('[desktop] migration v1→v3 完成：', JSON.stringify(counts));
    }else{
      await DB.seedFresh(dbPort);
    }
  }
  if(init.needsBlobMigration){
    // v2 → v3：附件檔案入 SQLite（先備份 .db）
    setStatus('正在升級本機數據庫（v2→v3：附件入庫）…');
    await backupDbFile('pre-v3-migration');
    var mig = await migrateAttachmentsToDb();
    setStatus('附件入庫完成：' + mig.ok + ' 個成功' + (mig.fail ? '，' + mig.fail + ' 個失敗（見 console）' : ''));
  }
  var dbPayload = await DB.loadPayload(dbPort);
  if(dbPayload){
    await reconstituteAttachments(dbPayload);
    var prepared = await TG.prepareRestore(dbPayload);
    TG.applyPreparedRestore(prepared.prepared);
    lastStableHash = strHash(stablePayloadString(dbPayload));
    // v3.25.0：讀公司名；空嘅話登入後提示補錄
    try{
      currentCompanyName = String((dbPayload.data && dbPayload.data.settings && dbPayload.data.settings.companyName) || '');
    }catch(e){ currentCompanyName = ''; }
    setStatus(init.needsMigration ? '數據庫已升級到 v3，本機賬套已載入' : '已載入本機賬套');
    updateCompanyNameUI();
    if(!currentCompanyName){
      setTimeout(promptCompanyName, 800);
    }
  }else{
    // v2 表係空（唔應該發生）：空白起步
    TG.blankStart();
    lastStableHash = null;
    currentCompanyName = '';
    await persistNow();
    setStatus('已建立本機賬套（空白）');
    updateCompanyNameUI();
    setTimeout(promptCompanyName, 800);
  }
}

/* v3.25.0：公司名補錄／修改 */
function promptCompanyName(){
  // 自動化測試（headless）跳過 prompt，唔好 block
  try{ if(navigator.webdriver) return; }catch(e){}
  var name = window.prompt('請輸入公司名稱（將顯示喺工具欄同匯出文件）：', currentCompanyName || '');
  if(name === null) return; // 取消
  name = String(name).trim();
  if(!name){
    // 吉名唔俾過，再問
    setTimeout(promptCompanyName, 300);
    return;
  }
  setCompanyName(name);
}
async function setCompanyName(name){
  currentCompanyName = String(name).trim();
  updateCompanyNameUI();
  lastStableHash = null; // 強制下次 persist 寫入
  try{ await persistNow(); }catch(e){}
}
function updateCompanyNameUI(){
  var el = document.getElementById('tgCompanyName');
  if(el) el.textContent = currentCompanyName || '（未設定公司名）';
}

/* 讀取失敗後：俾個掣手動恢復自動儲存（用戶已用 JSON 還原好之後撳） */
function showResumeSaveButton(){
  var bar = document.getElementById('tgDesktopTools');
  if(!bar || document.getElementById('tgResumeSave')) return;
  var b = document.createElement('button');
  b.className = 'btn'; b.type = 'button'; b.id = 'tgResumeSave';
  b.textContent = '恢復自動儲存';
  b.title = '確認已用 JSON 備份還原後，重新啟用自動儲存到本機數據庫';
  b.addEventListener('click', function(){
    dbWriteEnabled = true;
    lastStableHash = null;
    persistNow();
    b.remove();
  });
  bar.appendChild(b);
}

/* ---------- 6. 桌面版 UI（backup-tools 欄） ---------- */
function injectDesktopUI(){
  /* 桌面獨有：工具條收起／展開——收起時只顯示財政年度列 */
  (function toolbarCollapse(){
    var section = document.querySelector('.fiscal-bar');
    var main = document.querySelector('.fiscal-main');
    if(!section || !main || document.getElementById('tgToolsToggle')) return;
    var tgl = document.createElement('button');
    tgl.className = 'btn tg-toggle'; tgl.type = 'button'; tgl.id = 'tgToolsToggle';
    function setTgl(expanded){
      section.classList.toggle('tg-collapsed', !expanded);
      tgl.textContent = expanded ? '收起工具 ▴' : '展開工具 ▾';
      tgl.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    }
    tgl.addEventListener('click', function(){
      var expanded = section.classList.contains('tg-collapsed');
      setTgl(expanded);
      readConfig().then(function(cfg){ cfg.toolbarExpanded = expanded; return writeConfig(cfg); })
        .catch(function(){});
    });
    main.appendChild(tgl);
    readConfig().then(function(cfg){ setTgl(!!cfg.toolbarExpanded); })
      .catch(function(){ setTgl(false); });
  })();

  var bar = document.querySelector('.backup-tools');
  if(!bar || document.getElementById('tgDesktopTools')) return;
  // v3.24.0：隱藏 web 原生備份按鈕（下載備份／複製備份／還原備份），桌面版改用 SQLite
  ['backupData', 'copyBackupData', 'restoreData'].forEach(function(id){
    var b = document.getElementById(id);
    if(b) b.style.display = 'none';
  });
  var restoreFile = document.getElementById('restoreFile');
  if(restoreFile) restoreFile.style.display = 'none';
  var wrap = document.createElement('span');
  wrap.id = 'tgDesktopTools';
  wrap.style.cssText = 'display:inline-flex;gap:6px;margin-left:6px;flex-wrap:wrap;';
  function mk(id, label, title, fn){
    var b = document.createElement('button');
    b.className = 'btn'; b.type = 'button'; b.id = id;
    b.textContent = label; b.title = title || label;
    b.addEventListener('click', fn);
    return b;
  }
  // v3.24.0：工具欄只保留 Excel 相關；移除「匯入 JSON 備份」
  wrap.appendChild(mk('tgExportExcel', '匯出 Excel 報表', '9 份報表匯出為 .xlsx', exportExcelReports));
  wrap.appendChild(mk('tgVoucherTpl', '下載 Voucher 範本', '下載 Voucher 批量匯入範本（含科目下拉選單）', downloadVoucherTemplate));
  wrap.appendChild(mk('tgVoucherImportTb', '匯入 Voucher', '從資料夾匯入 Voucher Excel＋附件', function(){ onImportVoucherExcel(true); }));
  wrap.appendChild(mk('tgDownloadTemplate', '下載科目範本', '下載 Excel 匯入範本（科目表＋期初數）', downloadImportTemplate));
  wrap.appendChild(mk('tgImportExcel', '匯入科目 Excel', '從 Excel 匯入科目表＋期初數', importExcelData));
  // v3.25.0：公司名顯示＋修改
  var coWrap = document.createElement('span');
  coWrap.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin-left:8px;padding:4px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface-2);';
  coWrap.title = '當前數據庫嘅公司';
  var coLabel = document.createElement('span');
  coLabel.style.cssText = 'font-size:11px;color:var(--muted);';
  coLabel.textContent = '公司：';
  var coName = document.createElement('b');
  coName.id = 'tgCompanyName';
  coName.style.cssText = 'font-size:13px;';
  coName.textContent = '（未設定）';
  var coEdit = document.createElement('button');
  coEdit.className = 'btn'; coEdit.type = 'button';
  coEdit.style.cssText = 'padding:3px 8px;font-size:11px;';
  coEdit.textContent = '修改';
  coEdit.title = '修改當前數據庫嘅公司名';
  coEdit.addEventListener('click', function(){
    var name = window.prompt('請輸入公司名稱：', currentCompanyName || '');
    if(name === null) return;
    name = String(name).trim();
    if(name) setCompanyName(name);
  });
  coWrap.appendChild(coLabel);
  coWrap.appendChild(coName);
  coWrap.appendChild(coEdit);
  wrap.appendChild(coWrap);
  var ver = document.createElement('span');
  var ver = document.createElement('span');
  ver.style.cssText = 'font-size:11px;color:#999;align-self:center;margin-left:4px;';
  ver.textContent = '桌面版 v' + TG.desktopVersion;
  wrap.appendChild(ver);
  bar.appendChild(wrap);
}

/* ---------- 7. JSON 備份匯入（web → 桌面遷移） ---------- */
async function importJSONBackup(){
  try{
    var path = await dlgOpen({ title: '選擇 JSON 備份檔',
      filters: [{ name: 'JSON 備份', extensions: ['json'] }], multiple: false });
    if(!path) return;
    if(Array.isArray(path)) path = path[0];
    setStatus('正在讀取備份檔…');
    var payload = JSON.parse(await fsReadText(path));
    TG.validateBackup(payload);                       // 唔啱格式即 throw
    var name = String(path).split('/').pop();
    await TG.beginRestore(payload, name);               // app 原有雙重確認 modal
    setStatus('備份檔已驗證，請在彈窗確認還原');
  }catch(e){
    setStatus('匯入失敗：' + (e.message || e));
  }
}

/* ---------- 8. Excel 匯出（9 份報表） ---------- */
var REPORT_SHEETS = [
  ['trial',    '試算表',       'Trial Balance'],
  ['pl',       '損益表',       'Profit & Loss'],
  ['bs',       '資產負債表',   'Balance Sheet'],
  ['ar',       '應收賬款賬齡', 'AR Aging'],
  ['ap',       '應付賬款賬齡', 'AP Aging'],
  ['purchase', '採購報告',     'Purchase Report'],
  ['sales',    '銷售報告',     'Sales Report'],
  ['journal',  '日記賬',       'Journal'],
  ['register', '憑證登記冊',   'Voucher Register']
];
function titleBlock(label, en){
  var fy = '';
  try{ fy = TG.fiscalLabel(); }catch(e){}
  var period = '';
  try{ period = TG.reportPeriodLabel(); }catch(e){}
  // v3.25.0：用當前公司名（未設定就用預設）
  var co = currentCompanyName || 'Toys Gallery International Limited';
  return [
    [co + ' — ' + label + ' ' + en],
    ['財政年度 ' + fy + (period ? ' · 月份 ' + period : ' · 全年') + ' · 匯出時間 ' + new Date().toLocaleString('zh-HK')],
    []
  ];
}
/* pl/bs：用 app 自己 render 出嚟嘅 HTML（div 結構，零邏輯重複） */
function statementToAOA(key){
  var html = TG.reportHTML(key);
  var div = document.createElement('div');
  div.innerHTML = html;
  var aoa = [];
  var heading = div.querySelector('.sheet-heading'), title = 'Toys Gallery International Limited';
  if(heading){
    var hs = heading.querySelector('strong'), hp = heading.querySelector('span');
    title = (hs ? hs.textContent.trim() : '') + (hp ? ' — ' + hp.textContent.trim() : '');
  }
  aoa.push([title]);
  aoa.push(['匯出時間 ' + new Date().toLocaleString('zh-HK')]);
  aoa.push([]);
  function lineRow(line){
    var cells = [];
    Array.prototype.forEach.call(line.children, function(ch){
      if(ch.tagName === 'SPAN') cells.push(ch.textContent.trim());
    });
    if(!cells.length)
      line.querySelectorAll('span').forEach(function(s){ cells.push(s.textContent.trim()); });
    if(line.className.indexOf('indent') >= 0 && cells[0]) cells[0] = '    ' + cells[0];
    while(cells.length < 3) cells.push('');
    return cells.slice(0, 3);
  }
  if(key === 'bs'){
    // 左右兩欄並排：左 A-C，右 E-G，中間 D 空一格
    var sides = div.querySelectorAll('.balance-sheet .balance-side'),
        left = [], right = [];
    sides.forEach(function(side, idx){
      var target = (idx === 0) ? left : right;
      side.querySelectorAll('.balance-line').forEach(function(line){ target.push(lineRow(line)); });
    });
    var n = Math.max(left.length, right.length), i;
    for(i = 0; i < n; i++){
      var l = left[i] || ['', '', ''], r = right[i] || ['', '', ''];
      aoa.push([l[0], l[1], l[2], '', r[0], r[1], r[2]]);
    }
  }else{
    div.querySelectorAll('.excel-statement .excel-line').forEach(function(line){
      aoa.push(lineRow(line));
    });
  }
  if(aoa.length <= 3) throw new Error('報表無內容：' + key);
  return aoa;
}
/* 睇落似金額嘅文字格 → 轉數字（保守：要有千分位逗號或小數點先轉，唔郁 ID 類純數字） */
function coerceNumbers(aoa){
  return aoa.map(function(row){
    return row.map(function(v){
      if(typeof v !== 'string') return v;
      var t = v.replace(/[\s ]/g, '').replace(/^(HK\$|＄)/i, '');
      if(!/[,.]/.test(t)) return v;
      var n = t.replace(/,/g, '');
      if(/^-?\d+(\.\d+)?$/.test(n) && n !== '') return parseFloat(n);
      return v;
    });
  });
}
function finalizeSheet(ws, headerRowIdx){
  var range = XLSX.utils.decode_range(ws['!ref']), r, c, addr, cell;
  for(r = range.s.r; r <= range.e.r; r++) for(c = range.s.c; c <= range.e.c; c++){
    addr = XLSX.utils.encode_cell({ r: r, c: c });
    cell = ws[addr];
    if(cell && typeof cell.v === 'number') cell.z = '#,##0.00';
  }
  var cols = [], cc;
  for(cc = range.s.c; cc <= range.e.c; cc++){
    var w = 10;
    for(r = range.s.r; r <= range.e.r; r++){
      cell = ws[XLSX.utils.encode_cell({ r: r, c: cc })];
      if(cell && cell.v != null)
        w = Math.max(w, Math.min(42, String(cell.v).length * 1.15 + 2));
    }
    cols.push({ wch: Math.round(w) });
  }
  ws['!cols'] = cols;
  if(range.e.c > 0) ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: range.e.c } }];
  // 自動篩選（表頭行 → 最後一行；pl/bs 係陳述式排版，唔加）
  if(headerRowIdx >= 0 && range.e.r > headerRowIdx){
    ws['!autofilter'] = { ref: XLSX.utils.encode_range(
      { r: headerRowIdx, c: range.s.c }, { r: range.e.r, c: range.e.c }) };
  }
  return ws;
}
async function exportExcelReports(){
  try{
    if(!window.XLSX){ setStatus('Excel 模組未載入'); return; }
    setStatus('正在產生 Excel…');
    var wb = XLSX.utils.book_new(), errors = [], polishOpts = [];
    REPORT_SHEETS.forEach(function(cfg){
      var key = cfg[0], label = cfg[1], en = cfg[2];
      var sheetName = (label + ' ' + en).slice(0, 31);
      try{
        var isStmt = (key === 'pl' || key === 'bs');
        var aoa = isStmt
          ? coerceNumbers(statementToAOA(key))   // 自帶標題列
          : coerceNumbers(TG.buildReportRows(key));
        var headRows = isStmt ? [] : titleBlock(label, en);
        var ws = XLSX.utils.aoa_to_sheet(headRows.concat(aoa));
        finalizeSheet(ws, isStmt ? -1 : 3);
        XLSX.utils.book_append_sheet(wb, ws, sheetName);
        // 後期加工：凍結窗格＋列印標題＋標題加粗（經 xlsx-polish＋JSZip 注入 XML）
        polishOpts.push(isStmt
          ? { name: sheetName, freezeRows: 3, titleRows: '1:2', boldRows: [0] }
          : { name: sheetName, freezeRows: 4, titleRows: '1:3', boldRows: [0] });
      }catch(e){
        errors.push(label + '：' + (e.message || e));
        var wsErr = XLSX.utils.aoa_to_sheet(titleBlock(label, en).concat([['此表匯出失敗：' + (e.message || e)]]));
        XLSX.utils.book_append_sheet(wb, wsErr, sheetName);
      }
    });
    var raw = new Uint8Array(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }));
    var out;
    try{
      if(!window.JSZip) throw new Error('JSZip 未載入');
      out = await TG.polishWorkbook(raw, polishOpts, window.JSZip);
    }catch(e){
      console.warn('[desktop] xlsx 後期加工失敗，用原檔：', e);
      out = raw;
    }
    var fy = String((function(){ try{ return TG.fiscalLabel(); }catch(e){ return ''; } })()).replace(/[^A-Za-z0-9-]/g, '-');
    // v3.24.2：報表匯出改為 zip（含 Journal 對應月份嘅附件，按 voucher number 分目錄）
    var zip = new window.JSZip();
    var xlsxName = 'Toys-Gallery-reports-' + fy + '.xlsx';
    zip.file(xlsxName, new Uint8Array(out));
    var jvouchers = [];
    try{ jvouchers = TG.getJournalVouchers ? TG.getJournalVouchers() : []; }catch(e){}
    var attCount = 0;
    for(var vi = 0; vi < jvouchers.length; vi++){
      var jv = jvouchers[vi];
      var jatts = jv.attachments || [];
      for(var ai = 0; ai < jatts.length; ai++){
        var ja = jatts[ai], jbytes = null;
        try{
          if(ja.dataURL && ja.dataURL.indexOf('data:') === 0){
            jbytes = dataURLToParts(ja.dataURL).bytes;
          }else if(ja.dataB64){
            jbytes = Uint8Array.from(atob(ja.dataB64), function(c){ return c.charCodeAt(0); });
          }
        }catch(e){}
        if(jbytes){
          zip.file('attachments/' + sanitizeName(jv.no) + '/' + sanitizeName(ja.name || 'attachment'), jbytes);
          attCount++;
        }
      }
    }
    var zipBytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    var path = await dlgSave({ title: '儲存 Excel 報表（含附件）',
      defaultPath: 'Toys-Gallery-reports-' + fy + '.zip',
      filters: [{ name: 'ZIP 壓縮檔', extensions: ['zip'] }] });
    if(!path){ setStatus('已取消匯出'); return; }
    await fsWriteBytes(path, new Uint8Array(zipBytes));
    var periodLabel = '';
    try{ periodLabel = TG.reportPeriodLabel ? TG.reportPeriodLabel() : ''; }catch(e){}
    setStatus('Excel 已匯出（9 份報表' + (periodLabel ? '，' + periodLabel : '') + '，' + attCount + ' 個附件）→ zip' +
      (errors.length ? '；' + errors.length + ' 份報表有問題' : ''));
  }catch(e){
    console.error('[desktop] excel export failed:', e);
    setStatus('匯出失敗：' + (e.message || e));
  }
}

/* ---------- 9. Excel 匯入：科目表＋期初數 ---------- */
var IMPORT_TYPES = ['資產', '負債', '權益', '收入', '成本', '費用'];
function downloadImportTemplate(){
  try{
    var wb = XLSX.utils.book_new();
    var wsHelp = XLSX.utils.aoa_to_sheet([
      ['Toys Gallery 會計系統 — Excel 匯入說明'],
      [''],
      ['1. 「科目表」：填科目編號、名稱、類別（限：資產／負債／權益／收入／成本／費用）。'],
      ['   已存在的科目編號會自動跳過唔匯入。'],
      ['2. 「期初數」：財年填 2024 即代表 FY2024/25（該財年必須已喺系統存在）。'],
      ['   科目名稱必須同科目表一模一樣；金額填數字。'],
      ['3. 第一行係標題列，請保留；下面嘅示例行請刪除後再填。'],
      ['4. 完成後喺系統撳「匯入 Excel」揀呢個檔。']
    ]);
    wsHelp['!cols'] = [{ wch: 80 }];
    XLSX.utils.book_append_sheet(wb, wsHelp, '說明');
    var wsAcc = XLSX.utils.aoa_to_sheet([
      ['科目編號 Code', '科目名稱 Name', '類別 Type'],
      ['1000', 'Bank Saving Account', '資產'],
      ['4000', 'Sales', '收入']
    ]);
    wsAcc['!cols'] = [{ wch: 18 }, { wch: 42 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, wsAcc, '科目表');
    var wsOp = XLSX.utils.aoa_to_sheet([
      ['財年 FiscalYear', '科目名稱 AccountName', '金額 Amount'],
      ['2024', 'Bank Saving Account', 15564.22]
    ]);
    wsOp['!cols'] = [{ wch: 18 }, { wch: 42 }, { wch: 18 }];
    XLSX.utils.book_append_sheet(wb, wsOp, '期初數');
    var out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    dlgSave({ title: '下載匯入範本',
      defaultPath: 'Toys-Gallery-import-template.xlsx',
      filters: [{ name: 'Excel 活頁簿', extensions: ['xlsx'] }] })
      .then(function(path){
        if(!path){ setStatus('已取消下載'); return null; }
        return fsWriteBytes(path, new Uint8Array(out)).then(function(){ setStatus('範本已下載'); });
      })
      .catch(function(e){ setStatus('下載失敗：' + (e.message || e)); });
  }catch(e){ setStatus('下載失敗：' + (e.message || e)); }
}
function findHeaderRow(rows, test){
  for(var i = 0; i < Math.min(rows.length, 10); i++){
    var r = rows[i] || [];
    for(var j = 0; j < r.length; j++) if(test(String(r[j]))) return i;
  }
  return -1;
}
async function importExcelData(){
  try{
    var path = await dlgOpen({ title: '選擇 Excel 匯入檔',
      filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }], multiple: false });
    if(!path) return;
    if(Array.isArray(path)) path = path[0];
    setStatus('正在讀取 Excel…');
    var wb = XLSX.read(await fsReadBytes(path), { type: 'array' });
    var imp = { accounts: [], opening: [] };

    var wsAcc = wb.Sheets['科目表'] || wb.Sheets['Accounts'];
    if(wsAcc){
      var rows = XLSX.utils.sheet_to_json(wsAcc, { header: 1, defval: '' });
      var hi = findHeaderRow(rows, function(c){ return /科目編號|Code/i.test(c); });
      if(hi >= 0) for(var i = hi + 1; i < rows.length; i++){
        var code = String(rows[i][0] || '').trim(),
            name = String(rows[i][1] || '').trim(),
            type = String(rows[i][2] || '').trim();
        if(!code && !name) continue;
        imp.accounts.push({ code: code, name: name, type: type });
      }
    }
    var wsOp = wb.Sheets['期初數'] || wb.Sheets['Opening'];
    if(wsOp){
      var rows2 = XLSX.utils.sheet_to_json(wsOp, { header: 1, defval: '' });
      var hi2 = findHeaderRow(rows2, function(c){ return /財年|FiscalYear/i.test(c); });
      if(hi2 >= 0) for(var j = hi2 + 1; j < rows2.length; j++){
        var fy = String(rows2[j][0] || '').trim(),
            account = String(rows2[j][1] || '').trim(),
            amount = Number(String(rows2[j][2]).replace(/,/g, ''));
        if(!fy && !account) continue;
        imp.opening.push({ fy: fy, account: account, amount: amount });
      }
    }
    if(!imp.accounts.length && !imp.opening.length){ setStatus('Excel 內無可匯入資料'); return; }

    var res = TG.importExcelData(imp);
    schedulePersist();
    setStatus('匯入完成：科目新增 ' + res.addedAccounts + '（跳過 ' + res.skippedAccounts +
      '）· 期初數 ' + res.setOpening + ' 筆' + (res.openingErrors ? '（' + res.openingErrors + ' 筆失敗：財年／科目唔啱）' : ''));
  }catch(e){
    console.error('[desktop] excel import failed:', e);
    setStatus('匯入失敗：' + (e.message || e));
  }
}

/* ---------- 9b. 桌面設置（桌面獨有 view；web-src 零改動） ----------
 * 入口：側欄 nav 注入「桌面設置」掣（無 data-route，web-src navigate() 唔會理）。
 * 開啟時隱藏 #appShell（web app root），關閉還原。全部 DOM／CSS 由呢度擁有。 */
var DESKTOP_CHANGELOG = [
  ['3.25.0', '新增公司名：存 app_state kv 表；空庫登入提示補錄；工具欄顯示＋修改；匯出報表／Voucher 帶公司名。'],
  ['3.24.2', '修復匯入附件對應錯位（改用 voucherNo→路徑映射）；匯出 Excel 報表改為 zip（含 Journal 對應月份附件，按 voucher 號分目錄）。'],
  ['3.24.1', '修復從資料夾匯入 Voucher 無反應：dialog 加 try-catch＋錯誤提示；空資料夾／冇 Excel 會有明確提示。'],
  ['3.24.0', '工具欄精簡：移除下載／複製／還原備份＋匯入 JSON；新增下載 Voucher 範本（含科目下拉選單）＋從資料夾匯入 Voucher；科目範本保留。'],
  ['3.23.0', 'Voucher Excel 匯入改為資料夾模式：揀一個資料夾（內含 Excel＋附件），M 欄填附件檔名，系統自動喺資料夾內搵檔匯入。'],
  ['3.22.1', '修復兩個 v3.22.0 問題：(1) 匯入流程靜默丟數據——debounced 寫庫同匯入嘅直接寫庫重疊，第二次 transaction 失敗但 UI 照報成功，寫庫而家排隊執行唔再重疊；(2) voucher 列表 📎 按鈕實際無顯示——舊實現 wrap 咗無人呼叫嘅橋接函數，改用 MutationObserver，任何重繪（入賬／匯入／還原／搜尋）後自動補上按鈕。'],
  ['3.22.0', 'Voucher Excel 匯入支援附件：第 13 欄填檔案路徑（; 分隔），匯入自動讀檔入庫；voucher 列表加 📎 附件按鈕。'],
  ['3.21.5', '匯入去重：accounts／vouchers／invoices 重複時保留最後一筆，唔再爆 UNIQUE 錯誤；side 缺失自動推斷。'],
  ['3.21.5', '修復設置 JSON 匯入寫庫失敗：備份科目缺 side 時由類別自動推斷（資產/成本/費用=借方，其餘=貸方），唔再成個 transaction rollback 令表預覽全 0。'],
  ['3.21.4', '工具欄 JSON 還原後無論咩狀態都直接寫庫（唔再依賴 debounced persist）；寫庫失敗會顯示錯誤。'],
  ['3.21.3', '修復工具欄 JSON 還原後唔自動寫庫：改攔截確認掣（之前 wrap 錯函數）；設置匯入加空數據預警。'],
  ['3.21.2', '修復 voucher 簽名列第三格爆出容器：改用固定三欄 minmax(0,1fr)；修補手機版單欄被覆蓋問題。'],
  ['3.21.1', '修復設置界面深色模式睇唔到字：改用 app 本身嘅 --ink／--line／--surface-2 變量。'],
  ['3.21.0', 'MCP 加 voucher 錄入：create_voucher（驗證借貸平衡／科目存在後排入待匯入）＋設置「待匯入 Voucher」一鍵匯入；手寫單相片經 Codex 識別流程見 mcp-server/VOUCHER_ENTRY.md。'],
  ['3.20.0', '設置新增「附件管理」（統計／列表／異常檢查／匯出全部／刪除舊備份）同「MCP 服務」（一鍵複製 Codex 接入設定）。'],
  ['3.19.0', '新增 MCP Server（mcp-server/）：Codex 等 AI 可經 MCP 唯讀查詢賬套（voucher／明細賬／附件／SQL）；金額回整數分＋dollars 字串。'],
  ['3.18.0', '附件入 SQLite：附件內容改存數據庫（base64），唔再寫實體檔；單檔備份、唔怕孤兒檔；v2 舊庫自動遷移（先備份 DB，舊附件目錄改名保留）。'],
  ['3.17.2', '修復 JSON 匯入讀檔 bug：真 Tauri 回傳 ArrayBuffer，舊代碼轉換出空字串導致「Unexpected EOF」；讀檔改用官方 plugin-fs 寫法。'],
  ['3.17.1', 'Badge 同時顯示桌面版＋核心版本；簽名列自適應（窄位自動換行唔爆出）；工具條可收起／展開（收起只顯示財政年度列）。'],
  ['3.17.0', 'Excel 完整支援：Voucher 批量匯入（範本＋驗證＋預覽）、Voucher 批量匯出俾會計師（總表＋明細＋附件 zip）、報表 xlsx 執靚（凍結窗格／列印標題／標題加粗／自動篩選）。'],
  ['3.16.0', '新增「桌面設置」：指定數據庫位置、數據庫表預覽、從 Web JSON 匯入到 SQLite。'],
  ['3.15.1', '關聯式 SQLite 存儲（18 張表）、自動持久化、金額改整數分；底層重構為 TypeScript 模塊。']
];
function escHtml(s){
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}
function setSettingsStatus(t){
  var el = document.getElementById('tgSettingsStatus');
  if(el) el.textContent = t;
}
function injectSettingsNav(){
  var nav = document.querySelector('#desktopSidebar nav.nav');
  if(!nav || document.getElementById('tgSettingsNav')) return;
  var b = document.createElement('button');
  b.type = 'button'; b.id = 'tgSettingsNav';
  b.innerHTML = '<svg viewBox="0 0 24 24"><path d="M19.4 13a7.5 7.5 0 0 0 0-2l2-1.5-2-3.5-2.4 1a7.5 7.5 0 0 0-1.7-1L14.9 3h-4l-.4 2.5a7.5 7.5 0 0 0-1.7 1l-2.4-1-2 3.5L6.4 11a7.5 7.5 0 0 0 0 2l-2 1.5 2 3.5 2.4-1a7.5 7.5 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.5 7.5 0 0 0 1.7-1l2.4 1 2-3.5-2-1.5zM12 15.5A3.5 3.5 0 1 1 15.5 12 3.5 3.5 0 0 1 12 15.5z"/></svg>桌面設置';
  b.title = '桌面版設置：數據位置、數據庫預覽、匯入';
  b.addEventListener('click', openSettings);
  nav.appendChild(b);
}
function injectSettingsView(){
  if(document.getElementById('tgSettingsView')) return;
  var css =
    '#tgSettingsView{position:fixed;inset:0;z-index:9999;overflow:auto;background:var(--bg,#f4f1ea);color:var(--ink,#222);}' +
    '#tgSettingsView[hidden]{display:none;}' +
    '.tgset-top{max-width:960px;margin:0 auto;padding:20px 20px 0;display:flex;justify-content:space-between;align-items:flex-start;gap:12px;}' +
    '.tgset-top h2{margin:0;}' +
    '.tgset-ver{color:var(--muted,#888);font-size:13px;margin-top:4px;}' +
    '.tgset-changelog{max-width:960px;margin:12px auto 0;padding:12px 20px;background:var(--surface,#fff);border:1px solid var(--line,#e2ddd2);border-radius:8px;}' +
    '.tgset-changelog ul{margin:6px 0 0;padding-left:20px;}' +
    '.tgset-changelog li{margin:4px 0;}' +
    '.tgset-sec{max-width:960px;margin:12px auto 0;padding:16px 20px;background:var(--surface,#fff);border:1px solid var(--line,#e2ddd2);border-radius:8px;}' +
    '.tgset-sec h3{margin:0 0 8px;}' +
    '.tgset-sec code{word-break:break-all;background:var(--surface-2,#f0ede6);color:var(--ink,#222);padding:2px 6px;border-radius:4px;font-size:12px;}' +
    '.tgset-status{max-width:960px;margin:12px auto 32px;padding:0 20px;min-height:24px;font-weight:bold;}' +
    '.tgset-gridwrap{overflow:auto;max-height:420px;border:1px solid var(--line,#e2ddd2);border-radius:6px;margin-top:8px;}' +
    '.tgset-grid{border-collapse:collapse;font-size:12px;min-width:100%;}' +
    '.tgset-grid th,.tgset-grid td{border:1px solid var(--line,#e8e4d9);padding:4px 8px;text-align:left;white-space:nowrap;}' +
    '.tgset-grid th{background:var(--surface-2,#f5f2ea);position:sticky;top:0;}' +
    '.tgset-tablebtn{margin:2px;}' +
    '#tgDbSwitchConfirm,#tgImportSummary{margin-top:10px;padding:12px;border:1px dashed #c9a227;border-radius:6px;background:var(--surface-2,#fffdf5);}' +
    '#tgDbSwitchConfirm[hidden],#tgImportSummary[hidden]{display:none;}' +
    '.tgset-sec .muted{color:var(--muted,#888);}' +
    '.tgset-sec .small{font-size:12px;}' +
    '.tgset-sec .error{color:var(--bad,#c00);}' +
    '#tgMcpConfig{background:var(--surface-2,#f0ede6)!important;color:var(--ink,#222)!important;}';
  var style = document.createElement('style');
  style.id = 'tgSettingsStyle';
  style.textContent = css;
  document.head.appendChild(style);
  var changelogHtml = DESKTOP_CHANGELOG.map(function(e){
    return '<li><b>v' + escHtml(e[0]) + '</b> ' + escHtml(e[1]) + '</li>';
  }).join('');
  var div = document.createElement('div');
  div.id = 'tgSettingsView';
  div.hidden = true;
  div.innerHTML =
    '<div class="tgset-top"><div><h2>⚙ 桌面版設置</h2>' +
    '<div class="tgset-ver">桌面版 <strong>v' + escHtml(TG.desktopVersion) + '</strong> ＋ Web 核心 <strong>v3.15.1</strong></div></div>' +
    '<button class="btn" id="tgSettingsClose" type="button">✕ 關閉</button></div>' +
    '<div class="tgset-changelog"><strong>桌面版更新日誌</strong><ul>' + changelogHtml + '</ul></div>' +
    '<section class="tgset-sec"><h3>數據位置</h3>' +
    '<p class="muted">目前 SQLite 數據庫檔案：</p>' +
    '<p><code id="tgDbPath">（載入中…）</code> <span class="muted small" id="tgDbPathNote"></span></p>' +
    '<p><button class="btn" id="tgPickDbFile" type="button">選擇數據庫檔案…</button> ' +
    '<button class="btn" id="tgPickDbDir" type="button">選擇資料夾…</button> ' +
    '<button class="btn" id="tgResetDbPath" type="button">重設為預設位置</button></p>' +
    '<p class="muted small">切換前會先將未儲存嘅改動寫入舊庫；目標如已有數據庫會直接載入（舊版自動升級，並先備份）。v3.18 起附件存入 SQLite，會跟數據庫一齊搬。</p>' +
    '<div id="tgDbSwitchConfirm" hidden></div></section>' +
    '<section class="tgset-sec"><h3>數據庫表預覽 <span class="muted small">（只讀）</span></h3>' +
    '<p><button class="btn" id="tgRefreshTables" type="button">重新整理</button></p>' +
    '<div id="tgTableList"></div><div id="tgTablePreview"></div></section>' +
    '<section class="tgset-sec"><h3>從 Web JSON 匯入到 SQLite</h3>' +
    '<p><button class="btn" id="tgPickJson" type="button">選擇 JSON 備份檔…</button></p>' +
    '<p class="muted small">支援 web 版下載嘅 JSON 備份（schema v1／v2）。匯入前會先備份目前數據庫。</p>' +
    '<div id="tgImportSummary" hidden></div></section>' +
    '<section class="tgset-sec"><h3>Excel — Voucher 批量匯入</h3>' +
    '<p><button class="btn" id="tgVoucherTpl" type="button">下載 Voucher 匯入範本</button> ' +
    '<button class="btn" id="tgVoucherImport" type="button">從資料夾匯入 Voucher…</button></p>' +
    '<p class="muted small">將 Excel 範本＋附件放喺同一個資料夾，M 欄填附件檔名（多個用 ; 分隔）。撳上面個掣揀資料夾，系統會自動搵 Excel 讀取，並按檔名喺資料夾內搵附件匯入。</p>' +
    '<div id="tgVoucherImportBox" hidden></div></section>' +
    '<section class="tgset-sec"><h3>附件管理 <span class="muted small">（v3.18 起附件存入 SQLite）</span></h3>' +
    '<p><button class="btn" id="tgAttRefresh" type="button">重新整理</button> ' +
    '<button class="btn" id="tgAttExport" type="button">匯出全部附件 (zip)…</button> ' +
    '<button class="btn" id="tgAttCleanBackup" type="button" hidden>刪除舊附件備份</button></p>' +
    '<p class="muted" id="tgAttStats">（載入中…）</p>' +
    '<div class="tgset-gridwrap" id="tgAttListWrap" hidden><table class="tgset-grid"><thead><tr>' +
    '<th>Voucher</th><th>檔名</th><th>類型</th><th>大小</th><th>狀態</th>' +
    '</tr></thead><tbody id="tgAttList"></tbody></table></div>' +
    '<p class="muted small">舊版（v2）附件目錄升級時已改名做 <code>attachments.pre-v3-backup</code> 保留，確認入庫無誤後可刪除。</p></section>' +
    '<section class="tgset-sec"><h3>MCP 服務 <span class="muted small">（俾 Codex 等 AI 唯讀查詢賬套）</span></h3>' +
    '<p class="muted small">MCP Server 以唯讀方式開啟數據庫，唔會影響正常使用，亦唔會改到數據。' +
    'Codex 喺 <code>~/.codex/config.toml</code> 加入以下設定即可接入（DB 路徑已自動填好）：</p>' +
    '<pre id="tgMcpConfig" style="padding:10px 12px;border-radius:6px;font-size:12px;overflow:auto;white-space:pre-wrap;word-break:break-all;">（載入中…）</pre>' +
    '<p><button class="btn" id="tgMcpCopyCfg" type="button">複製 Codex 設定</button> ' +
    '<button class="btn" id="tgMcpCopyPath" type="button">複製 DB 路徑</button> ' +
    '<span class="muted small" id="tgMcpNote"></span></p></section>' +
    '<section class="tgset-sec"><h3>待匯入 Voucher <span class="muted small">（MCP／Codex 識別手寫單後入呢度）</span></h3>' +
    '<p><button class="btn" id="tgPendRefresh" type="button">重新整理</button></p>' +
    '<p class="muted" id="tgPendStats">（載入中…）</p>' +
    '<div class="tgset-gridwrap" id="tgPendListWrap" hidden><table class="tgset-grid"><thead><tr>' +
    '<th>ID</th><th>日期</th><th>摘要</th><th>分錄</th><th>金額</th><th>附件</th><th>操作</th>' +
    '</tr></thead><tbody id="tgPendList"></tbody></table></div>' +
    '<p class="muted small">匯入會經正常驗證＋過賬；附件（手寫單相片）會一齊入賬套。</p></section>' +
    '<div class="tgset-status" id="tgSettingsStatus" role="status" aria-live="polite"></div>';
  document.body.appendChild(div);
  document.getElementById('tgSettingsClose').addEventListener('click', closeSettings);
  document.getElementById('tgPickDbFile').addEventListener('click', onPickDbFile);
  document.getElementById('tgPickDbDir').addEventListener('click', onPickDbDir);
  document.getElementById('tgResetDbPath').addEventListener('click', onResetDbPath);
  document.getElementById('tgRefreshTables').addEventListener('click', refreshTableList);
  document.getElementById('tgPickJson').addEventListener('click', onPickImportJson);
  document.getElementById('tgVoucherTpl').addEventListener('click', downloadVoucherTemplate);
  document.getElementById('tgVoucherImport').addEventListener('click', onImportVoucherExcel);
  document.getElementById('tgAttRefresh').addEventListener('click', refreshAttachmentManager);
  document.getElementById('tgAttExport').addEventListener('click', exportAllAttachments);
  document.getElementById('tgAttCleanBackup').addEventListener('click', cleanupPreV3Backup);
  document.getElementById('tgMcpCopyCfg').addEventListener('click', copyMcpConfig);
  document.getElementById('tgMcpCopyPath').addEventListener('click', copyMcpDbPath);
  document.getElementById('tgPendRefresh').addEventListener('click', refreshPendingVouchers);
  document.addEventListener('keydown', function(e){
    var v = document.getElementById('tgSettingsView');
    if(e.key === 'Escape' && v && !v.hidden) closeSettings();
  });
}
function openSettings(){
  document.getElementById('appShell').style.display = 'none';
  var v = document.getElementById('tgSettingsView');
  v.hidden = false;
  window.scrollTo(0, 0);
  refreshSettings();
}
function closeSettings(){
  var v = document.getElementById('tgSettingsView');
  if(v) v.hidden = true;
  document.getElementById('appShell').style.display = '';
}
async function refreshSettings(){
  setSettingsStatus('');
  hideSwitchConfirm();
  var box = document.getElementById('tgImportSummary');
  if(box){ box.hidden = true; box.innerHTML = ''; }
  pendingImport = null;
  var vbox = document.getElementById('tgVoucherImportBox');
  if(vbox){ vbox.hidden = true; vbox.innerHTML = ''; }
  pendingVoucherImport = null;
  await refreshSettingsDbPath();
  await refreshTableList();
  document.getElementById('tgTablePreview').innerHTML =
    '<p class="muted small">撳上面嘅表名預覽數據（頭 100 行，只讀）。</p>';
  await refreshAttachmentManager();
  await renderMcpSection();
  await refreshPendingVouchers();
}
async function refreshSettingsDbPath(){
  var el = document.getElementById('tgDbPath');
  if(!el) return;
  var p = await currentDbFilePath();
  el.textContent = p || '（未能確定）';
  document.getElementById('tgDbPathNote').textContent =
    customDbPath ? '自訂位置（tg-config.json）' : '預設位置';
}

/* ---------- 9c. 數據位置切換 ---------- */
var pendingSwitch = null; // {targetPath, exists, curPath, isReset}
function normPath(p){ return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); }
function hideSwitchConfirm(){
  var box = document.getElementById('tgDbSwitchConfirm');
  if(box){ box.hidden = true; box.innerHTML = ''; }
  pendingSwitch = null;
}
async function onPickDbFile(){
  var p = await dlgOpen({ title: '選擇數據庫檔案',
    filters: [{ name: 'SQLite 數據庫', extensions: ['db', 'sqlite', 'sqlite3'] }], multiple: false });
  if(!p) return;
  if(Array.isArray(p)) p = p[0];
  await proposeSwitch(String(p), false);
}
async function onPickDbDir(){
  var p = await dlgOpen({ title: '選擇數據存放資料夾', directory: true, multiple: false });
  if(!p) return;
  if(Array.isArray(p)) p = p[0];
  await proposeSwitch(String(p).replace(/\/+$/, '') + '/toys-gallery.db', false);
}
async function onResetDbPath(){
  await proposeSwitch(await defaultDbPath(), true);
}
async function proposeSwitch(targetPath, isReset){
  setSettingsStatus('');
  var cur = await currentDbFilePath();
  if(cur && normPath(cur) === normPath(targetPath)){
    setSettingsStatus(isReset && !customDbPath ? '已經係預設位置。' : '已經係呢個位置，無需切換。');
    return;
  }
  var exists = await fsExists(targetPath);
  pendingSwitch = { targetPath: targetPath, exists: exists, curPath: cur, isReset: !!isReset };
  var box = document.getElementById('tgDbSwitchConfirm');
  if(exists){
    box.innerHTML = '<p>目標已有數據庫檔案：<br><code>' + escHtml(targetPath) + '</code></p>' +
      '<p>切換後會載入佢嘅數據（舊版會先備份再升級）。目前賬套保留喺原位置，不受影響。</p>' +
      '<button class="btn primary" id="tgDbSwitchGo" type="button">確認切換</button> ' +
      '<button class="btn" id="tgDbSwitchCancel" type="button">取消</button>';
    box.hidden = false;
    document.getElementById('tgDbSwitchGo').addEventListener('click', function(){ doSwitch(false); });
    document.getElementById('tgDbSwitchCancel').addEventListener('click', hideSwitchConfirm);
  }else{
    box.innerHTML = '<p>目標位置冇數據庫檔案：<br><code>' + escHtml(targetPath) + '</code></p>' +
      '<button class="btn primary" id="tgDbSwitchCopy" type="button">將目前賬套複製過去</button> ' +
      '<button class="btn" id="tgDbSwitchBlank" type="button">喺新位置建立空白賬套</button> ' +
      '<button class="btn" id="tgDbSwitchCancel" type="button">取消</button>';
    box.hidden = false;
    document.getElementById('tgDbSwitchCopy').addEventListener('click', function(){ doSwitch(true); });
    document.getElementById('tgDbSwitchBlank').addEventListener('click', function(){ doSwitch(false); });
    document.getElementById('tgDbSwitchCancel').addEventListener('click', hideSwitchConfirm);
  }
}
async function doSwitch(copyOld){
  var sw = pendingSwitch;  // 先讀，hideSwitchConfirm 會清 null
  hideSwitchConfirm();
  if(!sw) return;
  var target = sw.targetPath;
  setSettingsStatus('正在切換數據位置…');
  try{ await persistNow(); }catch(e){}  // 先將未儲存改動寫入舊庫
  clearTimeout(persistTimer);
  dbWriteEnabled = false;
  var oldCustom = customDbPath;
  try{
    if(copyOld && sw.curPath){
      // 複製舊 DB 檔過去（源檔保留，唔刪除）
      await copyDbFile(sw.curPath, target);
    }else if(!sw.exists){
      // 新位置空白：確保目錄存在（plugin 會建檔，但唔會建目錄）
      var dir = target.replace(/[/\\][^/\\]*$/, '');
      if(dir) await fsMkdir(dir);
    }
    await closeDb();
    customDbPath = sw.isReset ? null : target;
    var init = await sqlInit();
    await loadAppStateFromDb(init, false);
    await writeConfig(sw.isReset ? {} : { dbPath: target });
    dbWriteEnabled = true;
    lastStableHash = null;
    await persistNow();
    await refreshSettingsDbPath();
    await refreshTableList();
    setSettingsStatus('已切換到：' + target);
  }catch(e){
    console.error('[desktop] 切換數據位置失敗：', e);
    try{  // 還原舊連接，唔好留空白
      await closeDb();
      customDbPath = oldCustom;
      var init2 = await sqlInit();
      await loadAppStateFromDb(init2, false);
      dbWriteEnabled = true;
      setSettingsStatus('切換失敗，已還原原位置：' + (e.message || e));
    }catch(e2){
      setSettingsStatus('切換失敗，還原原位置都失敗（' + (e2.message || e2) + '），已暫停自動儲存。');
    }
  }
}

/* ---------- 9d. 數據庫表預覽（只讀） ---------- */
function quoteIdent(t){ return '"' + String(t).replace(/"/g, '""') + '"'; }
async function refreshTableList(){
  var listEl = document.getElementById('tgTableList');
  if(!listEl) return;
  listEl.innerHTML = '<p class="muted small">載入中…</p>';
  try{
    var tables = await dbPort.select(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    var html = '';
    for(var i = 0; i < tables.length; i++){
      var t = String(tables[i].name);
      var c = await dbPort.select('SELECT COUNT(*) AS c FROM ' + quoteIdent(t));
      html += '<button class="btn tgset-tablebtn" type="button" data-table="' + escHtml(t) + '">' +
        escHtml(t) + ' <span class="muted small">(' + (c.length ? c[0].c : 0) + ')</span></button>';
    }
    listEl.innerHTML = html || '<p class="muted small">無表</p>';
    var btns = listEl.querySelectorAll('[data-table]');
    for(var j = 0; j < btns.length; j++){
      (function(b){
        b.addEventListener('click', function(){ previewTable(b.getAttribute('data-table')); });
      })(btns[j]);
    }
  }catch(e){
    listEl.innerHTML = '<p class="error">讀取失敗：' + escHtml(e.message || e) + '</p>';
  }
}
async function previewTable(t){
  var box = document.getElementById('tgTablePreview');
  if(!box) return;
  box.innerHTML = '<p class="muted small">載入中…</p>';
  try{
    var cols = await dbPort.select('PRAGMA table_info(' + quoteIdent(t) + ')');
    // attachments 表唔直接 SELECT data_b64（base64 好大），只顯示字節數
    var rows = (t === 'attachments')
      ? await dbPort.select('SELECT id, voucher_no, seq, name, mime, path, length(data_b64) AS data_b64_bytes FROM attachments LIMIT 100')
      : await dbPort.select('SELECT * FROM ' + quoteIdent(t) + ' LIMIT 100');
    var html = '<p><strong>' + escHtml(t) + '</strong> <span class="muted small">頭 ' + rows.length +
      ' 行（最多 100 行，只讀）</span></p>' +
      '<div class="tgset-gridwrap"><table class="tgset-grid"><thead><tr>';
    for(var i = 0; i < cols.length; i++) html += '<th>' + escHtml(cols[i].name) + '</th>';
    html += '</tr></thead><tbody>';
    for(var r = 0; r < rows.length; r++){
      html += '<tr>';
      for(var c = 0; c < cols.length; c++){
        var v = rows[r][cols[c].name];
        var cell = (v === null || v === undefined)
          ? '<span class="muted small">NULL</span>'
          : escHtml(String(v).length > 80 ? String(v).slice(0, 80) + '…' : String(v));
        html += '<td>' + cell + '</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    box.innerHTML = html;
  }catch(e){
    box.innerHTML = '<p class="error">讀取失敗：' + escHtml(e.message || e) + '</p>';
  }
}

/* ---------- 9e. 附件管理 ---------- */
function fmtBytes(n){
  n = Number(n) || 0;
  if(n < 1024) return n + ' B';
  if(n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}
async function copyText(t, okMsg){
  try{
    if(navigator.clipboard && navigator.clipboard.writeText){
      await navigator.clipboard.writeText(t);
    }else{
      var ta = document.createElement('textarea');
      ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
    }
    setSettingsStatus(okMsg || '已複製');
  }catch(e){ setSettingsStatus('複製失敗：' + (e.message || e)); }
}
async function refreshAttachmentManager(){
  var statsEl = document.getElementById('tgAttStats'),
      wrap = document.getElementById('tgAttListWrap'),
      tbody = document.getElementById('tgAttList');
  if(!statsEl) return;
  statsEl.textContent = '（載入中…）';
  try{
    var rows = await dbPort.select(
      'SELECT voucher_no, seq, name, mime, length(data_b64) AS b64len, ' +
      'CASE WHEN data_b64 IS NULL THEN 0 ELSE 1 END AS has_data ' +
      'FROM attachments ORDER BY voucher_no, seq');
    var total = 0, missing = 0, html = '';
    rows.forEach(function(r){
      var bytes = r.b64len == null ? 0 : Math.floor(r.b64len * 3 / 4);
      total += bytes;
      var ok = r.has_data ? true : false;
      if(!ok) missing++;
      html += '<tr><td>' + escHtml(r.voucher_no) + '</td><td>' + escHtml(r.name) + '</td>' +
        '<td>' + escHtml(r.mime) + '</td><td>' + fmtBytes(bytes) + '</td>' +
        '<td>' + (ok ? '正常' : '<span class="error">無內容</span>') + '</td></tr>';
    });
    statsEl.innerHTML = '共 <b>' + rows.length + '</b> 個附件，' +
      '合共 <b>' + fmtBytes(total) + '</b>' +
      (missing ? '，<span class="error">' + missing + ' 個無內容</span>' : '，全部正常');
    tbody.innerHTML = html;
    wrap.hidden = !rows.length;
    // 舊附件備份目錄存在先顯示刪除掣
    var cleanBtn = document.getElementById('tgAttCleanBackup');
    if(cleanBtn){
      var base = await appDataDir(), exists = false;
      try{ exists = await invoke('plugin:fs|exists', { path: base + '/attachments.pre-v3-backup' }); }
      catch(e){}
      cleanBtn.hidden = !exists;
    }
  }catch(e){
    statsEl.innerHTML = '<span class="error">讀取失敗：' + escHtml(e.message || e) + '</span>';
  }
}
async function exportAllAttachments(){
  try{
    setSettingsStatus('正在打包附件…');
    var rows = await dbPort.select(
      'SELECT voucher_no, seq, name, data_b64 FROM attachments WHERE data_b64 IS NOT NULL ORDER BY voucher_no, seq');
    if(!rows.length){ setSettingsStatus('無附件可匯出'); return; }
    var zip = new window.JSZip(), n = 0;
    rows.forEach(function(r){
      try{
        var bin = atob(r.data_b64), bytes = new Uint8Array(bin.length);
        for(var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        zip.file('attachments/' + sanitizeName(r.voucher_no) + '/' + sanitizeName(r.name), bytes);
        n++;
      }catch(e){}
    });
    var zipBytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    var savePath = await dlgSave({ title: '匯出全部附件',
      defaultPath: 'Toys-Gallery-attachments.zip',
      filters: [{ name: 'ZIP 壓縮檔', extensions: ['zip'] }] });
    if(!savePath){ setSettingsStatus('已取消匯出'); return; }
    await fsWriteBytes(savePath, zipBytes);
    setSettingsStatus('已匯出 ' + n + ' 個附件：' + savePath);
  }catch(e){ setSettingsStatus('匯出失敗：' + (e.message || e)); }
}
async function cleanupPreV3Backup(){
  var base = await appDataDir(), dir = base + '/attachments.pre-v3-backup';
  if(!confirm('確定刪除舊附件備份目錄？\n' + dir + '\n（附件已入 SQLite，刪除後唔影響使用）')) return;
  try{
    await invoke('plugin:fs|remove', { path: dir, options: { recursive: true } });
    setSettingsStatus('舊附件備份已刪除');
    await refreshAttachmentManager();
  }catch(e){ setSettingsStatus('刪除失敗：' + (e.message || e)); }
}

/* ---------- 9f. MCP 服務 ---------- */
async function renderMcpSection(){
  var cfgEl = document.getElementById('tgMcpConfig'),
      noteEl = document.getElementById('tgMcpNote');
  if(!cfgEl) return;
  try{
    var dbPath = await currentDbFilePath();
    // mcp-server 位置：開發版喺 repo 嘅 mcp-server/；打包後跟 app 資源走
    var mcpJs = 'mcp-server/index.js';
    var toml =
      '[mcp_servers.toys-gallery]\n' +
      'command = "node"\n' +
      'args = ["' + mcpJs.replace(/\\/g, '\\\\') + '"]\n' +
      'env = { TG_DB_PATH = "' + String(dbPath || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '" }';
    cfgEl.textContent = toml;
    cfgEl.setAttribute('data-toml', toml);
    cfgEl.setAttribute('data-dbpath', dbPath || '');
    if(noteEl) noteEl.textContent = 'MCP Server 唯讀查詢，唔會改到數據。詳見 repo 內 mcp-server/README.md。';
  }catch(e){
    cfgEl.textContent = '載入失敗：' + (e.message || e);
  }
}
function copyMcpConfig(){
  var el = document.getElementById('tgMcpConfig');
  copyText(el.getAttribute('data-toml') || el.textContent, 'Codex 設定已複製，去 ~/.codex/config.toml 貼上');
}
function copyMcpDbPath(){
  var el = document.getElementById('tgMcpConfig');
  copyText(el.getAttribute('data-dbpath') || '', 'DB 路徑已複製');
}

/* ---------- 9g. 待匯入 Voucher（MCP／Codex 手寫單識別） ---------- */
function centsToStr(c){
  var n = Math.round(Number(c) || 0), neg = n < 0, a = Math.abs(n);
  return (neg ? '-' : '') + Math.floor(a / 100) + '.' + String(a % 100).padStart(2, '0');
}
async function refreshPendingVouchers(){
  var statsEl = document.getElementById('tgPendStats'),
      wrap = document.getElementById('tgPendListWrap'),
      tbody = document.getElementById('tgPendList');
  if(!statsEl) return;
  statsEl.textContent = '（載入中…）';
  try{
    var rows = await dbPort.select(
      "SELECT id, created_at, voucher_no, payload_json, note FROM pending_vouchers WHERE status='pending' ORDER BY id");
    var html = '';
    rows.forEach(function(r){
      var p = {};
      try{ p = JSON.parse(r.payload_json); }catch(e){}
      var total = (p.lines || []).reduce(function(s, l){ return s + (l.debit_cents || 0); }, 0);
      var attN = (p.attachments || []).length;
      html += '<tr><td>' + r.id + '</td><td>' + escHtml(p.date || '') + '</td>' +
        '<td>' + escHtml(p.desc || '') + '</td><td>' + (p.lines || []).length + ' 行</td>' +
        '<td>$' + centsToStr(total) + '</td><td>' + attN + ' 張</td>' +
        '<td><button class="btn" data-pend-import="' + r.id + '" type="button">匯入</button> ' +
        '<button class="btn" data-pend-reject="' + r.id + '" type="button">刪除</button></td></tr>';
    });
    statsEl.innerHTML = rows.length ? '共 <b>' + rows.length + '</b> 張待匯入' : '無待匯入 voucher';
    tbody.innerHTML = html;
    wrap.hidden = !rows.length;
    tbody.querySelectorAll('[data-pend-import]').forEach(function(b){
      b.addEventListener('click', function(){ importPendingVoucher(Number(b.getAttribute('data-pend-import'))); });
    });
    tbody.querySelectorAll('[data-pend-reject]').forEach(function(b){
      b.addEventListener('click', function(){ rejectPendingVoucherUI(Number(b.getAttribute('data-pend-reject'))); });
    });
  }catch(e){
    statsEl.innerHTML = '<span class="error">讀取失敗：' + escHtml(e.message || e) + '</span>';
  }
}
async function importPendingVoucher(id){
  try{
    var rows = await dbPort.select("SELECT * FROM pending_vouchers WHERE id=? AND status='pending'", [id]);
    if(!rows.length){ setSettingsStatus('搵唔到待匯入 #' + id); return; }
    var r = rows[0], p = JSON.parse(r.payload_json);
    var draft = {
      key: 'pending-' + id,
      voucherNo: r.voucher_no || '',
      date: p.date, type: p.type, desc: p.desc,
      madeBy: p.madeBy || '', checkedBy: p.checkedBy || '', approvedBy: p.approvedBy || '',
      lines: (p.lines || []).map(function(l){
        return { account: l.account, debit: l.debit_cents || 0, credit: l.credit_cents || 0, detail: l.detail || '' };
      }),
      rowNums: [],
    };
    var res = TG.importVouchers([draft]);
    if(!res.imported || !res.voucherNos.length){
      setSettingsStatus('匯入失敗（驗證唔過）');
      return;
    }
    var no = res.voucherNos[0];
    if(p.attachments && p.attachments.length){
      TG.setVoucherAttachments(no, p.attachments.map(function(a){
        return { name: a.name, mime: a.mime, dataURL: 'data:' + a.mime + ';base64,' + a.dataB64 };
      }));
    }
    await dbPort.execute("UPDATE pending_vouchers SET status='imported' WHERE id=?", [id]);
    schedulePersist();
    setSettingsStatus('已匯入：' + no + '（' + res.imported + ' 張）');
    await refreshPendingVouchers();
  }catch(e){ setSettingsStatus('匯入失敗：' + (e.message || e)); }
}
async function rejectPendingVoucherUI(id){
  if(!confirm('確定刪除待匯入 #' + id + '？')) return;
  await dbPort.execute("UPDATE pending_vouchers SET status='rejected' WHERE id=?", [id]);
  await refreshPendingVouchers();
  setSettingsStatus('已刪除待匯入 #' + id);
}

/* ---------- 9h. 從 Web JSON 匯入到 SQLite（設置畫面專用流程） ----------
 * 同 backup-tools 欄嘅「匯入 JSON 備份」唔同：呢度先備份目前 DB，
 * 再經 persistPayload 單一 transaction 寫入關聯表，最後由 DB 重載 app。 */var pendingImport = null; // {payload, prepared, legacyConverted, fileName}
async function onPickImportJson(){
  var p = await dlgOpen({ title: '選擇 Web JSON 備份檔',
    filters: [{ name: 'JSON 備份', extensions: ['json'] }], multiple: false });
  if(!p) return;
  if(Array.isArray(p)) p = p[0];
  p = String(p);
  setSettingsStatus('正在讀取備份檔…');
  try{
    var payload = JSON.parse(await fsReadText(p));
    TG.validateBackup(payload);  // 唔啱格式即 throw
    var res = await TG.prepareRestore(payload);  // v1 浮點→分，沿用 app 邏輯
    var d = res.prepared;
    pendingImport = { payload: payload, prepared: d, legacyConverted: res.legacyConverted,
      fileName: p.split('/').pop() };
    var emptyWarn = (!d.accounts || !d.accounts.length)
      ? '<div class="modal-warning">⚠️ 呢個備份檔入面冇科目數據（0 個科目）。匯入後數據庫會係空，請確認揀啱檔案。</div>'
      : '';
    var html = '<p>已讀取 <strong>' + escHtml(pendingImport.fileName) + '</strong>，請核對：</p>' +
      emptyWarn +
      '<div class="restore-summary">' +
      '<span>備份版本 <b>v' + escHtml(payload.appVersion || '未知') + '</b>（schema v' + escHtml(payload.schemaVersion) + '）</span>' +
      '<span>匯出時間 <b>' + escHtml(payload.exportedAt || '未提供') + '</b></span>' +
      '<span>Voucher <b>' + d.vouchers.length + '</b> 張 · 科目 <b>' + d.accounts.length + '</b> 個 · 財年 <b>' + d.fiscalYears.length + '</b> 個</span>' +
      '</div>' +
      (res.legacyConverted
        ? '<div class="modal-warning">舊版備份（schema v1）：將有 ' + res.legacyConverted + ' 個金額欄位由美元轉為分（四捨五入到分），舊數據無遺失。</div>'
        : '') +
      '<div class="modal-warning">匯入會先備份目前數據庫，再以新數據覆蓋寫入。</div>' +
      '<button class="btn primary" id="tgImportGo" type="button">確認匯入</button> ' +
      '<button class="btn" id="tgImportCancel" type="button">取消</button>';
    var box = document.getElementById('tgImportSummary');
    box.innerHTML = html;
    box.hidden = false;
    document.getElementById('tgImportGo').addEventListener('click', doImportJson);
    document.getElementById('tgImportCancel').addEventListener('click', function(){
      box.hidden = true; box.innerHTML = ''; pendingImport = null;
    });
    setSettingsStatus('備份檔已驗證，請核對後確認匯入。');
  }catch(e){
    setSettingsStatus('讀取失敗：' + (e.message || e));
  }
}
async function doImportJson(){
  var box = document.getElementById('tgImportSummary');
  if(box){ box.hidden = true; }
  var imp = pendingImport;
  pendingImport = null;
  if(!imp) return;
  setSettingsStatus('正在匯入（先備份目前數據庫）…');
  dbWriteEnabled = false;
  clearTimeout(persistTimer);
  var ok = false, failMsg = '';
  try{
    await backupDbFile('pre-settings-import');
    var normalized = {
      backupFormat: 'toys-gallery-accounting',
      schemaVersion: 2,
      appVersion: TG.desktopVersion,
      exportedAt: new Date().toISOString(),
      data: imp.prepared
    };
    await extractAttachments(normalized);
    var counts = await DB.persistPayload(dbPort, normalized);
    console.log('[desktop] settings import 寫庫：', JSON.stringify(counts));
    await loadAppStateFromDb({ isFresh: false, needsMigration: false, needsBlobMigration: false, version: 3 }, false);
    // 驗證：讀返確認真係寫入咗
    var verify = await DB.loadPayload(dbPort);
    var vCount = verify && verify.data ? verify.data.vouchers.length : 0;
    var aCount = verify && verify.data ? verify.data.accounts.length : 0;
    console.log('[desktop] settings import 驗證讀回：vouchers=' + vCount + ', accounts=' + aCount);
    if(!aCount) throw new Error('寫入後讀回科目為 0，匯入未生效');
    ok = true;
    await refreshTableList();
    var dbp = await currentDbFilePath();
    setSettingsStatus('匯入完成：' + vCount + ' 張 voucher，' + aCount + ' 個科目，已寫入：' + dbp + '。舊數據庫已備份。');
  }catch(e){
    console.error('[desktop] settings import 失敗：', e);
    failMsg = (e.message || e);
    setSettingsStatus('匯入失敗：' + failMsg + '（目前數據庫已備份，未被覆蓋）');
  }finally{
    dbWriteEnabled = true;
    lastStableHash = null;
    if(ok){ try{ await persistNow(); }catch(e){} }
  }
}

/* ---------- 9f. Voucher Excel 批量匯入（設置畫面） ---------- */
var pendingVoucherImport = null; // ParsedVoucherImport
var pendingVoucherExcelPath = null; // 匯入資料夾路徑（v3.23.0 起改為資料夾模式）
function fmtCentsPlain(c){
  var n = Math.trunc(Number(c) || 0), neg = n < 0, abs = Math.abs(n);
  return (neg ? '-' : '') + Math.floor(abs / 100) + '.' + String(abs % 100).padStart(2, '0');
}
async function downloadVoucherTemplate(){
  try{
    if(!window.XLSX){ setSettingsStatus('Excel 模組未載入'); return; }
    var wb = XLSX.utils.book_new();
    var wsHelp = XLSX.utils.aoa_to_sheet(TG.buildVoucherTemplateHelp());
    wsHelp['!cols'] = [{ wch: 95 }];
    XLSX.utils.book_append_sheet(wb, wsHelp, '說明');
    var wsTpl = XLSX.utils.aoa_to_sheet(TG.buildVoucherTemplateExample());
    wsTpl['!cols'] = [{wch:14},{wch:18},{wch:16},{wch:32},{wch:32},{wch:14},{wch:32},{wch:14},{wch:24},{wch:12},{wch:12},{wch:12},{wch:36}];
    var tplRange = XLSX.utils.decode_range(wsTpl['!ref']);
    wsTpl['!autofilter'] = { ref: XLSX.utils.encode_range({r:0,c:0},{r:tplRange.e.r,c:12}) };
    XLSX.utils.book_append_sheet(wb, wsTpl, '範本');
    // v3.24.0：科目清單 sheet（動態由系統科目生成）＋借／貸方欄下拉選單
    var accNames = [];
    try{ accNames = TG.getAccountNames ? TG.getAccountNames() : []; }catch(e){}
    if(accNames.length){
      var wsAcc = XLSX.utils.aoa_to_sheet([['科目名稱（下拉選單用，請勿刪除此表）']].concat(accNames.map(function(n){ return [n]; })));
      wsAcc['!cols'] = [{ wch: 42 }];
      XLSX.utils.book_append_sheet(wb, wsAcc, '科目清單');
    }
    var out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    // 注入 data validation（借方 E 欄＋貸方 G 欄下拉）
    if(accNames.length && window.JSZip){
      try{
        out = await injectAccountDropdown(new Uint8Array(out), accNames.length);
      }catch(e){ console.error('[desktop] 下拉注入失敗：', e); }
    }
    var path = await dlgSave({ title: '下載 Voucher 匯入範本',
      defaultPath: 'Toys-Gallery-voucher-import-template.xlsx',
      filters: [{ name: 'Excel 活頁簿', extensions: ['xlsx'] }] });
    if(!path){ setSettingsStatus('已取消下載'); return; }
    await fsWriteBytes(path, new Uint8Array(out));
    setSettingsStatus('範本已下載（借／貸方科目有下拉選單）。將範本＋附件放喺同一個資料夾，填好後用「從資料夾匯入 Voucher…」匯入（記得刪除示例行）。');
  }catch(e){ setSettingsStatus('下載失敗：' + (e.message || e)); }
}
/* 注入科目下拉選單：喺「範本」表嘅 E／G 欄加 list validation，參照「科目清單」表 */
async function injectAccountDropdown(xlsxBytes, accCount){
  var zip = await window.JSZip.loadAsync(xlsxBytes);
  var workbookXml = await zip.file('xl/workbook.xml').async('string');
  var relsXml = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  // sheet 名 → 檔名
  var fileMap = {};
  var sheetRe = /<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g, m;
  var relMap = {};
  var relRe = /<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g;
  while((m = relRe.exec(relsXml))) relMap[m[1]] = m[2];
  while((m = sheetRe.exec(workbookXml))){
    var nm = m[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
    var tgt = relMap[m[2]] || '';
    fileMap[nm] = 'xl/' + tgt.replace(/^\//, '');
  }
  var tplFile = fileMap['範本'];
  if(!tplFile || !zip.file(tplFile)) return xlsxBytes;
  var sheetXml = await zip.file(tplFile).async('string');
  // 科目清單 A2:A{1+accCount}
  var lastRow = 1 + accCount;
  var ref = "'科目清單'!$A$2:$A$" + lastRow;
  var dv = '<dataValidations count="2">' +
    '<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="E2:E5000"><formula1>' + ref + '</formula1></dataValidation>' +
    '<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="G2:G5000"><formula1>' + ref + '</formula1></dataValidation>' +
    '</dataValidations>';
  // 插入喺 </worksheet> 之前（dataValidations 應喺 pageMargins 之後、但放尾都work）
  if(sheetXml.indexOf('<dataValidations') < 0){
    sheetXml = sheetXml.replace('</worksheet>', dv + '</worksheet>');
  }
  zip.file(tplFile, sheetXml);
  var out = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  return out;
}
async function onImportVoucherExcel(fromToolbar){
  // 從工具欄撳：先跳去設置頁，等用戶睇到預覽
  if(fromToolbar){
    var nav = document.getElementById('tgSettingsNav');
    if(nav) nav.click();
    await new Promise(function(r){ setTimeout(r, 300); });
  }
  var box = document.getElementById('tgVoucherImportBox');
  box.hidden = true; box.innerHTML = ''; pendingVoucherImport = null;
  // v3.23.0：改為揀資料夾（Excel＋附件放同一個資料夾）
  var folder = null;
  try{
    folder = await dlgOpen({ title: '選擇匯入資料夾（內含 Excel＋附件）', directory: true, multiple: false });
  }catch(e){
    setSettingsStatus('開啟資料夾選擇失敗：' + (e.message || e));
    return;
  }
  if(!folder){ setSettingsStatus('已取消選擇資料夾。'); return; }
  if(Array.isArray(folder)) folder = folder[0];
  folder = String(folder);
  console.log('[desktop] 匯入資料夾：', folder);
  setSettingsStatus('正在掃描資料夾…');
  var xlsxFiles = [];
  try{
    var entries = await invoke('plugin:fs|read_dir', { path: folder });
    if(!entries || !entries.length){
      setSettingsStatus('資料夾係空嘅：' + folder);
      return;
    }
    for(var i = 0; i < entries.length; i++){
      var e = entries[i];
      var nm = e.name || '';
      if(!e.isDirectory && /\.(xlsx|xls)$/i.test(nm)) xlsxFiles.push(folder + '/' + nm);
    }
    xlsxFiles.sort(); // 排序後取第一個，行為確定（唔依賴 read_dir 回傳順序）
    console.log('[desktop] 資料夾內 ' + entries.length + ' 項，Excel：' + xlsxFiles.length);
  }catch(e){
    setSettingsStatus('讀取資料夾失敗：' + (e.message || e) + '（路徑：' + folder + '）');
    return;
  }
  if(!xlsxFiles.length){
    setSettingsStatus('資料夾內冇 Excel 檔（.xlsx／.xls）：' + folder);
    return;
  }
  var p = xlsxFiles[0];
  if(xlsxFiles.length > 1){
    // 多個 Excel：用第一個，並提示
    setSettingsStatus('資料夾內有多個 Excel，用第一個：' + p.split('/').pop());
  }
  pendingVoucherExcelPath = folder; // 記住資料夾路徑，附件喺呢度搵
  setSettingsStatus('正在讀取 Excel…');
  try{
    var wb = XLSX.read(await fsReadBytes(p), { type: 'array' });
    var ws = wb.Sheets['範本'] || wb.Sheets[wb.SheetNames[0]];
    var rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    var parsed = TG.parseVoucherImport(rows);
    pendingVoucherImport = parsed;
    renderVoucherImportPreview(box, parsed);
    box.hidden = false;
    setSettingsStatus('已解析：' + parsed.drafts.length + ' 張 voucher 草稿，' +
      parsed.validDrafts.length + ' 張有效，' + parsed.errors.length + ' 個錯誤。' +
      '附件將喺資料夾內搵：' + folder);
  }catch(e){
    setSettingsStatus('讀取失敗：' + (e.message || e));
  }
}
function renderVoucherImportPreview(box, parsed){
  var html = '';
  if(parsed.errors.length){
    html += '<p><strong class="error">錯誤清單（' + parsed.errors.length + '）：</strong></p>' +
      '<div class="tgset-gridwrap" style="max-height:220px"><table class="tgset-grid"><thead><tr><th>行</th><th>錯誤</th></tr></thead><tbody>' +
      parsed.errors.map(function(e){
        return '<tr><td>' + (e.rowNum || '—') + '</td><td>' + escHtml(e.message) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  if(parsed.validDrafts.length){
    html += '<p><strong>有效 voucher（' + parsed.validDrafts.length + ' 張）：</strong></p>' +
      '<div class="tgset-gridwrap" style="max-height:220px"><table class="tgset-grid"><thead><tr><th>Voucher No.</th><th>日期</th><th>類型</th><th>摘要</th><th>行數</th><th>金額</th><th>附件</th></tr></thead><tbody>' +
      parsed.validDrafts.map(function(d){
        var dr = d.lines.reduce(function(s, l){ return s + l.debit; }, 0);
        var att = (d.attachmentPaths && d.attachmentPaths.length) ? ('📎 ' + d.attachmentPaths.length + ' 個') : '—';
        return '<tr><td>' + escHtml(d.voucherNo || '（自動編號）') + '</td><td>' + escHtml(d.date) + '</td><td>' +
          (d.type === 'B' ? '銀行' : '轉賬') + '</td><td>' + escHtml(d.desc) + '</td><td>' + d.lines.length +
          '</td><td>' + escHtml(fmtCentsPlain(dr)) + '</td><td>' + escHtml(att) + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<p><button class="btn primary" id="tgVoucherImportGo" type="button">只匯入有效行（' +
      parsed.validDrafts.length + ' 張）</button> ' +
      '<button class="btn" id="tgVoucherImportCancel" type="button">取消</button></p>';
  }else{
    html += '<p class="error">無有效行可匯入。</p>' +
      '<p><button class="btn" id="tgVoucherImportCancel" type="button">關閉</button></p>';
  }
  box.innerHTML = html;
  var go = document.getElementById('tgVoucherImportGo');
  if(go) go.addEventListener('click', doImportVouchers);
  document.getElementById('tgVoucherImportCancel').addEventListener('click', function(){
    box.hidden = true; box.innerHTML = ''; pendingVoucherImport = null;
  });
}
async function doImportVouchers(){
  var box = document.getElementById('tgVoucherImportBox');
  if(box) box.hidden = true;
  var parsed = pendingVoucherImport;
  var excelPath = pendingVoucherExcelPath;
  pendingVoucherImport = null;
  pendingVoucherExcelPath = null;
  if(!parsed || !parsed.validDrafts.length) return;
  setSettingsStatus('正在匯入（先備份目前數據庫）…');
  dbWriteEnabled = false;
  clearTimeout(persistTimer);
  try{
    await backupDbFile('pre-voucher-excel-import');
    var res = TG.importVouchers(parsed.validDrafts);
    // 附件：按 attachmentMap（voucherNo → 路徑）讀檔，經 setVoucherAttachments 掛到 voucher
    // v3.24.2：唔再用 index 對應（importVouchers 可能 skip draft 搞亂順序）
    var attOk = 0, attFail = [];
    if(excelPath && TG.setVoucherAttachments && res.attachmentMap){
      var attachDir = String(excelPath);
      var vnos = Object.keys(res.attachmentMap);
      for(var vi = 0; vi < vnos.length; vi++){
        var vno = vnos[vi];
        var paths = res.attachmentMap[vno];
        if(!paths || !paths.length) continue;
        var atts = [];
        for(var pi = 0; pi < paths.length; pi++){
          var rel = paths[pi];
          // 絕對路徑直接用；否則喺匯入資料夾內搵
          var full = (/^([a-zA-Z]:)?[/\\]/.test(rel) || rel.charAt(0) === '/')
            ? rel : (attachDir + '/' + rel);
          try{
            var bytes = await fsReadBytes(full);
            var name = full.split('/').pop().split('\\').pop();
            atts.push({ name: name, mime: guessMime(name), dataURL: bytesToDataURL(bytes, guessMime(name)) });
            attOk++;
          }catch(e){
            attFail.push(vno + ': ' + rel + '（資料夾內搵唔到）');
          }
        }
        if(atts.length){
          try{
            var ok = TG.setVoucherAttachments(vno, atts);
            if(!ok) attFail.push(vno + ': 搵唔到 voucher');
          }catch(e){ attFail.push(vno + ': 掛載失敗'); }
        }
      }
    }
    dbWriteEnabled = true;
    lastStableHash = null;
    await persistNow();
    await refreshTableList();
    var msg = '匯入完成：' + res.imported + ' 張 voucher（' +
      res.voucherNos.slice(0, 5).join('、') + (res.voucherNos.length > 5 ? ' 等' : '') + '）' +
      (res.needsReview ? '；其中 ' + res.needsReview + ' 張對銷差額標示為「待核對」。' : '。');
    if(attOk) msg += '附件 ' + attOk + ' 個已匯入。';
    if(attFail.length) msg += '附件失敗 ' + attFail.length + ' 個：' + attFail.slice(0, 3).join('；') + (attFail.length > 3 ? '…' : '');
    msg += '舊數據庫已備份。';
    setSettingsStatus(msg);
  }catch(e){
    console.error('[desktop] voucher excel import 失敗：', e);
    dbWriteEnabled = true;
    setSettingsStatus('匯入失敗：' + (e.message || e));
  }
}

/* ---------- 9i. Voucher 批量匯出 Excel（俾會計師） ----------
 * 入口：voucher 列表 card-head 注入「匯出 Voucher Excel」掣 → 範圍 dialog
 * （財年＋月份）→ 總表＋明細 xlsx＋附件打包 zip。
 * 附件 hyperlink 指去 zip 入面相對路徑 attachments/<voucherNo>/（解壓後有效）。 */
function injectVoucherExportBtn(){
  var search = document.getElementById('voucherSearch');
  if(!search || document.getElementById('tgExportVouchers')) return;
  var head = search.closest('.card-head');
  if(!head) return;
  var b = document.createElement('button');
  b.className = 'btn'; b.type = 'button'; b.id = 'tgExportVouchers';
  b.textContent = '匯出 Voucher Excel';
  b.title = '按財年／月份匯出 voucher＋分錄＋附件（zip，俾會計師）';
  b.style.cssText = 'margin-left:8px;white-space:nowrap;';
  b.addEventListener('click', openVoucherExportDialog);
  head.appendChild(b);
}
function closeVoucherExportDialog(){
  var d = document.getElementById('tgVoucherExpDlg');
  if(d) d.remove();
}
function openVoucherExportDialog(){
  closeVoucherExportDialog();
  var fys;
  try{ fys = TG.fiscalYears(); }catch(e){ setStatus('讀取財年失敗'); return; }
  if(!fys.length){ setStatus('無財年可匯出'); return; }
  var cur;
  try{ cur = TG.selectedFiscalKey(); }catch(e){ cur = fys[0].key; }
  var d = document.createElement('div');
  d.id = 'tgVoucherExpDlg';
  d.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;';
  d.innerHTML =
    '<div style="background:var(--surface,#fff);border-radius:10px;padding:20px 24px;min-width:320px;max-width:92vw;">' +
    '<h3 style="margin:0 0 12px;">匯出 Voucher Excel</h3>' +
    '<p><label>財年<br><select id="tgExpFy" class="input" style="width:100%">' +
    fys.map(function(f){
      return '<option value="' + escHtml(f.key) + '"' + (f.key === cur ? ' selected' : '') + '>' +
        escHtml(f.label) + '（' + escHtml(f.from) + ' 至 ' + escHtml(f.to) + '）</option>';
    }).join('') + '</select></label></p>' +
    '<p><label>由月份<br><select id="tgExpFrom" class="input" style="width:100%"></select></label></p>' +
    '<p><label>到月份<br><select id="tgExpTo" class="input" style="width:100%"></select></label></p>' +
    '<p class="muted small">會匯出總表＋明細兩個 sheet，附件一齊打包做 zip（hyperlink 指去相對路徑，解壓後有效）。</p>' +
    '<p style="text-align:right;margin:12px 0 0;"><button class="btn" id="tgExpCancel" type="button">取消</button> ' +
    '<button class="btn primary" id="tgExpGo" type="button">匯出</button></p></div>';
  document.body.appendChild(d);
  var fySel = document.getElementById('tgExpFy');
  function fillMonths(){
    var f = null;
    for(var i = 0; i < fys.length; i++) if(fys[i].key === fySel.value) f = fys[i];
    var from = document.getElementById('tgExpFrom'), to = document.getElementById('tgExpTo');
    var html = '<option value="">全年</option>', ym = f ? f.from.slice(0, 7) : '', end = f ? f.to.slice(0, 7) : '';
    while(ym && ym <= end){
      html += '<option value="' + ym + '">' + ym + '</option>';
      var y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
      m++; if(m > 12){ m = 1; y++; }
      ym = y + '-' + String(m).padStart(2, '0');
    }
    from.innerHTML = html; to.innerHTML = html;
  }
  fySel.addEventListener('change', fillMonths);
  fillMonths();
  document.getElementById('tgExpCancel').addEventListener('click', closeVoucherExportDialog);
  d.addEventListener('click', function(e){ if(e.target === d) closeVoucherExportDialog(); });
  document.getElementById('tgExpGo').addEventListener('click', function(){
    var fyKey = fySel.value;
    var fromM = document.getElementById('tgExpFrom').value;
    var toM = document.getElementById('tgExpTo').value;
    closeVoucherExportDialog();
    doVoucherExport(fyKey, fromM, toM);
  });
}
function voucherExpTitleRows(rangeLabel){
  var co = currentCompanyName || 'Toys Gallery International Limited';
  return [
    [co + ' — Voucher 匯出'],
    ['範圍 ' + rangeLabel + ' · 匯出時間 ' + new Date().toLocaleString('zh-HK')],
    []
  ];
}
async function doVoucherExport(fyKey, fromMonth, toMonth){
  try{
    if(!window.XLSX){ setStatus('Excel 模組未載入'); return; }
    if(!window.JSZip){ setStatus('JSZip 模組未載入'); return; }
    setStatus('正在匯出 Voucher…');
    var res = TG.buildVoucherExport(fyKey, fromMonth || '', toMonth || '');
    if(!res.voucherCount){ setStatus('所選範圍無 voucher'); return; }
    var wb = XLSX.utils.book_new();
    var polishOpts = [];
    var TITLE_ROWS = 3; // voucherExpTitleRows 行數
    // 總表
    var wsS = XLSX.utils.aoa_to_sheet(voucherExpTitleRows(res.rangeLabel).concat(res.summary));
    finalizeSheet(wsS, TITLE_ROWS);
    res.links.forEach(function(lk){
      var addr = XLSX.utils.encode_cell({ r: lk.r + TITLE_ROWS, c: lk.c });
      var cell = wsS[addr];
      if(cell) cell.l = { Target: lk.target, Tooltip: lk.tooltip };
    });
    XLSX.utils.book_append_sheet(wb, wsS, '總表 Vouchers');
    polishOpts.push({ name: '總表 Vouchers', freezeRows: 4, titleRows: '1:3', boldRows: [0] });
    // 明細
    var wsD = XLSX.utils.aoa_to_sheet(voucherExpTitleRows(res.rangeLabel).concat(res.detail));
    finalizeSheet(wsD, TITLE_ROWS);
    XLSX.utils.book_append_sheet(wb, wsD, '明細 Lines');
    polishOpts.push({ name: '明細 Lines', freezeRows: 4, titleRows: '1:3', boldRows: [0] });

    var raw = new Uint8Array(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }));
    var xlsxBytes;
    try{ xlsxBytes = await TG.polishWorkbook(raw, polishOpts, window.JSZip); }
    catch(e){ console.warn('[desktop] voucher xlsx 後期加工失敗：', e); xlsxBytes = raw; }

    // 打包 zip：xlsx＋附件
    var zip = new window.JSZip();
    var xlsxName = 'Toys-Gallery-vouchers-' + res.rangeLabel + '.xlsx';
    zip.file(xlsxName, xlsxBytes);
    var base = await appDataDir(), copiedAtt = 0;
    for(var i = 0; i < res.attachments.length; i++){
      var att = res.attachments[i], bytes = null;
      if(att.dataURL){
        try{ bytes = dataURLToParts(att.dataURL).bytes; }catch(e){}
      }else if(att.relPath){
        try{ bytes = await fsReadBytes(base + '/' + att.relPath); }catch(e){}
      }
      if(bytes){
        zip.file('attachments/' + sanitizeName(att.voucherNo) + '/' + sanitizeName(att.name), bytes);
        copiedAtt++;
      }
    }
    var zipBytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    var savePath = await dlgSave({ title: '儲存 Voucher 匯出（zip）',
      defaultPath: xlsxName.replace(/\.xlsx$/, '') + '.zip',
      filters: [{ name: 'ZIP 壓縮檔', extensions: ['zip'] }] });
    if(!savePath){ setStatus('已取消匯出'); return; }
    await fsWriteBytes(savePath, zipBytes);
    setStatus('已匯出 ' + res.voucherCount + ' 張 voucher（' + res.lineCount + ' 行分錄，' +
      copiedAtt + ' 個附件）→ zip');
  }catch(e){
    console.error('[desktop] voucher export failed:', e);
    setStatus('匯出失敗：' + (e.message || e));
  }
}

/* ---------- 10. 啟動 ---------- */
if(document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', function(){ startup(); });
else
  startup();

/* 測試／除錯鉤（唯讀暴露內部函數，唔影響正常流程） */
window.__TG_DESKTOP__ = {
  migrateAttachmentsToDb: migrateAttachmentsToDb,
  extractAttachments: extractAttachments,
  reconstituteAttachments: reconstituteAttachments
};

})();
