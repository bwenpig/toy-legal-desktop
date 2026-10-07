/**
 * 客戶／供應商名稱正規化 —— 純函數。
 * 由 lib/party.js 直轉，邏輯一字不改。
 *
 * 注意實際行為（已由 golden test 鎖住）：
 *   normalParty('ToCa LoCo')         === 'tocalo'
 *   normalParty('TOCA LOCA Limited') === 'tocaloca'
 * 即兩者在 invoiceMatches 的模糊匹配下會視為同一客戶；
 * 財年隔離（而非改名）才是正解，故保留此行為。
 */
export function normalParty(s: unknown): string {
  return String(s)
    .toLowerCase()
    .replace(/consultancy/g, 'consultary')
    .replace(/limited|ltd|company|co/g, '')
    .replace(/[^a-z0-9\u3400-\u9fff]/g, '');
}
