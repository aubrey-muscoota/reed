// Print the latest events and their notes as Markdown, for checking note
// quality without opening the site.
//
//   node scripts/report.mjs [--limit 10]

import { parseArgs } from 'node:util';
import { cloudflare } from '../lib/cf.mjs';
import { d1Id, db as openDb } from '../lib/db.mjs';

const { values: args } = parseArgs({ options: { limit: { type: 'string', default: '10' } } });
const cf = cloudflare();
const db = openDb(cf, await d1Id(cf));

const [{ filings }] = await db.all('SELECT COUNT(*) AS filings FROM filings');
const [{ passages }] = await db.all('SELECT COALESCE(SUM(chunks), 0) AS passages FROM filings');
const events = await db.all('SELECT id, title, published, category, relevant FROM events WHERE processed_at IS NOT NULL ORDER BY processed_at DESC LIMIT ?', [Number(args.limit)]);

const out = [`# Reed report\n\n${filings} filings, ${passages} passages indexed.\n`];
for (const e of events) {
  out.push(`## ${e.title}\n\n${e.published} · ${e.category} · ${e.relevant ? 'relevant' : 'not relevant'} · ${e.id}\n`);
  for (const n of await db.all('SELECT ticker, summary, citations FROM notes WHERE event_id = ? ORDER BY ticker', [e.id])) {
    const cites = JSON.parse(n.citations);
    out.push(`- **${n.ticker}**: ${n.summary}`);
    for (const c of cites) out.push(`  > ${c.text.slice(0, 300).replace(/\s+/g, ' ')}...`);
  }
  out.push('');
}
console.log(out.join('\n'));
