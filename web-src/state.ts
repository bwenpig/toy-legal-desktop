/**
 * 由 scripts/extract.js 自 v3.15 index.html 自動拆分。
 * 零功能變更：邏輯與原 IIFE 內文一致（全域狀態引用改為 store.*）。
 */
import type { Store } from './types';
import { currentFiscalStart } from './ui';
import { makeFiscalYear } from './core/fiscal';
import { dateInFiscalYear as coreDateInFiscalYear } from './core/fiscal';
import {
  openingEntry as coreOpeningEntry,
  openingInvoiceRows as coreOpeningInvoiceRows,
  accountHasFiscalActivity as coreAccountHasFiscalActivity,
  voucherDerivedInvoices as coreVoucherDerivedInvoices,
  invoiceMatches as coreInvoiceMatches,
} from './core/invoices';
import {
  allocatedTotal as coreAllocatedTotal,
  applyAllocation as coreApplyAllocation,
  openingInvoiceStatus as coreOpeningInvoiceStatus,
} from './core/allocation';
import type {
  Account,
  DrCr,
  AllocationReview,
  ARAPKind,
  CoreCtx,
  FiscalYear,
  InvoiceRow,
  OpeningEntry,
  OpeningInvoiceStatus,
  Voucher,
} from './types';
import type { Cents } from './money';
import { dollarsToCents } from './money';

