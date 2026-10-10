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
    var wsInv = XLSX.utils.aoa_to_sheet([
      ['財年 FiscalYear', '客戶／供應商 Party', '發票號 InvoiceNo', '發票日期 Date', '金額 Amount', '類型 Type（AR=應收/AP=應付）'],
      ['2024', 'Toy Hunters', 'INV2024030014', '2024-03-20', 11280, 'AR']
    ]);
    wsInv['!cols'] = [{ wch: 18 }, { wch: 30 }, { wch: 20 }, { wch: 16 }, { wch: 18 }, { wch: 22 }];
    XLSX.utils.book_append_sheet(wb, wsInv, '期初發票');
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
    var imp = { accounts: [], opening: [], invoices: [] };

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
    var wsInv = wb.Sheets['期初發票'] || wb.Sheets['OpeningInvoices'];
    if(wsInv){
      var rows3 = XLSX.utils.sheet_to_json(wsInv, { header: 1, defval: '' });
      var hi3 = findHeaderRow(rows3, function(c){ return /發票號|InvoiceNo/i.test(c); });
      if(hi3 >= 0) for(var k = hi3 + 1; k < rows3.length; k++){
        var ify = String(rows3[k][0] || '').trim(),
            party = String(rows3[k][1] || '').trim(),
            invNo = String(rows3[k][2] || '').trim(),
            invDate = String(rows3[k][3] || '').trim(),
            invAmt = Number(String(rows3[k][4]).replace(/,/g, '')),
            invType = String(rows3[k][5] || '').trim().toUpperCase();
        if(!ify && !party && !invNo) continue;
        imp.invoices.push({ fy: ify, party: party, no: invNo, date: invDate, amount: invAmt, kind: invType });
      }
    }
    if(!imp.accounts.length && !imp.opening.length && !imp.invoices.length){ setStatus('Excel 內無可匯入資料'); return; }

    var res = TG.importExcelData(imp);
    schedulePersist();
    var invMsg = res.setInvoices ? '· 期初發票 ' + res.setInvoices + ' 張' + (res.invoiceErrors ? '（' + res.invoiceErrors + ' 張失敗）' : '') : '';
    var invMismatch = res.invoiceMismatch && res.invoiceMismatch.length ? ' ⚠ 發票總數同期初數唔啱：' + res.invoiceMismatch.join('、') : '';
    setStatus('匯入完成：科目新增 ' + res.addedAccounts + '（跳過 ' + res.skippedAccounts +
      '）· 期初數 ' + res.setOpening + ' 筆' + (res.openingErrors ? '（' + res.openingErrors + ' 筆失敗：財年／科目唔啱）' : '') + invMsg + invMismatch);
  }catch(e){
    console.error('[desktop] excel import failed:', e);
    setStatus('匯入失敗：' + (e.message || e));
  }
}

