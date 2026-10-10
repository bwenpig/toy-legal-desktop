/* ---------- 9b. 桌面設置（桌面獨有 view；web-src 零改動） ----------
 * 入口：側欄 nav 注入「桌面設置」掣（無 data-route，web-src navigate() 唔會理）。
 * 開啟時隱藏 #appShell（web app root），關閉還原。全部 DOM／CSS 由呢度擁有。 */
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
/* ---------- v3.25.2：操作日誌匯出 ---------- */
async function refreshOpLogCount(){
  try{
    var el = document.getElementById('tgOpLogCount');
    if(!el) return;
    await opLogEnsureTable();
    var rows = await dbPort.select('SELECT COUNT(*) AS c, MIN(ts) AS mn, MAX(ts) AS mx FROM op_logs');
    var c = rows && rows[0] ? rows[0].c : 0;
    el.textContent = c ? ('共 ' + c + ' 條（' + String(rows[0].mn || '').slice(0, 10) + ' 至 ' + String(rows[0].mx || '').slice(0, 10) + '）') : '暫無記錄';
  }catch(e){}
}
function opLogParseField(v){
  if(v === null || v === undefined) return null;
  if(typeof v !== 'string') return v;
  try{ return JSON.parse(v); }catch(e){ return v; }
}
async function onExportOpLog(){
  try{
    await opLogEnsureTable();
    var fromEl = document.getElementById('tgOpLogFrom');
    var toEl = document.getElementById('tgOpLogTo');
    var fromMs = (fromEl && fromEl.value) ? new Date(fromEl.value + 'T00:00:00').getTime() : 0;
    var toMs = (toEl && toEl.value) ? new Date(toEl.value + 'T23:59:59').getTime() : Date.now();
    if(isNaN(fromMs)) fromMs = 0;
    if(isNaN(toMs)) toMs = Date.now();
    var rows = await dbPort.select(
      'SELECT ts, app, core, session, actor, op, entity, detail, "before", "after", result, fiscal_year, os' +
      ' FROM op_logs WHERE ts_ms >= ? AND ts_ms <= ? ORDER BY ts_ms ASC, id ASC',
      [fromMs, toMs]
    );
    var logs = rows.map(function(r){
      return {
        ts: r.ts, app: r.app, core: r.core, session: r.session, actor: r.actor,
        op: r.op, entity: opLogParseField(r.entity), detail: opLogParseField(r.detail),
        before: opLogParseField(r.before), after: opLogParseField(r.after),
        result: r.result, fiscal_year: r.fiscal_year, os: r.os
      };
    });
    var payload = {
      exportedAt: opLogTs(new Date()),
      app: TG.desktopVersion || '', core: '3.15.1',
      from: (fromEl && fromEl.value) || null, to: (toEl && toEl.value) || null,
      count: logs.length, logs: logs
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var fname = 'toys-gallery-op-log-' + new Date().toISOString().slice(0, 10) + '.json';
    var dl = await nativeDownload(blob, fname, '匯出操作日誌');
    if(dl && dl.desktopCancelled){ setSettingsStatus('已取消匯出'); return; }
    setSettingsStatus('操作日誌已匯出：' + logs.length + ' 條' + (dl && dl.desktopSaved ? '（' + dl.desktopSaved + '）' : ''));
    refreshOpLogCount();
    await writeOpLog({ op: 'settings.change', detail: '匯出操作日誌 JSON（' + logs.length + ' 條）', result: 'ok' });
  }catch(e){
    console.error('[desktop] 匯出操作日誌失敗：', e);
    setSettingsStatus('匯出操作日誌失敗：' + (e.message || e));
  }
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
    await writeOpLog({
      op: 'import.json',
      detail: '設置頁 JSON 匯入完成：' + vCount + ' 張 voucher，' + aCount + ' 個科目（檔：' + (imp.fileName || '未知') + '）',
      after: { vouchers: vCount, accounts: aCount },
      result: 'ok'
    });
  }catch(e){
    console.error('[desktop] settings import 失敗：', e);
    failMsg = (e.message || e);
    setSettingsStatus('匯入失敗：' + failMsg + '（目前數據庫已備份，未被覆蓋）');
    await writeOpLog({ op: 'import.json', detail: '設置頁 JSON 匯入失敗', result: 'error', after: { message: String(failMsg).split('\n')[0] } });
  }finally{
    dbWriteEnabled = true;
    lastStableHash = null;
    if(ok){ try{ await persistNow(); }catch(e){} }
  }
}

