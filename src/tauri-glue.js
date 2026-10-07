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
function bytesToDataURL(bytes, mime){
  var bin = '', CH = 0x8000, i;
  for(i = 0; i < bytes.length; i += CH)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return 'data:' + (mime || 'application/octet-stream') + ';base64,' + btoa(bin);
}
function eachVoucherWithAttachment(payload, fn){
  var vs = (payload.data && payload.data.vouchers) || [];
  if(payload.data && payload.data.workingVoucher) vs = vs.concat([payload.data.workingVoucher]);
  vs.forEach(fn);
}
/* persist 前：data URL 抽出存檔，attachment 改記 {name, type, mime, path}
  （db-layer 只存 metadata，唔存 dataURL） */
async function extractAttachments(payload){
  var base = await appDataDir(), jobs = [];
  eachVoucherWithAttachment(payload, function(v){
    var atts = v && v.attachments;
    if(!Array.isArray(atts)) return;
    atts.forEach(function(att){
      if(att && typeof att.dataURL === 'string' && att.dataURL.indexOf('data:') === 0){
        jobs.push((async function(){
          var parts = dataURLToParts(att.dataURL);
          var vdir = base + '/attachments/' + sanitizeName(v.no || 'unnumbered');
          await fsMkdir(vdir);
          var fname = sanitizeName(att.name || 'attachment');
          await fsWriteBytes(vdir + '/' + fname, parts.bytes);
          delete att.dataURL;
          att.mime = parts.mime;
          att.path = 'attachments/' + sanitizeName(v.no || 'unnumbered') + '/' + fname;
        })());
      }
    });
  });
  await Promise.all(jobs);
}
/* hydrate 前：路徑讀返轉做 data URL，交返 app 原有邏輯 */
async function reconstituteAttachments(payload){
  var base = await appDataDir();
  var jobs = [];
  eachVoucherWithAttachment(payload, function(v){
    var atts = v && v.attachments;
    if(!Array.isArray(atts)) return;
    atts.forEach(function(att){
      if(att && att.path && !att.dataURL){
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

/* ---------- 4. 持久化（debounced + hash 去重，單一 transaction） ---------- */
var lastStableHash = null, persistTimer = null, dbWriteEnabled = true;
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
async function persistNow(){
  if(!dbWriteEnabled) return;
  try{
    var payload = await TG.createBackupPayload();
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
    // 全新：建 schema_version(2)，空白賬套起步
    await DB.seedFresh(dbPort);
    TG.blankStart();
    lastStableHash = null;
    await persistNow();
    setStatus(isStartup ? '已建立本機賬套（空白）' : '已在新位置建立空白賬套');
    return;
  }
  if(init.needsMigration){
    // v1 → v2：先備份 .db，再經 app 自身 prepareRestore 正規化後寫入關聯表
    setStatus('正在升級本機數據庫（v1→v2）…');
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
      console.log('[desktop] migration v1→v2 完成：', JSON.stringify(counts));
    }else{
      await DB.seedFresh(dbPort);
    }
  }
  var dbPayload = await DB.loadPayload(dbPort);
  if(dbPayload){
    await reconstituteAttachments(dbPayload);
    var prepared = await TG.prepareRestore(dbPayload);
    TG.applyPreparedRestore(prepared.prepared);
    lastStableHash = strHash(stablePayloadString(dbPayload));
    setStatus(init.needsMigration ? '數據庫已升級到 v2，本機賬套已載入' : '已載入本機賬套');
  }else{
    // v2 表係空（唔應該發生）：空白起步
    TG.blankStart();
    lastStableHash = null;
    await persistNow();
    setStatus('已建立本機賬套（空白）');
  }
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
  wrap.appendChild(mk('tgImportJSON', '匯入 JSON 備份', '從 web 版下載的 JSON 備份匯入（首次遷移用）', importJSONBackup));
  wrap.appendChild(mk('tgExportExcel', '匯出 Excel 報表', '9 份報表匯出為 .xlsx', exportExcelReports));
  wrap.appendChild(mk('tgDownloadTemplate', '下載匯入範本', '下載 Excel 匯入範本（科目表＋期初數）', downloadImportTemplate));
  wrap.appendChild(mk('tgImportExcel', '匯入 Excel', '從 Excel 匯入科目表＋期初數', importExcelData));
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
  return [
    ['Toys Gallery International Limited — ' + label + ' ' + en],
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
    var path = await dlgSave({ title: '儲存 Excel 報表',
      defaultPath: 'Toys-Gallery-reports-' + fy + '.xlsx',
      filters: [{ name: 'Excel 活頁簿', extensions: ['xlsx'] }] });
    if(!path){ setStatus('已取消匯出'); return; }
    await fsWriteBytes(path, new Uint8Array(out));
    setStatus('Excel 已匯出（9 份報表）' + (errors.length ? '；' + errors.length + ' 份有問題' : ''));
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
    '#tgSettingsView{position:fixed;inset:0;z-index:9999;overflow:auto;background:var(--bg,#f4f1ea);color:var(--text,#222);}' +
    '#tgSettingsView[hidden]{display:none;}' +
    '.tgset-top{max-width:960px;margin:0 auto;padding:20px 20px 0;display:flex;justify-content:space-between;align-items:flex-start;gap:12px;}' +
    '.tgset-top h2{margin:0;}' +
    '.tgset-ver{color:#888;font-size:13px;margin-top:4px;}' +
    '.tgset-changelog{max-width:960px;margin:12px auto 0;padding:12px 20px;background:var(--surface,#fff);border:1px solid var(--border,#e2ddd2);border-radius:8px;}' +
    '.tgset-changelog ul{margin:6px 0 0;padding-left:20px;}' +
    '.tgset-changelog li{margin:4px 0;}' +
    '.tgset-sec{max-width:960px;margin:12px auto 0;padding:16px 20px;background:var(--surface,#fff);border:1px solid var(--border,#e2ddd2);border-radius:8px;}' +
    '.tgset-sec h3{margin:0 0 8px;}' +
    '.tgset-sec code{word-break:break-all;background:#f0ede6;padding:2px 6px;border-radius:4px;font-size:12px;}' +
    '.tgset-status{max-width:960px;margin:12px auto 32px;padding:0 20px;min-height:24px;font-weight:bold;}' +
    '.tgset-gridwrap{overflow:auto;max-height:420px;border:1px solid #e2ddd2;border-radius:6px;margin-top:8px;}' +
    '.tgset-grid{border-collapse:collapse;font-size:12px;min-width:100%;}' +
    '.tgset-grid th,.tgset-grid td{border:1px solid #e8e4d9;padding:4px 8px;text-align:left;white-space:nowrap;}' +
    '.tgset-grid th{background:#f5f2ea;position:sticky;top:0;}' +
    '.tgset-tablebtn{margin:2px;}' +
    '#tgDbSwitchConfirm,#tgImportSummary{margin-top:10px;padding:12px;border:1px dashed #c9a227;border-radius:6px;background:#fffdf5;}' +
    '#tgDbSwitchConfirm[hidden],#tgImportSummary[hidden]{display:none;}' +
    '.tgset-sec .muted{color:#888;}' +
    '.tgset-sec .small{font-size:12px;}' +
    '.tgset-sec .error{color:#c00;}';
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
    '<p class="muted small">附件存放於應用數據目錄，不隨數據庫位置改變。切換前會先將未儲存嘅改動寫入舊庫；目標如已有數據庫會直接載入（舊版自動升級，並先備份）。</p>' +
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
    '<button class="btn" id="tgVoucherImport" type="button">匯入 Voucher Excel…</button></p>' +
    '<p class="muted small">範本每行一條分錄行；B 欄 Voucher No. 吉唔填會自動編號（B040124 格式）。匯入前逐行驗證，可揀「只匯入有效行」。金額經整數分入賬。</p>' +
    '<div id="tgVoucherImportBox" hidden></div></section>' +
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
    var rows = await dbPort.select('SELECT * FROM ' + quoteIdent(t) + ' LIMIT 100');
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

/* ---------- 9e. 從 Web JSON 匯入到 SQLite（設置畫面專用流程） ----------
 * 同 backup-tools 欄嘅「匯入 JSON 備份」唔同：呢度先備份目前 DB，
 * 再經 persistPayload 單一 transaction 寫入關聯表，最後由 DB 重載 app。 */
var pendingImport = null; // {payload, prepared, legacyConverted, fileName}
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
    var html = '<p>已讀取 <strong>' + escHtml(pendingImport.fileName) + '</strong>，請核對：</p>' +
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
    console.log('[desktop] settings import 完成：', JSON.stringify(counts));
    await loadAppStateFromDb({ isFresh: false, needsMigration: false, version: 2 }, false);
    dbWriteEnabled = true;
    lastStableHash = null;
    await persistNow();
    await refreshTableList();
    setSettingsStatus('匯入完成：' + imp.prepared.vouchers.length + ' 張 voucher，' +
      imp.prepared.accounts.length + ' 個科目。舊數據庫已備份。');
  }catch(e){
    console.error('[desktop] settings import 失敗：', e);
    dbWriteEnabled = true;
    setSettingsStatus('匯入失敗：' + (e.message || e) + '（目前數據庫已備份，未被覆蓋）');
  }
}

/* ---------- 9f. Voucher Excel 批量匯入（設置畫面） ---------- */
var pendingVoucherImport = null; // ParsedVoucherImport
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
    wsTpl['!cols'] = [{wch:14},{wch:18},{wch:16},{wch:32},{wch:32},{wch:14},{wch:32},{wch:14},{wch:24},{wch:12},{wch:12},{wch:12}];
    var tplRange = XLSX.utils.decode_range(wsTpl['!ref']);
    wsTpl['!autofilter'] = { ref: XLSX.utils.encode_range({r:0,c:0},{r:tplRange.e.r,c:11}) };
    XLSX.utils.book_append_sheet(wb, wsTpl, '範本');
    var out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    var path = await dlgSave({ title: '下載 Voucher 匯入範本',
      defaultPath: 'Toys-Gallery-voucher-import-template.xlsx',
      filters: [{ name: 'Excel 活頁簿', extensions: ['xlsx'] }] });
    if(!path){ setSettingsStatus('已取消下載'); return; }
    await fsWriteBytes(path, new Uint8Array(out));
    setSettingsStatus('範本已下載。填好後用「匯入 Voucher Excel」匯入（記得刪除示例行）。');
  }catch(e){ setSettingsStatus('下載失敗：' + (e.message || e)); }
}
async function onImportVoucherExcel(){
  var box = document.getElementById('tgVoucherImportBox');
  box.hidden = true; box.innerHTML = ''; pendingVoucherImport = null;
  var p = await dlgOpen({ title: '選擇 Voucher Excel 檔',
    filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }], multiple: false });
  if(!p) return;
  if(Array.isArray(p)) p = p[0];
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
      parsed.validDrafts.length + ' 張有效，' + parsed.errors.length + ' 個錯誤。');
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
      '<div class="tgset-gridwrap" style="max-height:220px"><table class="tgset-grid"><thead><tr><th>Voucher No.</th><th>日期</th><th>類型</th><th>摘要</th><th>行數</th><th>金額</th></tr></thead><tbody>' +
      parsed.validDrafts.map(function(d){
        var dr = d.lines.reduce(function(s, l){ return s + l.debit; }, 0);
        return '<tr><td>' + escHtml(d.voucherNo || '（自動編號）') + '</td><td>' + escHtml(d.date) + '</td><td>' +
          (d.type === 'B' ? '銀行' : '轉賬') + '</td><td>' + escHtml(d.desc) + '</td><td>' + d.lines.length +
          '</td><td>' + escHtml(fmtCentsPlain(dr)) + '</td></tr>';
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
  pendingVoucherImport = null;
  if(!parsed || !parsed.validDrafts.length) return;
  setSettingsStatus('正在匯入（先備份目前數據庫）…');
  dbWriteEnabled = false;
  clearTimeout(persistTimer);
  try{
    await backupDbFile('pre-voucher-excel-import');
    var res = TG.importVouchers(parsed.validDrafts);
    dbWriteEnabled = true;
    lastStableHash = null;
    await persistNow();
    await refreshTableList();
    setSettingsStatus('匯入完成：' + res.imported + ' 張 voucher（' +
      res.voucherNos.slice(0, 5).join('、') + (res.voucherNos.length > 5 ? ' 等' : '') + '）' +
      (res.needsReview ? '；其中 ' + res.needsReview + ' 張對銷差額標示為「待核對」。' : '。') +
      '舊數據庫已備份。');
  }catch(e){
    console.error('[desktop] voucher excel import 失敗：', e);
    dbWriteEnabled = true;
    setSettingsStatus('匯入失敗：' + (e.message || e));
  }
}

/* ---------- 9g. Voucher 批量匯出 Excel（俾會計師） ----------
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
  return [
    ['Toys Gallery International Limited — Voucher 匯出'],
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

})();
