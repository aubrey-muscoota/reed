// Index the Risk Factors section of each company's latest 10-K and 10-Q.
// Resumable: filings already in D1 are skipped. --max-chunks caps the
// passages embedded in one run, to stay inside the Workers AI daily allowance.
//
//   node scripts/ingest.mjs [--tickers AAPL,MSFT] [--max-chunks 2500] [--dry-run]

import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { cloudflare } from '../lib/cf.mjs';
import { CONFIG } from '../lib/config.mjs';
import { d1Id, db as openDb } from '../lib/db.mjs';
import { tickerMap, submissions, latestFilings, filingUrl, riskFactors } from '../lib/sec.mjs';
import { chunk } from '../lib/text.mjs';

const { values: args } = parseArgs({
  options: {
    tickers: { type: 'string' },
    'max-chunks': { type: 'string', default: '2500' },
    'dry-run': { type: 'boolean', default: false },
  },
});

const universe = JSON.parse(await readFile(new URL('../data/sp100.json', import.meta.url), 'utf8')).tickers;
const tickers = args.tickers ? args.tickers.split(',').map(t => t.trim().toUpperCase()) : universe;
const budget = Number(args['max-chunks']);
const dry = args['dry-run'];

const cf = dry ? null : cloudflare();
const db = dry ? null : openDb(cf, await d1Id(cf));
const done = new Set(dry ? [] : (await db.all('SELECT accession FROM filings')).map(r => r.accession));

const map = await tickerMap();
let embedded = 0;
const skipped = [];

outer: for (const ticker of tickers) {
  const entry = map.get(ticker);
  if (!entry) { skipped.push(`${ticker}: no CIK`); continue; }
  const filings = latestFilings(await submissions(entry.cik));
  for (const f of filings) {
    if (done.has(f.accession)) continue;
    const url = filingUrl(entry.cik, f);
    const text = await riskFactors(url);
    // 10-Qs often just point back to the 10-K; skip those stubs.
    if (text.length < (f.form === '10-K' ? 2000 : 600)) { skipped.push(`${ticker} ${f.form}: risk factors not found or short`); continue; }
    const passages = chunk(text);
    if (embedded + passages.length > budget) { console.log(`Budget reached before ${ticker} ${f.form}; run again tomorrow to continue.`); break outer; }
    console.log(`${ticker} ${f.form} ${f.filed}: ${passages.length} passages`);
    if (dry) { embedded += passages.length; continue; }

    const vectors = [];
    for (let i = 0; i < passages.length; i += 50) {
      const batch = passages.slice(i, i + 50);
      const embs = await cf.embed(CONFIG.embedModel, batch);
      embs.forEach((values, j) => vectors.push({
        id: `${f.accession}-${i + j}`,
        values,
        metadata: { ticker, company: entry.company, form: f.form, filed: f.filed, url, section: 'Item 1A. Risk Factors', text: batch[j] },
      }));
    }
    for (let i = 0; i < vectors.length; i += 200) await cf.vectorize.upsert(CONFIG.index, vectors.slice(i, i + 200));
    await db.all(
      'INSERT OR REPLACE INTO filings (accession, ticker, company, form, filed, url, chunks, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [f.accession, ticker, entry.company, f.form, f.filed, url, passages.length, new Date().toISOString()],
    );
    embedded += passages.length;
  }
}

console.log(`\nEmbedded ${embedded} passages${dry ? ' (dry run)' : ''}.`);
if (skipped.length) console.log(`Skipped:\n  ${skipped.join('\n  ')}`);
