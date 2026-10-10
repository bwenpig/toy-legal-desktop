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
            // v3.25.2：每行加「刪除」掣（桌面獨有，web-src 原生 renderVoucherList 無）
            try{
              var actionsDiv = row.querySelector('.voucher-list-actions');
              if(actionsDiv && !actionsDiv.querySelector('.delete-voucher-btn')){
                var vCells = row.querySelectorAll('td');
                var vb = vCells.length > 1 && vCells[1].querySelector('b');
                var vNo = vb ? vb.textContent.trim() : '';
                if(vNo){
                  (function(no){
                    var delBtn = document.createElement('button');
                    delBtn.className = 'btn danger delete-voucher-btn';
                    delBtn.type = 'button';
                    delBtn.textContent = '刪除';
                    delBtn.setAttribute('data-no', no);
                    delBtn.style.marginLeft = '6px';
                    delBtn.addEventListener('click', function(){ handleDeleteVoucher(no); });
                    actionsDiv.appendChild(delBtn);
                  })(vNo);
                }
              }
            }catch(de){ console.error('[desktop] voucher 刪除掣加入失敗：', de); }
            if(row.querySelector('.attachment-btn')) continue; // 呢行已處理附件掣
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

  /* v3.25.2：刪除 voucher（桌面獨有；web-src 原生無刪除功能）。
   * 流程：確認 dialog（編號＋金額＋摘要）→ TG.deleteVoucher（反過賬＋清對銷＋移除＋重繪）
   * → audit 寫入 deleted_vouchers 表 → 即時 persistNow 寫庫。 */
  async function handleDeleteVoucher(no){
    try{
      if(!TG.getVoucherDeleteInfo || !TG.deleteVoucher){
        setStatus('刪除功能未就緒，請重開 App'); return;
      }
      var info = TG.getVoucherDeleteInfo(no);
      if(!info){ setStatus('搵唔到 voucher ' + no); return; }
      var msg = '確定刪除呢張 voucher？\n\n' +
        '編號：' + info.no + '\n' +
        '日期：' + info.date + '\n' +
        '摘要：' + info.desc + '\n' +
        '金額：' + fmtCentsPlain(info.amountCents) + '\n' +
        (info.attachmentCount ? '附件：' + info.attachmentCount + ' 個（會一併刪除）\n' : '') +
        (info.allocationCount ? '對銷：' + info.allocationCount + ' 筆（會回滾，發票恢復 outstanding）\n' : '') +
        '\n刪除後自動重過賬，試算表保持平衡；刪除記錄會留底。';
      if(!confirm(msg)) return; // 用戶取消
      var snapshot = TG.deleteVoucher(info.no);
      if(!snapshot){ setStatus('刪除失敗：搵唔到 ' + info.no); return; }
      try{
        await dbPort.execute(
          'CREATE TABLE IF NOT EXISTS deleted_vouchers (' +
          'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
          'voucher_no TEXT NOT NULL,' +
          'deleted_at TEXT NOT NULL DEFAULT (datetime(\'now\')),' +
          'voucher_json TEXT NOT NULL)'
        );
        await dbPort.execute(
          'INSERT INTO deleted_vouchers (voucher_no, voucher_json) VALUES (?, ?)',
          [info.no, JSON.stringify(snapshot)]
        );
      }catch(ae){ console.error('[desktop] 刪除記錄寫入失敗：', ae); }
      await persistNow(); // 即時寫庫，唔等 debounce
      await writeOpLog({
        op: 'voucher.delete',
        entity: { kind: 'voucher', no: info.no },
        detail: '刪除 voucher（金額分：' + info.amountCents + '，附件 ' + info.attachmentCount + ' 個，對銷 ' + info.allocationCount + ' 筆已回滾）',
        before: { no: info.no, date: info.date, desc: info.desc, amountCents: info.amountCents,
                  lines: snapshot.lines ? snapshot.lines.length : 0,
                  attachments: info.attachmentCount, allocations: info.allocationCount },
        after: { deleted: true },
        result: 'ok'
      });
      setStatus('已刪除 voucher ' + info.no);
    }catch(e){
      console.error('[desktop] 刪除 voucher 失敗：', e);
      setStatus('刪除失敗：' + (e.message || e));
    }
  }

  /* 登入追蹤：body 變成 authenticated 即記低 actor＋寫 login log */
  try{
    var loginObs = new MutationObserver(function(){
      try{
        if(document.body.classList.contains('authenticated') && !opLogActor){
          var lu = document.getElementById('loginUser');
          opLogActor = (lu && lu.value ? String(lu.value).trim() : '') || 'admin';
          writeOpLog({ op: 'login', detail: '用戶登入', result: 'ok' });
        }
      }catch(e){}
    });
    loginObs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }catch(e){}
  /* 全局錯誤：記低堆棧第一行，唔吞 */
  window.addEventListener('error', function(ev){
    try{
      var msg = String((ev && ev.message) || 'unknown error');
      var stack1 = '';
      try{ stack1 = String((ev && ev.error && ev.error.stack) || '').split('\n')[1] || ''; }catch(e){}
      writeOpLog({ op: 'error', detail: msg + (stack1 ? ' ＠' + stack1.trim() : ''), result: 'error' });
    }catch(e){}
  });
  window.addEventListener('unhandledrejection', function(ev){
    try{
      var r = ev && ev.reason;
      var msg = String((r && (r.message || r)) || 'unhandled rejection');
      writeOpLog({ op: 'error', detail: 'unhandledrejection: ' + msg, result: 'error' });
    }catch(e){}
  });
  /* voucher.create／update：postBtn capture 快照 before，toast 成功訊號寫 log。
   * web core 過賬成功會喺 #postToast 顯示「✓ B100126 已過賬…」／「✓ B100126 已儲存修改、重新過賬…」。 */
  /* report.generate：報表掣點擊即記（報表名＋月份篩選） */
  document.addEventListener('click', function(e){
    try{
      var t = e.target;
      if(!t || !t.getAttribute) return;
      var rb = t.closest ? t.closest('[data-report]') : null;
      if(!rb) return;
      var rkey = rb.getAttribute('data-report');
      var rlabel = (rb.textContent || rkey).trim();
      var period = '';
      try{ period = TG.reportPeriodLabel ? String(TG.reportPeriodLabel() || '') : ''; }catch(e2){}
      writeOpLog({ op: 'report.generate', detail: '產生報表：' + rlabel + (period ? '（' + period + '）' : '（全年）'), after: { report: rkey, period: period || '全年' }, result: 'ok' });
    }catch(e3){}
  }, true);
  var pendingPostBefore = null;
  document.addEventListener('click', function(e){
    try{
      var t = e.target;
      if(!t || t.id !== 'postBtn') return;
      var noEl = document.getElementById('voucherNoInput');
      var no = noEl ? String(noEl.value || '').trim() : '';
      var isEdit = /修改/.test(t.textContent || '');
      var before = null;
      try{ before = (isEdit && no && TG.getVoucher) ? TG.getVoucher(no) : null; }catch(e2){}
      pendingPostBefore = { no: no, isEdit: isEdit, before: before, at: Date.now() };
    }catch(e){}
  }, true);
  try{
    var toastObs = new MutationObserver(function(){
      try{
        var toast = document.getElementById('postToast');
        if(!toast || !toast.classList.contains('show')) return;
        var txt = String(toast.textContent || '');
        var m = txt.match(/✓\s*(\S+)\s*已(儲存修改、重新)?過賬/);
        if(!m || !pendingPostBefore) return;
        if(Date.now() - pendingPostBefore.at > 10000) return; // 太舊嘅快照唔用
        var pno = m[1], isUpdate = !!m[2];
        var after = null;
        try{ after = TG.getVoucher ? TG.getVoucher(pno) : null; }catch(e2){}
        var beforeSum = pendingPostBefore.before ? {
          no: pendingPostBefore.before.no, date: pendingPostBefore.before.date,
          desc: pendingPostBefore.before.desc,
          amountCents: (pendingPostBefore.before.lines || []).reduce(function(s, l){ return s + (l.debit || 0); }, 0),
          lines: (pendingPostBefore.before.lines || []).length
        } : null;
        var afterSum = after ? {
          no: after.no, date: after.date, desc: after.desc,
          amountCents: (after.lines || []).reduce(function(s, l){ return s + (l.debit || 0); }, 0),
          lines: (after.lines || []).length,
          attachments: (after.attachments || []).length
        } : null;
        writeOpLog({
          op: isUpdate ? 'voucher.update' : 'voucher.create',
          entity: { kind: 'voucher', no: pno },
          detail: (isUpdate ? '修改並重新過賬' : '新增過賬') +
            (afterSum ? '（金額分：' + afterSum.amountCents + '，' + afterSum.lines + ' 行，分錄' + afterSum.attachments + ' 附件）' : ''),
          before: beforeSum, after: afterSum, result: 'ok'
        });
        pendingPostBefore = null;
      }catch(e){}
    });
    var postToastEl = document.getElementById('postToast');
    if(postToastEl) toastObs.observe(postToastEl, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  }catch(e){}

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

/* v3.25.0：公司名補錄／修改（v3.25.1：Tauri 唔支援 window.prompt，轉用自製 modal） */
function companyNameModal(title, initial, onOk){
  // 刪舊嘅
  var old = document.getElementById('tgCompanyModal');
  if(old) old.remove();
  var overlay = document.createElement('div');
  overlay.id = 'tgCompanyModal';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center;';
  var box = document.createElement('div');
  box.style.cssText = 'background:var(--surface,#fff);border:1px solid var(--line,#ddd);border-radius:12px;padding:24px;width:min(420px,90vw);box-shadow:0 8px 32px rgba(0,0,0,.25);';
  box.innerHTML =
    '<h3 style="margin:0 0 8px;font-size:16px;">' + escHtml(title) + '</h3>' +
    '<p style="margin:0 0 12px;font-size:12px;color:var(--muted,#666);">將顯示喺工具欄同匯出文件，用嚟識別數據係邊間公司。</p>' +
    '<input id="tgCompanyInput" type="text" style="width:100%;padding:10px 12px;font-size:14px;border:1px solid var(--line,#ccc);border-radius:8px;box-sizing:border-box;" placeholder="例如 ABC 玩具有限公司" value="' + escHtml(initial || '') + '">' +
    '<p id="tgCompanyErr" style="margin:8px 0 0;font-size:12px;color:var(--bad,#c00);min-height:16px;"></p>' +
    '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">' +
    '<button id="tgCompanyCancel" class="btn" type="button">取消</button>' +
    '<button id="tgCompanyOk" class="btn primary" type="button">確定</button>' +
    '</div>';
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  var input = document.getElementById('tgCompanyInput');
  var err = document.getElementById('tgCompanyErr');
  function close(){ overlay.remove(); }
  document.getElementById('tgCompanyCancel').addEventListener('click', close);
  overlay.addEventListener('click', function(e){ if(e.target === overlay) close(); });
  function submit(){
    var v = String(input.value || '').trim();
    if(!v){ err.textContent = '請輸入公司名稱'; input.focus(); return; }
    close();
    onOk(v);
  }
  document.getElementById('tgCompanyOk').addEventListener('click', submit);
  input.addEventListener('keydown', function(e){ if(e.key === 'Enter') submit(); });
  setTimeout(function(){ input.focus(); input.select(); }, 50);
}
function promptCompanyName(){
  // 自動化測試（headless）跳過，唔好 block
  try{ if(navigator.webdriver) return; }catch(e){}
  companyNameModal('請輸入公司名稱', currentCompanyName || '', function(name){
    setCompanyName(name);
  });
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

