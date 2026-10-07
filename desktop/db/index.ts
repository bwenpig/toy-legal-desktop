/**
 * Toys Gallery 會計系統桌面版 — SQLite 關聯式層（schema v2）公開入口。
 *
 * 用法（glue 層）：
 *   import { initDatabase, seedFresh, migrateFromPayload, persistPayload, loadPayload } from './db';
 *   const st = await initDatabase(port);
 *   if (st.isFresh) await seedFresh(port);
 *   else if (st.needsMigration) await migrateFromPayload(port, preparedPayload);
 */
export { SCHEMA_V2_SQL } from './schema.js';
export {
  initDatabase,
  seedFresh,
  migrateFromPayload,
  persistPayload,
  loadPayload,
} from './convert.js';
export type { DbPort, InitResult, TableCounts } from './convert.js';
