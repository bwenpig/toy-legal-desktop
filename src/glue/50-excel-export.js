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
    await writeOpLog({
      op: 'export.report',
      detail: '匯出 Excel 報表（9 份' + (periodLabel ? '，' + periodLabel : '全年') + '，附件 ' + attCount + ' 個 → zip）',
      after: { sheets: 9, period: periodLabel || '全年', attachments: attCount, errors: errors.length },
      result: errors.length ? 'error' : 'ok'
    });
  }catch(e){
    console.error('[desktop] excel export failed:', e);
    setStatus('匯出失敗：' + (e.message || e));
    await writeOpLog({ op: 'export.report', detail: '匯出 Excel 報表失敗', result: 'error', after: { message: String(e.message || e).split('\n')[0] } });
  }
}

