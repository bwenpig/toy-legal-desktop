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
    await writeOpLog({ op: 'export.excel', detail: '下載 Voucher 匯入範本（檔：Toys-Gallery-voucher-import-template.xlsx）', result: 'ok' });
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
      '<div class="tgset-gridwrap" style="max-height:220px"><table class="tgset-grid"><thead><tr><th>Voucher No.</th><th>日期</th><th>類型</th><th>摘要</th><th>行數</th><th>金額</th><th>附件</th><th>對銷發票</th></tr></thead><tbody>' +
      parsed.validDrafts.map(function(d){
        var dr = d.lines.reduce(function(s, l){ return s + l.debit; }, 0);
        var att = (d.attachmentPaths && d.attachmentPaths.length) ? ('📎 ' + d.attachmentPaths.length + ' 個') : '—';
        var alloc = d.allocationInvoice ? escHtml(d.allocationInvoice) : '<span style="color:var(--muted)">FIFO</span>';
        return '<tr><td>' + escHtml(d.voucherNo || '（自動編號）') + '</td><td>' + escHtml(d.date) + '</td><td>' +
          (d.type === 'B' ? '銀行' : '轉賬') + '</td><td>' + escHtml(d.desc) + '</td><td>' + d.lines.length +
          '</td><td>' + escHtml(fmtCentsPlain(dr)) + '</td><td>' + escHtml(att) + '</td><td>' + alloc + '</td></tr>';
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
    await writeOpLog({
      op: 'import.folder',
      detail: '資料夾匯入 Excel：' + res.imported + ' 張 voucher（' + res.voucherNos.slice(0, 5).join('、') + '），附件 ' + attOk + ' 個成功／' + attFail.length + ' 個失敗（資料夾：' + (excelPath || '未知') + '）',
      after: { imported: res.imported, voucherNos: res.voucherNos.slice(0, 10), attOk: attOk, attFail: attFail.length },
      result: 'ok'
    });
  }catch(e){
    console.error('[desktop] voucher excel import 失敗：', e);
    dbWriteEnabled = true;
    setSettingsStatus('匯入失敗：' + (e.message || e));
    await writeOpLog({ op: 'import.folder', detail: '資料夾匯入 Excel 失敗', result: 'error', after: { message: String(e.message || e).split('\n')[0] } });
  }
}