/** 全域可變狀態（原 IIFE 頂層 let/const）。各模組經 `store.*` 讀寫。 */
export const store: Store = {
  fiscalYears: [makeFiscalYear(2023),makeFiscalYear(currentFiscalStart)].filter((fy,i,a)=>a.findIndex(x=>x.key===fy.key)===i).sort((a,b)=>b.start-a.start),
  selectedFiscalKey: String(currentFiscalStart),
  deleteFiscalCandidate: null,
  deleteFiscalStep: 1,
  deletedDataYears: new Set(),
  balanceAdjustments: {},
  openingBalances: {},
  openingInvoiceDetails: {},
  accounts: ([
    ['1000','Bank Saving Account','資產',15564.22,'dr'],['1010','Bank Current Account','資產',.9,'dr'],
    ['1101','Accounts Receivable of Toy Hunters','資產',100100,'dr'],['1102','Accounts Receivable of Animation International Limited','資產',13000,'dr'],['1103','Accounts Receivable of SDD Marketing & Consultary Limited','資產',9295,'dr'],['1104','Accounts Receivable of Kidsland LCS Limited','資產',22530,'dr'],['1105','Accounts Receivable of Tran Kevin','資產',2760,'dr'],['1106','Accounts Receivable of Sim Wee Lun','資產',2028,'dr'],['1107','Accounts Receivable of Edwin','資產',2136,'dr'],['1108','Accounts Receivable of Amaz Co Ltd','資產',4564,'dr'],['1109','Accounts Receivable of Gift Field Ltd','資產',15960,'dr'],['1110','Accounts Receivable of Kenneth','資產',2072,'dr'],['1111','Accounts Receivable of 劉志偉','資產',10000,'dr'],['1112','Accounts Receivable of 王丞漢','資產',2480,'dr'],['1113','Accounts Receivable of 上原(澳門)有限公司','資產',11088,'dr'],['1114','Accounts Receivable of Toys Wonderland Ltd','資產',5208,'dr'],['1115','Accounts Receivable of Big Box International Pte Ltd','資產',21300,'dr'],
    ['2050','Temporary Receivable','負債',21390,'cr'],['1300','Closing Stock','資產',555138.41,'dr'],['1500','Furniture and Equipment','資產',22881,'dr'],['1510','Moulds','資產',57000,'dr'],
    ['2000','Accounts Payable of Wingo Creative Co Ltd','負債',365893.4,'cr'],['2010','Accrued Expenses','負債',142300,'cr'],['2100','Current Account of Lam Hon Fai','負債',176488.5,'cr'],['2201','Loan of Hong Kong Enterprise Association Limited','負債',220000,'cr'],['2202','Loan of Hong Kong Safety Service Ltd','負債',430000,'cr'],['2203','Loan of Hong Kong Fiduciary Association Ltd','負債',200000,'cr'],
    ['1400','Suspense Account — source workbook difference','資產',99520,'dr'],['3000','Capital of Lam Hon Fai','權益',100,'cr'],['3100','Profit and Loss account','資產',689742.57,'dr'],
    ['4000','Sales','收入',1110070.26,'cr'],['4010','Bank Interest','收入',571.98,'cr'],['4020','Sundry Income','收入',1291.18,'cr'],
    ['5000','Opening Stock','成本',54144.83,'dr'],['5010','Purchases','成本',919497.21,'dr'],['5020','Closing Stock Adjustment','成本',555138.41,'cr'],
    ['6000','Advertising Fee','費用',77887.8,'dr'],['6010','Rent','費用',137500,'dr'],['6020','Bank Charges','費用',2502.53,'dr'],['6030','Toys Membership Fee','費用',9666.7,'dr'],['6040','Sundry Expenses','費用',22692.96,'dr'],['6050','Business Trip','費用',56304.34,'dr'],['6060','Discount allowance','費用',1104,'dr'],['6070','Salary and allowance','費用',686000,'dr'],['6080','I Cloud fee','費用',4803.25,'dr'],['6090','Booth Fee','費用',96640,'dr'],['6100','Printing and Stationary','費用',5187,'dr'],['6110','Insurance','費用',4500,'dr'],['6120','Business Registration','費用',2150,'dr'],['6130','Transportation Fee','費用',10590.2,'dr'],['6140','Entertainment','費用',5662,'dr'],['6150','Website Fee','費用',1016,'dr'],['6160','Secretary Fee','費用',1650,'dr'],['6170','Courier Fee','費用',12646.26,'dr'],['1520','Prototype','資產',0,'dr'],['1590','Accumulated Depreciation','資產',0,'cr'],['6190','Copy Right','費用',80943.12,'dr'],['6200','MPF','費用',12750,'dr']
  ] as [string, string, string, number, string][]).map((a): Account=>({code:a[0],name:a[1],type:a[2],balance:dollarsToCents(a[3]),importedBalance:dollarsToCents(a[3]),side:a[4] as DrCr})),
  salesInvoices: ([
    ['2023-04-12','INV2023040017','Toy Hunters',2820],['2023-04-24','INV2023040018','Alpha-C Group Ltd',27010],['2023-04-24','INV2023040019','DoraFansHK Ltd',7920],['2023-04-24','INV2023040020','DoraFansHK Ltd',3090],['2023-04-24','INV2023040021','SDD Marketing & Consultancy Ltd',5759],['2023-04-24','INV2023040022','DoraFansHK Ltd',18774],['2023-04-24','INV2023040023','DoraFansHK Ltd',8459],
    ['2023-05-05','INV2023050024','Toy Hunters',5640],['2023-05-25','INV2023050025','Kidsland LCS Limited',2370],['2023-05-29','INV2023050026','Contemp Consultant Limited',13888],['2023-06-12','INV2023060028','DoraFansHK Ltd',1470],['2023-07-06','INV2023070029','Lofty Limited',1185],['2023-07-06','INV2023070030','Lofty Limited',1185],['2023-07-06','INV2023070031','Lofty Limited',2370],['2023-07-12','INV2023070032','DoraFansHK Ltd',2704],['2023-07-12','INV2023070033','SweetyMagic Limited',16520],['2023-07-12','INV2023070034','Contemp Consultant Limited',18581.4],
    ['2023-08-01','INV2023080035','Tran Kevin',2760],['2023-08-05','INV2023080036','Zebra Toys Limited',108602],['2023-08-10','INV2023080037','Kidsland LCS Limited',6210],['2023-08-10','INV2023080038','Kidsland LCS Limited',4674],['2023-08-14','INV2023080039','Lofty Limited',2037.75],['2023-08-29','INV2023080040','Sim Wee Lun',780],['2023-08-29','INV2023080041','Zebra Toys Limited',15600],['2023-08-29','INV2023080043','SDD Marketing & Consultancy Ltd',4550],['2023-08-29','INV2023080044','SDD Marketing & Consultancy Ltd',962],['2023-08-30','INV2023080045','Edwin',948],['2023-08-30','INV2023080046','Edwin',1188],
    ['2023-09-06','INV2023090047','Sim Wee Lun',1248],['2023-09-24','INV2023090048','Animation International Ltd',9388.4],['2023-09-14','INV2023090049','SDD Marketing & Consultancy Ltd',4810],['2023-09-14','INV2023090050','DoraFansHK Ltd',8264],['2023-09-14','INV2023090051','DoraFansHK Ltd',8030],['2023-09-21','INV2023090052','東敏實業有限公司',41940],['2023-09-28','INV2023090053','Kidsland LCS Limited',6210],
    ['2023-10-16','INV2023100054','Kidsland LCS Limited',3765],['2023-10-16','INV2023100055','Kidsland LCS Limited',5835],['2023-10-16','INV2023100056','Kidsland LCS Limited',4350],['2023-10-20','INV2023100057','SDD Marketing & Consultancy Ltd',247],['2023-10-25','INV2023100058','Amaz Co Ltd',16520],['2023-10-25','INV2023100059','Amaz Co Ltd',6216],['2023-10-27','INV2023100060','Gift Field Limited',15960],['2023-10-27','INV2023100061','Kenneth',2072],
    ['2023-11-06','INV2023110062','Amaz Co Ltd',1316],['2023-11-09','INV2023110063','Toy Hunters',14072],['2023-11-09','INV2023110064','劉志偉',10000],['2023-11-08','INV2023110065','Lofty Limited',2370],['2023-11-08','INV2023110066','Lofty Limited',2151],['2023-11-20','INV2023110067','Toy Hunters',22668],['2023-11-20','INV2023110068','王丞漢',2480],
    ['2023-12-08','INV2023120070','SDD Marketing & Consultancy Ltd',2184],['2023-12-14','INV2023120071','上原(澳門)有限公司',20580],['2023-12-14','INV2023120072','Ocean Trading Co',19880],
    ['2024-01-02','INV2024010001','馬高斯',3960],['2024-01-11','INV2024010002','SDD Marketing & Consultancy Ltd',1768],['2024-01-11','INV2024010003','Amaz Co Ltd',4564],['2024-01-11','INV2024010004','上原(澳門)有限公司',11088],['2024-01-15','INV2024010005','Lofty Limited',2930.4],['2024-01-19','INV2024010006','SDD Marketing & Consultancy Ltd',1768],['2024-01-30','INV2024010007','Toy Hunters',10680],
    ['2024-02-06','INV2024020008','SDD Marketing & Consultancy Ltd',117],['2024-02-16','INV2024020009','TOCA LOCA Limited',7072],['2024-02-16','INV2024020010','Ocean Trading Co',25020],['2024-02-16','INV2024020011','Amaz Co Ltd',12544],['2024-02-16','INV2024020012','Toys Wonderland Limited',5208],['2024-02-16','INV2024020013','Kenneth Feng',2072],['2024-02-19','INV2024020014','Toy Hunters',6150],['2024-02-27','INV2024020015','SDD Marketing & Consultancy Ltd',2509],
    ['2024-03-05','INV2024020016','Winner Concept International Ltd',1222],['2024-03-07','INV2023020020','TOCA LOCA Limited',11843],['2024-03-07','INV2024010021','Lofty Limited',6453],['2024-03-15','INV2024030022','Big Box International Pte Ltd',17540],['2024-03-15','INV2024030023','Big Box International Pte Ltd',3760]
  ] as [string, string, string, number][]).map((r): InvoiceRow=>[r[0],r[1],r[2],dollarsToCents(r[3])]),
  purchaseInvoices: ([['2023-06-27','WMI-23-T015','Wingo Creative Co Limited',5822],['2023-06-27','WMI-23-T016','Wingo Creative Co Limited',8998],['2023-07-31','WMI-23-T017','Wingo Creative Co Limited',102095],['2023-06-27','WMI-23-T018','Wingo Creative Co Limited',50948],['2023-09-01','—','Takumi Iwase',23611.03],['2023-09-13','WMI-23-T019','Wingo Creative Co Limited',320864],['2023-09-13','WMI-23-T020','Wingo Creative Co Limited',142730.3],['2023-09-13','WMI-23-T021','Wingo Creative Co Limited',73625.3],['2023-09-13','WMI-23-T023','Wingo Creative Co Limited',41137.8],['2023-10-26','WMI-23-T024','Wingo Creative Co Limited',108400],['2024-02-19','—','Adore Marketing',41244.78]] as [string, string, string, number][]).map((r): InvoiceRow=>[r[0],r[1],r[2],dollarsToCents(r[3])]),
  invoiceRemarks: {"INV2023040018":"paid on Apr 2023","INV2023040019":"paid on Apr 2023","INV2023040020":"paid on Apr 2023","INV2023040021":"paid on Jun 2023","INV2023040022":"paid on May 2023","INV2023040023":"paid on May 2023","INV2023050026":"paid on Jun 2023","INV2023060028":"paid on Jun 2023","INV2023070029":"paid on Jul 2023","INV2023070030":"paid on Jul 2023","INV2023070031":"paid on Jul 2023","INV2023070032":"paid on Jul 2023","INV2023070033":"paid on Jul 2023","INV2023070034":"paid on Jul 2023","INV2023080036":"paid on Aug 2023","INV2023080037":"paid on Oct 2023","INV2023080038":"paid on Oct 2023","INV2023080039":"paid on Jan 2024","INV2023080041":"paid on Aug 2023","INV2023080043":"paid on Sep 2023","INV2023080044":"paid on Sep 2023","INV2023090048":"paid on Feb 2024","INV2023090049":"paid on Sep 2023","INV2023090050":"paid on Sep 2023","INV2023090051":"paid on Sep 2023","INV2023090052":"paid on Nov 2023","INV2023100058":"paid on Nov 2023","INV2023100059":"paid on Nov 2023","INV2023100061":"paid on Nov 2023","INV2023110062":"paid on Dec 2023","INV2023110065":"paid on Jan 2024","INV2023110066":"paid on Jan 2024","INV2023120070":"paid on Dec 2023","INV2023120071":"paid on Dec 2023","INV2023120072":"paid on Jan 2024","INV2024010001":"paid on Jan 2024","INV2024010005":"paid on Jan 2024","INV2024020008":"paid on Feb 2024","INV2024020009":"paid on Feb 2024","INV2024020010":"paid on Feb 2024","INV2024020011":"paid on Mar 2024","INV2024020015":"paid on Feb 2024","INV2024020016":"paid on Mar 2024","INV2023020020":"paid on Mar 2024","INV2024010021":"paid on Mar 2024","WMI-23-T015":"RM5370","WMI-23-T016":"RM8300","WMI-23-T017":"RM94183","WMI-23-T018":"RM47000","WMI-23-T019":"RM296000","WMI-23-T020":"RM131670","WMI-23-T021":"RM67920","WMI-23-T023":"RM37950","WMI-23-T024":"RM100000"},
  allocations: [],
  allocationReview: [],
  vouchers: [
    {no:'B091423',type:'B',date:'2023-09-22',desc:'Lam Hon Fai transfer to saving account',allocationInvoice:'',madeBy:'',checkedBy:'',approvedBy:'',attachments:[],lines:[{account:'Current Account of Lam Hon Fai',detail:'Transfer to saving account',debit:142800 as Cents as Cents,credit:0 as Cents},{account:'Bank Saving Account',detail:'Transfer from director current account',debit:0 as Cents,credit:142800 as Cents as Cents}]},
    {no:'T100223',type:'T',date:'2023-10-31',desc:'Lunch & Dinner with client & tissue, tea bag, cleaning tools for office',allocationInvoice:'',madeBy:'',checkedBy:'',approvedBy:'',attachments:[],lines:[{account:'Entertainment',detail:'Office and client expenses',debit:717650 as Cents as Cents,credit:0 as Cents},{account:'Current Account of Lam Hon Fai',detail:'Paid by director',debit:0 as Cents,credit:717650 as Cents as Cents}]}
  ],
  currentType: 'B',
  rows: [],
  report: 'trial',
  editingIndex: null,
  numberManuallyEdited: false,
  currentAttachments: [],
  lastVoucherDates: {},
  staffNames: new Set(),
  suppressedStaffNames: new Set(),
  reportState: {month:null,date:'',nameQuery:'',invoiceQuery:''},
  reconciliationConfirmations: {},
  reconciliationContext: null,
  reconcileInvoiceDraft: [],
  reconcilePaymentDraft: [],
  editingAccount: null,
  accountEditStep: 1,
  deletingAccount: null,
  deleteAccountStep: 1,
  deleteAccountUsage: [],
  openingInvoiceAccount: '',
  openingInvoiceDraft: [],
  pendingRestore: null,
  restoreStep: 1,
};

