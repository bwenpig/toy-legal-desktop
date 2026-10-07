/**
 * 桌面版 xlsx 後期加工（凍結窗格／列印標題／標題加粗）。
 *
 * 背景：SheetJS Community Edition 寫 xlsx 時不支援 `!freeze`、`!printTitles`、
 * cell 樣式（bold）。呢度用 JSZip 直接改 zip 入面嘅 XML 來補上——xlsx 本來就係 zip。
 *
 * 用法（跑喺 browser，JSZip 由 glue 經 window.JSZip 傳入）：
 *   const raw = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
 *   const pretty = await polishXlsx(new Uint8Array(raw), [
 *     { name: '試算表 Trial Balance', freezeRows: 4, titleRows: '1:3', boldRows: [0] },
 *   ], window.JSZip);
 */
export interface PolishSheetOpts {
  /** sheet 名（要同 book_append_sheet 時用嘅名一字不差） */
  name: string;
  /** 凍結頂部幾行（例如標題 3 行＋表頭 1 行 = 4） */
  freezeRows: number;
  /** 列印時每頁重複嘅行，例如 '1:3'；唔傳＝唔設 */
  titleRows?: string;
  /** 加粗嘅行（0-based），例如標題行 [0] */
  boldRows?: number[];
}

function escXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** workbook.xml → sheet 名 → worksheet 檔名（xl/worksheets/sheetN.xml） */
function sheetFileMap(workbookXml: string, relsXml: string): Map<string, string> {
  const relMap = new Map<string, string>();
  const relRe = /<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"|<Relationship[^>]*Target="([^"]+)"[^>]*Id="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = relRe.exec(relsXml))) {
    const id = m[1] || m[4];
    const target = m[2] || m[3];
    if (id && target) relMap.set(id, target.replace(/^.*\//, ''));
  }
  const out = new Map<string, string>();
  const sheetRe = /<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"|<sheet[^>]*r:id="([^"]+)"[^>]*name="([^"]+)"/g;
  while ((m = sheetRe.exec(workbookXml))) {
    const name = (m[1] || m[4] || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const rid = m[2] || m[3];
    const file = relMap.get(rid);
    if (name && file) out.set(name, 'xl/worksheets/' + file);
  }
  return out;
}

function injectFreezePane(sheetXml: string, freezeRows: number): string {
  if (freezeRows <= 0) return sheetXml;
  const topLeft = 'A' + (freezeRows + 1);
  const pane =
    '<pane ySplit="' + freezeRows + '" topLeftCell="' + topLeft +
    '" activePane="bottomLeft" state="frozen"/>' +
    '<selection pane="bottomLeft" activeCell="' + topLeft + '" sqref="' + topLeft + '"/>';
  // SheetJS CE 寫出 <sheetView workbookViewId="0"/>；換成帶 pane 嘅版本
  if (/<sheetView[^>]*\/>/.test(sheetXml)) {
    return sheetXml.replace(
      /<sheetView([^>]*)\/>/,
      '<sheetView$1>' + pane + '</sheetView>',
    );
  }
  if (/<sheetView([^>]*)>/.test(sheetXml)) {
    return sheetXml.replace(/(<sheetView[^>]*>)/, '$1' + pane);
  }
  return sheetXml;
}

/** 喺 <row r="N"> 入面嘅每個 <c r=".."> 加 s="boldXfId" */
function boldRowCells(sheetXml: string, boldRows: number[], xfId: number): string {
  let out = sheetXml;
  for (const r0 of boldRows) {
    const r = r0 + 1; // 0-based → Excel 行號
    const rowRe = new RegExp('(<row[^>]*\\br="' + r + '"[^>]*>)([\\s\\S]*?)(</row>)');
    out = out.replace(rowRe, (_all, open: string, inner: string, close: string) => {
      const patched = inner.replace(/<c(\s[^>]*)?>/g, (cm: string) => {
        if (/\bs="/.test(cm)) return cm; // 已有樣式唔郁
        return cm.replace(/>$/, ' s="' + xfId + '">');
      });
      return open + patched + close;
    });
  }
  return out;
}

/**
 * styles.xml 加一個粗體 font＋對應 cellXf，回傳新 xfId。
 * SheetJS CE 嘅 styles.xml 結構：fonts/fills/borders/cellStyleXfs/cellXfs。
 */
function addBoldStyle(stylesXml: string): { xml: string; xfId: number } {
  const fontCount = (stylesXml.match(/<font>/g) || []).length;
  const xfCount = (stylesXml.match(/<xf /g) || []).length;
  // 抽現有第一個 font 做 base（通常 Calibri 11），加粗
  const firstFont = stylesXml.match(/<font>[\s\S]*?<\/font>/);
  const baseFont = firstFont ? firstFont[0] : '<font><sz val="11"/><name val="Calibri"/></font>';
  const boldFont = baseFont.replace('</font>', '<b/></font>');
  const newFontXml = boldFont;
  let xml = stylesXml.replace(/(<\/fonts>)/, newFontXml + '$1');
  xml = xml.replace(/(<fonts[^>]*count=")\d+(")/, '$1' + (fontCount + 1) + '$2');
  // cellXfs 加一條指向新 font（numFmtId=0, fillId=0, borderId=0, xfId=0）
  const newXf = '<xf numFmtId="0" fontId="' + fontCount + '" fillId="0" borderId="0" xfId="0" applyFont="1"/>';
  xml = xml.replace(/(<\/cellXfs>)/, newXf + '$1');
  xml = xml.replace(/(<cellXfs[^>]*count=")\d+(")/, '$1' + (xfCount + 1) + '$2');
  return { xml, xfId: xfCount };
}

function addPrintTitles(workbookXml: string, sheetIdx: number, sheetName: string, titleRows: string): string {
  const quoted = "'" + sheetName.replace(/'/g, "''") + "'";
  const entry =
    '<definedName name="_xlnm.Print_Titles" localSheetId="' + sheetIdx + '">' +
    quoted + '!$' + titleRows.replace(':', ':$') + '</definedName>';
  // 注意：entry 入面有 $1 呢類字元，唔可以用字串做 replacement（會被當 backreference）——用 function
  if (/<definedNames>/.test(workbookXml)) {
    return workbookXml.replace(/(<\/definedNames>)/, () => entry + '</definedNames>');
  }
  // 冇 definedNames（少見）：插喺 </workbook> 前
  return workbookXml.replace(/(<\/workbook>)/, () => '<definedNames>' + entry + '</definedNames></workbook>');
}

export async function polishXlsx(
  xlsxBytes: Uint8Array,
  sheets: PolishSheetOpts[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  JSZip: any,
): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(xlsxBytes);
  const workbookXml = await zip.file('xl/workbook.xml').async('string');
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const fileMap = sheetFileMap(workbookXml, relsXml);

  // workbook.xml 入面 sheet 順序 → localSheetId
  const sheetOrder: string[] = [];
  const orderRe = /<sheet[^>]*name="([^"]+)"/g;
  let om: RegExpExecArray | null;
  while ((om = orderRe.exec(workbookXml))) {
    sheetOrder.push(
      om[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
    );
  }

  let newWorkbookXml = workbookXml;
  let stylesPatched: { xml: string; xfId: number } | null = null;

  for (const opt of sheets) {
    const file = fileMap.get(opt.name);
    if (!file || !zip.file(file)) continue;
    let sheetXml = await zip.file(file).async('string');
    sheetXml = injectFreezePane(sheetXml, opt.freezeRows);
    if (opt.boldRows && opt.boldRows.length) {
      if (!stylesPatched) {
        const stylesXml = await zip.file('xl/styles.xml').async('string');
        stylesPatched = addBoldStyle(stylesXml);
        zip.file('xl/styles.xml', stylesPatched.xml);
      }
      sheetXml = boldRowCells(sheetXml, opt.boldRows, stylesPatched.xfId);
    }
    zip.file(file, sheetXml);
    if (opt.titleRows) {
      const idx = sheetOrder.indexOf(opt.name);
      if (idx >= 0) {
        newWorkbookXml = addPrintTitles(newWorkbookXml, idx, opt.name, opt.titleRows);
      }
    }
  }
  if (newWorkbookXml !== workbookXml) zip.file('xl/workbook.xml', newWorkbookXml);
  const out = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  return out as Uint8Array;
}
