// Daily run: pull new Federal Register actions, tag them, and write
// filings-backed exposure notes for the relevant ones.
//
//   node scripts/daily.mjs [--since 2026-11-01] [--max 8]

import { parseArgs } from 'node:util';
import { cloudflare } from '../lib/cf.mjs';
import { CONFIG } from '../lib/config.mjs';
import { d1Id, db as openDb } from '../lib/db.mjs';
import { recentEvents } from '../lib/fedreg.mjs';
import { tagEvent, retrieve, explain } from '../lib/pipeline.mjs';

const { values: args } = parseArgs({
  options: {
    since: { type: 'string' },
    max: { type: 'string', default: String(CONFIG.maxEventsPerDay) },
  },
});

const since = args.since ?? new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
const cf = cloudflare();
const db = openDb(cf, await d1Id(cf));

const events = await recentEvents(since);
// "Done" means tagged. Stored-but-untagged actions (over the cap, or a
// failed run) get picked up on the next run while still in the window.
const done = new Set((await db.all('SELECT id FROM events WHERE published >= ? AND processed_at IS NOT NULL', [since])).map(r => r.id));
const fresh = events.filter(e => !done.has(e.id));
console.log(`${events.length} actions since ${since}, ${fresh.length} not yet tagged`);

// Store every action seen, then tag up to --max.
for (const e of fresh) {
  await db.all('INSERT OR IGNORE INTO events (id, title, abstract, url, published, doc_type, agencies) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [e.id, e.title, e.abstract, e.url, e.published, e.doc_type, JSON.stringify(e.agencies)]);
}

// Presidential documents and trade agencies first; they are most often relevant.
const priority = e => (e.doc_type === 'Presidential Document' ? 0 : 1);
const queue = fresh.sort((a, b) => priority(a) - priority(b)).slice(0, Number(args.max));

for (const e of queue) {
  try {
    const tag = await tagEvent(cf, e);
    await db.all('UPDATE events SET category = ?, keywords = ?, relevant = ?, model = ?, processed_at = ? WHERE id = ?',
      [tag.category, JSON.stringify(tag.keywords), tag.relevant ? 1 : 0, CONFIG.model, new Date().toISOString(), e.id]);
    if (!tag.relevant) { console.log(`- ${e.id} not relevant: ${e.title}`); continue; }

    const passages = await retrieve(cf, e, tag, 'dense');
    const notes = await explain(cf, e, passages.slice(0, CONFIG.notePassages));
    for (const n of notes) {
      await db.all('INSERT OR REPLACE INTO notes (event_id, ticker, company, summary, citations, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [e.id, n.ticker, n.company, n.summary, JSON.stringify(n.citations), CONFIG.model, new Date().toISOString()]);
    }
    console.log(`+ ${e.id} [${tag.category}] ${notes.length} notes: ${e.title}`);
    for (const n of notes) console.log(`    ${n.ticker}: ${n.summary}`);
  } catch (err) {
    // Leave processed_at empty so the next run can retry this one.
    console.error(`! ${e.id} failed: ${err.message}`);
  }
}
