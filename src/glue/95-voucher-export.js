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

