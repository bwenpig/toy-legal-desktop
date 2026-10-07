/**
 * 桌面版 Voucher 批量匯出 Excel（俾會計師）。
 *
 * 兩個 sheet：
 *  - 「總表 Vouchers」：每張 voucher 一行（編號／類型／日期／摘要／借貸總額／
 *    製表覆核批核／附件 hyperlink）
 *  - 「明細 Lines」：每條分錄行一行
 * 金額係美元數字（Excel 數值格，#,##0.00）。
 *
 * 附件由 glue 層複製去匯出資料夾 `attachments/<voucherNo>/`；呢度回傳
 * 每張 voucher 嘅附件清單（供 glue 複製＋加 hyperlink）。
 */
import { store, dateInFiscalYear, selectedFiscalYear } from '../web-src/state';
import type { Cents } from '../web-src/money';
import type { ExcelCell, ExcelRows } from './excel-rows';

export interface VoucherExportAttachment {
  voucherNo: string;
  name: string;
  /** app 內相對路徑（attachments/…）或空（得 dataURL，要 glue 即場寫） */
  relPath: string;
  hasDataURL: boolean;
  /** 有 dataURL 時帶埋（glue 解碼寫入 zip；大附件注意記憶體） */
  dataURL: string;
}

export interface VoucherExportLink {
  sheet: number; // 0=總表
  /** res.summary 內 0-based 行號（含 header，不含 glue 加嘅標題行） */
  r: number;
  /** 0-based 欄號 */
  c: number;
  target: string; // 相對路徑
  tooltip: string;
}

export interface VoucherExportResult {
  summary: ExcelRows;
  detail: ExcelRows;
  links: VoucherExportLink[];
  attachments: VoucherExportAttachment[];
  voucherCount: number;
  lineCount: number;
  /** 檔名用嘅範圍字串，例如 'FY2024-25_2024-04至2024-06' */
  rangeLabel: string;
}

const dollars = (cents: Cents | number): number => (cents as number) / 100;

function inRange(date: string, fromMonth: string, toMonth: string): boolean {
  const ym = date.slice(0, 7);
  if (fromMonth && ym < fromMonth) return false;
  if (toMonth && ym > toMonth) return false;
  return true;
}

export function buildVoucherExport(
  fyKey: string,
  fromMonth: string,
  toMonth: string,
): VoucherExportResult {
  const fy = store.fiscalYears.find((f) => f.key === fyKey) || selectedFiscalYear();
  const vouchers = store.vouchers
    .filter((v) => dateInFiscalYear(v.date, fy))
    .filter((v) => !fromMonth && !toMonth ? true : inRange(v.date, fromMonth, toMonth))
    .sort((a, b) => a.date.localeCompare(b.date) || a.no.localeCompare(b.no));

  const summaryHeader: ExcelCell[] = [
    'Voucher No.', '類型', '日期', '摘要', '借方總額', '貸方總額',
    '製表', '覆核', '批核', '附件',
  ];
  const detailHeader: ExcelCell[] = [
    'Voucher No.', '日期', '行號', '科目', '明細', '借方', '貸方',
  ];
  const summary: ExcelRows = [summaryHeader];
  const detail: ExcelRows = [detailHeader];
  const links: VoucherExportLink[] = [];
  const attachments: VoucherExportAttachment[] = [];

  vouchers.forEach((v, vi) => {
    const dr = v.lines.reduce((s, l) => s + (l.debit as number), 0);
    const cr = v.lines.reduce((s, l) => s + (l.credit as number), 0);
    const atts = Array.isArray(v.attachments) ? v.attachments : [];
    // r = res.summary 內 0-based 行（header 係第 0 行，數據由第 1 行起）
    const r = vi + 1;
    const c = 9; // J 欄「附件」
    let attCell: ExcelCell = '—';
    if (atts.length) {
      attCell = atts.length + ' 個附件';
      links.push({
        sheet: 0,
        r,
        c,
        target: 'attachments/' + v.no + '/',
        tooltip: atts.map((a) => a.name || '').join(', ') || '開啟附件資料夾',
      });
      atts.forEach((a) => {
        const ax = a as { path?: string; dataURL?: string };
        attachments.push({
          voucherNo: v.no,
          name: a.name || 'attachment',
          relPath: ax.path || '',
          hasDataURL: typeof ax.dataURL === 'string',
          dataURL: typeof ax.dataURL === 'string' ? ax.dataURL : '',
        });
      });
    }
    summary.push([
      v.no,
      v.type === 'B' ? '銀行' : v.type === 'T' ? '轉賬' : v.type,
      v.date,
      v.desc,
      dollars(dr as Cents),
      dollars(cr as Cents),
      v.madeBy || '',
      v.checkedBy || '',
      v.approvedBy || '',
      attCell,
    ]);
    v.lines.forEach((l, li) => {
      detail.push([
        v.no, v.date, li + 1, l.account, l.detail || '',
        l.debit ? dollars(l.debit) : '',
        l.credit ? dollars(l.credit) : '',
      ]);
    });
  });

  const fyLabel = fy.label.replace(/[^A-Za-z0-9\u4e00-\u9fa5-]/g, '-');
  const rangeLabel =
    fyLabel + (fromMonth || toMonth ? '_' + (fromMonth || '開始') + '至' + (toMonth || '最後') : '');

  return {
    summary, detail, links, attachments,
    voucherCount: vouchers.length,
    lineCount: detail.length - 1,
    rangeLabel,
  };
}
