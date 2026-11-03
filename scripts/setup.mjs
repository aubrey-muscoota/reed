// Create the D1 database and Vectorize index if they do not exist, then
// write the database id into wrangler.jsonc so `wrangler deploy` can bind it.
// Safe to run on every deploy.
import { readFile, writeFile } from 'node:fs/promises';
import { cloudflare } from '../lib/cf.mjs';
import { CONFIG } from '../lib/config.mjs';

const cf = cloudflare();

let db = (await cf.d1.list(CONFIG.d1Name) ?? []).find(d => d.name === CONFIG.d1Name);
if (!db) {
  db = await cf.d1.create(CONFIG.d1Name);
  console.log(`Created D1 database ${CONFIG.d1Name}`);
}
console.log(`D1 ${CONFIG.d1Name}: ${db.uuid}`);

try {
  await cf.vectorize.get(CONFIG.index);
  console.log(`Vectorize index ${CONFIG.index} exists`);
} catch (e) {
  if (e.status !== 404 && e.status !== 410 && e.status !== 400) throw e;
  await cf.vectorize.create(CONFIG.index, CONFIG.dimensions);
  console.log(`Created Vectorize index ${CONFIG.index}`);
}

const path = new URL('../wrangler.jsonc', import.meta.url);
const text = await readFile(path, 'utf8');
await writeFile(path, text.replace(/"database_id":\s*"[^"]*"/, `"database_id": "${db.uuid}"`));
