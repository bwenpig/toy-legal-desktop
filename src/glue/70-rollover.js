/* ---------- v3.26.0：年結自動結轉（桌面獨有） ----------
 * 喺財年管理加「年結轉賬」掣：揀來源財年 → 預覽 → 確認寫入下年期初
 */
(function(){
  function ensureRolloverBtn(){
    var fm = document.getElementById('fiscalManager');
    if(!fm || document.getElementById('tgRolloverBtn')) return;
    var btn = document.createElement('button');
    btn.id = 'tgRolloverBtn';
    btn.className = 'btn';
    btn.type = 'button';
    btn.textContent = '年結轉賬';
    btn.title = '將上年度 closing 結轉為新財年 opening（資產／負債／權益＋AR/AP發票明細）';
    btn.style.cssText = 'margin-left:8px;';
    btn.addEventListener('click', openRolloverModal);
    // 放喺新增財年表單隔離
    var form = document.getElementById('fiscalYearForm');
    if(form && form.parentElement){
      form.parentElement.insertBefore(btn, form.nextSibling);
    }else{
      fm.appendChild(btn);
    }
  }
  function openRolloverModal(){
    var TG = window.__TG__;
    if(!TG || !TG.previewRollover){ setStatus('結轉功能未就緒'); return; }
    // 搵最新兩個財年
    var sel = document.getElementById('fiscalYearSelect');
    var fys = [];
    if(sel){
      for(var i = 0; i < sel.options.length; i++){
        fys.push({ key: sel.options[i].value, label: sel.options[i].text });
      }
    }
    if(fys.length < 1){ setStatus('無財年可結轉'); return; }
    // 預設：由最新財年結轉去下一年（如果下一年未開，先提示開財年）
    var fromKey = fys[0].key;
    var fromStart = parseInt(fromKey, 10);
    var toKey = String(fromStart + 1);
    var toExists = fys.some(function(f){ return f.key === toKey; });
    if(!toExists){
      setStatus('請先新增 ' + toKey + ' 財年，再做年結轉賬');
      return;
    }
    var preview = TG.previewRollover(fromKey);
    if(!preview){ setStatus('預覽失敗'); return; }
    showRolloverPreview(preview, fromKey, toKey);
  }
  function showRolloverPreview(pv, fromKey, toKey){
    var old = document.getElementById('tgRolloverModal');
    if(old) old.remove();
    var overlay = document.createElement('div');
    overlay.id = 'tgRolloverModal';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;';
    var box = document.createElement('div');
    box.style.cssText = 'background:var(--surface,#fff);border-radius:12px;padding:24px;width:min(700px,92vw);max-height:85vh;overflow:auto;';
    var html = '<h3 style="margin:0 0 12px;">年結轉賬預覽</h3>' +
      '<p style="color:var(--muted);font-size:13px;">由 ' + escHtml(pv.fromLabel) + ' 結轉至 ' + escHtml(pv.toLabel) + '。只結轉資產／負債／權益科目；收入／成本／費用唔帶。</p>';
    html += '<h4>科目結轉（' + pv.accounts.length + ' 個）</h4>';
    html += '<div style="max-height:200px;overflow:auto;border:1px solid var(--line);border-radius:8px;"><table class="tgset-grid"><thead><tr><th>科目</th><th>類別</th><th>Closing</th><th>→ Opening</th></tr></thead><tbody>';
    pv.accounts.forEach(function(a){
      html += '<tr><td>' + escHtml(a.name) + '</td><td>' + escHtml(a.type) + '</td><td class="num">' + fmtCentsPlain(a.closing) + '</td><td class="num">' + fmtCentsPlain(a.closing) + '</td></tr>';
    });
    html += '</tbody></table></div>';
    html += '<h4>AR/AP 未清發票（' + pv.invoices.length + ' 張）</h4>';
    if(pv.invoices.length){
      html += '<div style="max-height:200px;overflow:auto;border:1px solid var(--line);border-radius:8px;"><table class="tgset-grid"><thead><tr><th>類型</th><th>對方</th><th>發票號</th><th>日期</th><th>未清金額</th></tr></thead><tbody>';
      pv.invoices.forEach(function(inv){
        html += '<tr><td>' + inv.kind + '</td><td>' + escHtml(inv.party) + '</td><td>' + escHtml(inv.no) + '</td><td>' + escHtml(inv.date) + '</td><td class="num">' + fmtCentsPlain(inv.outstanding) + '</td></tr>';
      });
      html += '</tbody></table></div>';
    }else{
      html += '<p style="color:var(--muted)">無未清發票</p>';
    }
    html += '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">' +
      '<button class="btn" id="tgRolloverCancel" type="button">取消</button>' +
      '<button class="btn primary" id="tgRolloverGo" type="button">確認結轉</button></div>';
    box.innerHTML = html;
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    document.getElementById('tgRolloverCancel').addEventListener('click', function(){ overlay.remove(); });
    overlay.addEventListener('click', function(e){ if(e.target === overlay) overlay.remove(); });
    document.getElementById('tgRolloverGo').addEventListener('click', function(){
      var TG = window.__TG__;
      var res = TG.executeRollover(fromKey, toKey);
      schedulePersist();
      overlay.remove();
      setStatus('結轉完成：' + res.accounts + ' 個科目，' + res.invoices + ' 張發票');
      writeOpLog({ op: 'fiscal.rollover', detail: '年結轉賬 ' + pv.fromLabel + ' → ' + pv.toLabel, result: 'ok', after: res });
    });
  }
  // 用 MutationObserver 確保財年管理開嗰陣有掣
  new MutationObserver(function(){ ensureRolloverBtn(); }).observe(document.body, { childList: true, subtree: true });
  // 初次試
  setTimeout(ensureRolloverBtn, 2000);

  // v3.26.1：開完新財年自動彈結轉預覽（唔使手撳掣）
  // 用 MutationObserver 監測 fiscalYearSelect 嘅 option 變化（比 polling 穩）
  function setupAutoRollover(){
    var sel = document.getElementById('fiscalYearSelect');
    if(!sel || sel.dataset.tgRolloverHook) return;
    sel.dataset.tgRolloverHook = '1';
    var lastCount = sel.options.length;
    new MutationObserver(function(){
      var n = sel.options.length;
      if(n > lastCount){
        lastCount = n;
        // 有新財年加入
        setTimeout(function(){
          var TG = window.__TG__;
          if(!TG || !TG.previewRollover) return;
          if(sel.options.length >= 2){
            // 搵最大嘅 key（最新財年）同第二大
            var keys = [];
            for(var i=0;i<sel.options.length;i++) keys.push(sel.options[i].value);
            keys.sort().reverse();
            var toKey = keys[0], fromKey = keys[1];
            var preview = TG.previewRollover(fromKey);
            if(preview && preview.accounts.length > 0){
              showRolloverPreview(preview, fromKey, toKey);
            }
          }
        }, 800);
      } else {
        lastCount = n;
      }
    }).observe(sel, { childList: true });
  }
  // 定期確保 hook 已裝（select 可能遲加載）
  setInterval(setupAutoRollover, 2000);
  setTimeout(setupAutoRollover, 2000);
})();