/** 目前選擇的財年 */
export function selectedFiscalYear(): FiscalYear {
  return store.fiscalYears.find((fy) => fy.key === store.selectedFiscalKey) || store.fiscalYears[0];
}

/** 給 core 純函數用的 ctx（由 store 組裝） */
export function ctx(): CoreCtx {
  return {
    vouchers: store.vouchers,
    accounts: store.accounts,
    salesInvoices: store.salesInvoices,
    purchaseInvoices: store.purchaseInvoices,
    openingBalances: store.openingBalances,
    openingInvoiceDetails: store.openingInvoiceDetails,
    deletedDataYears: store.deletedDataYears,
    allocations: store.allocations,
  };
}

// ---- adapters：與原版同簽名，委託已測試的 core 純函數 ----
export function dateInFiscalYear(date: string, fy: FiscalYear = selectedFiscalYear()): boolean {
  return coreDateInFiscalYear(date, fy);
}
export function openingEntry(fy: FiscalYear, name: string): OpeningEntry {
  return coreOpeningEntry(fy, name, store.openingBalances);
}
export function openingInvoiceRows(
  kind: ARAPKind, party: string, fy: FiscalYear = selectedFiscalYear(),
): InvoiceRow[] {
  return coreOpeningInvoiceRows(kind, party, fy, ctx());
}
export function openingInvoiceStatus(
  accountName: string, fy: FiscalYear = selectedFiscalYear(), expected: Cents | null = null,
): OpeningInvoiceStatus {
  return coreOpeningInvoiceStatus(accountName, fy, ctx(), expected);
}
export function accountHasFiscalActivity(
  account: Account | undefined, fy: FiscalYear = selectedFiscalYear(),
): boolean {
  return coreAccountHasFiscalActivity(account, fy, ctx());
}
export function voucherDerivedInvoices(
  kind: ARAPKind, fy: FiscalYear = selectedFiscalYear(),
): InvoiceRow[] {
  return coreVoucherDerivedInvoices(kind, fy, ctx());
}
export function invoiceMatches(
  kind: ARAPKind, party: string, fy: FiscalYear = selectedFiscalYear(),
): InvoiceRow[] {
  return coreInvoiceMatches(kind, party, fy, ctx());
}
export function allocatedTotal(
  kind: ARAPKind, invoiceNo: string, fy: FiscalYear = selectedFiscalYear(),
): Cents {
  return coreAllocatedTotal(kind, invoiceNo, fy, store.allocations);
}
export function applyAllocation(v: Voucher): boolean {
  const { newAllocations, reviews, needsReview } = coreApplyAllocation(v, ctx());
  store.allocations.push(...newAllocations);
  const revs: AllocationReview[] = reviews;
  store.allocationReview.push(...revs);
  return needsReview;
}
