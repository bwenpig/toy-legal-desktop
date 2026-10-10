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
    companyNameModal('修改公司名稱', currentCompanyName || '', function(name){
      setCompanyName(name);
    });
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