var DESKTOP_CHANGELOG = [
  ['3.26.2', '修復年結自動彈出唔穩定：由 polling 改用 MutationObserver 監測財年 select 變化。'],
  ['3.26.1', '年結轉賬改為自動：在財年管理新增財年後，系統自動彈出結轉預覽（唔使手撳「年結轉賬」掣）。'],
  ['3.26.0', '三個新功能：(1) Voucher Excel 加「對銷發票號」欄（N欄），有填對指定發票、吉就FIFO，預覽表顯示；(2) 期初發票 Excel 匯入：科目範本加「期初發票」頁（財年／客戶／發票號／日期／金額／AR-AP），自動校驗每客發票總數等於期初數；(3) 年結自動結轉：開新財年後「年結轉賬」掣，資產／負債／權益按類別自動結轉（新科目自動包埋），AR/AP未清發票逐張帶過去，預覽確認後寫入。'],
  ['3.25.2', 'voucher 列表加返「刪除」掣：刪除前確認（顯示編號＋金額＋摘要）；刪除後自動重過賬；已對銷嘅收款會回滾（發票恢復 outstanding）；附件一併刪除；刪除記錄寫入 deleted_vouchers 表留底。新增操作日誌（op_logs 表）：記錄入賬／修改／刪除、匯入、匯出、報表、登入同錯誤（含版本＋session＋用戶＋財年＋OS），設置頁可按日期匯出 JSON，只保留最近 10,000 條或 90 日。'],
  ['3.25.1', '修復「修改」公司名撳咗無反應：Tauri 唔支援 window.prompt，轉用自製輸入 modal（登入補錄同修改都用同一個）。'],
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
    '<section class="tgset-sec"><h3>操作日誌 <span class="muted small">（客戶有問題時匯出交俾開發者分析定位）</span></h3>' +
    '<p><label>由 <input type="date" id="tgOpLogFrom"></label> <label>到 <input type="date" id="tgOpLogTo"></label> ' +
    '<button class="btn" id="tgOpLogExport" type="button">匯出操作日誌 (JSON)…</button> ' +
    '<span class="muted small" id="tgOpLogCount"></span></p>' +
    '<p class="muted small">記錄 voucher 入賬／修改／刪除、匯入、匯出、報表產生、登入同錯誤；只保留最近 10,000 條或 90 日，超咗自動清最舊。</p></section>' +
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
  document.getElementById('tgOpLogExport').addEventListener('click', onExportOpLog);
  refreshOpLogCount();
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

