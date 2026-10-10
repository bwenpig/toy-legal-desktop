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
  opLogTableReady = false; // v3.25.2：切換數據庫後 op_logs 表要重建
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

/* ---------- v3.25.2：操作日誌 op_logs ----------
 * 目的：客戶有問題時，喺設置頁匯出操作日誌交俾開發者分析定位。
 * 每條：ts(ISO8601+時區)｜app/core｜session｜actor｜op｜entity｜detail｜before/after｜result｜fiscal_year｜os */
var opLogSession = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
var opLogActor = '';
var opLogTableReady = false;
function opLogTs(d){
  d = d || new Date();
  var pad = function(n){ return String(n).padStart(2, '0'); };
  var off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-', a = Math.abs(off);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' +
    pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) +
    sign + pad(Math.floor(a / 60)) + ':' + pad(a % 60);
}
function opLogOs(){
  try{
    var p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    p = String(p).toLowerCase();
    if(p.indexOf('mac') >= 0) return 'darwin';
    if(p.indexOf('win') >= 0) return 'win32';
    if(p.indexOf('linux') >= 0) return 'linux';
    return p || 'unknown';
  }catch(e){ return 'unknown'; }
}
var OPLOG_OS = opLogOs();
async function opLogEnsureTable(){
  if(opLogTableReady) return;
  await dbPort.execute(
    'CREATE TABLE IF NOT EXISTS op_logs (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
    'ts TEXT NOT NULL,' +
    'ts_ms INTEGER NOT NULL,' +
    'app TEXT NOT NULL,' +
    'core TEXT NOT NULL,' +
    'session TEXT NOT NULL,' +
    'actor TEXT,' +
    'op TEXT NOT NULL,' +
    'entity TEXT,' +
    'detail TEXT,' +
    '"before" TEXT,' +
    '"after" TEXT,' +
    'result TEXT NOT NULL,' +
    'fiscal_year TEXT,' +
    'os TEXT)'
  );
  await dbPort.execute('CREATE INDEX IF NOT EXISTS idx_op_logs_ts ON op_logs(ts_ms)');
  await dbPort.execute('CREATE INDEX IF NOT EXISTS idx_op_logs_op ON op_logs(op)');
  opLogTableReady = true;
}
function opLogStr(v){
  if(v === null || v === undefined) return null;
  return (typeof v === 'string') ? v : JSON.stringify(v);
}
async function writeOpLog(entry){
  try{
    if(!dbPort) return;
    await opLogEnsureTable();
    var now = new Date();
    var fy = null;
    try{ fy = TG.fiscalLabel ? String(TG.fiscalLabel()) : null; }catch(e){}
    await dbPort.execute(
      'INSERT INTO op_logs (ts, ts_ms, app, core, session, actor, op, entity, detail, "before", "after", result, fiscal_year, os)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [opLogTs(now), now.getTime(), TG.desktopVersion || '', '3.15.1', opLogSession,
       opLogActor || null, entry.op || 'unknown',
       opLogStr(entry.entity), opLogStr(entry.detail),
       opLogStr(entry.before), opLogStr(entry.after),
       entry.result || 'ok', fy, OPLOG_OS]
    );
    // 上限：只保留最近 10,000 條或 90 日，超咗自動清最舊
    await dbPort.execute(
      'DELETE FROM op_logs WHERE id NOT IN (SELECT id FROM op_logs ORDER BY ts_ms DESC, id DESC LIMIT 10000)'
    );
    await dbPort.execute(
      'DELETE FROM op_logs WHERE ts_ms < ?',
      [now.getTime() - 90 * 24 * 3600 * 1000]
    );
  }catch(e){ console.error('[desktop] 操作日誌寫入失敗：', e); }
}
