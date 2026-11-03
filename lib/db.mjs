// Find the D1 database id by name so scripts need no hard-coded id.
import { CONFIG } from './config.mjs';

export async function d1Id(cf) {
  const list = await cf.d1.list(CONFIG.d1Name);
  const db = (list ?? []).find(d => d.name === CONFIG.d1Name);
  if (!db) throw new Error(`D1 database "${CONFIG.d1Name}" not found; run npm run setup first`);
  return db.uuid;
}

export function db(cf, id) {
  return { all: (sql, params) => cf.d1.query(id, sql, params) };
}
