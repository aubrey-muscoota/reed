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
import { tickerMap, latestReports, filingUrl, riskFactors } from '../lib/sec.mjs';
import { chunk } from '../lib/text.mjs';

const { values: args } = parseArgs({
  options: {
    tickers: { type: 'string' },
    'max-chunks': { type: 'string', default: '2500' },
    'dry-run': { type: 'boolean', default: false },
    // Redo filings already indexed (after an extraction fix), replacing their passages.
    reindex: { type: 'boolean', default: false },
  },
});

const universe = JSON.parse(await readFile(new URL('../data/sp100.json', import.meta.url), 'utf8')).tickers;
const tickers = args.tickers ? args.tickers.split(',').map(t => t.trim().toUpperCase()) : universe;
const budget = Number(args['max-chunks']);
const dry = args['dry-run'];

const cf = dry ? null : cloudflare();
const db = dry ? null : openDb(cf, await d1Id(cf));
const rows = dry ? [] : await db.all('SELECT accession, ticker, form, chunks FROM filings');
const indexed = new Map(rows.map(r => [r.accession, r.chunks]));
// With --reindex, filings re-done in an earlier run since this date are skipped, so the job can resume.
const reindexedSince = args.reindex ? (process.env.REED_REINDEX_SINCE ?? new Date().toISOString().slice(0, 10)) : null;
const done = new Set(dry ? [] : (await db.all(
  reindexedSince ? 'SELECT accession FROM filings WHERE ingested_at >= ?' : 'SELECT accession FROM filings',
  reindexedSince ? [reindexedSince] : [],
)).map(r => r.accession));

const map = await tickerMap();
let embedded = 0;
const skipped = [];

outer: for (const ticker of tickers) {
  const entry = map.get(ticker);
  if (!entry) { skipped.push(`${ticker}: no CIK`); continue; }
  const filings = await latestReports(entry.cik);
  if (!filings.some(f => f.form === '10-K')) skipped.push(`${ticker}: no 10-K found`);
  for (const f of filings) {
    if (done.has(f.accession)) { if (!dry) await prune(ticker, f); continue; }
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
    const old = indexed.get(f.accession) ?? 0;
    if (old > 0) {
      const stale = Array.from({ length: old }, (_, i) => `${f.accession}-${i}`);
      for (let i = 0; i < stale.length; i += 100) await cf.vectorize.deleteByIds(CONFIG.index, stale.slice(i, i + 100)); // API limit: 100 ids per call
    }
    for (let i = 0; i < vectors.length; i += 200) await cf.vectorize.upsert(CONFIG.index, vectors.slice(i, i + 200));
    await db.all(
      'INSERT OR REPLACE INTO filings (accession, ticker, company, form, filed, url, chunks, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [f.accession, ticker, entry.company, f.form, f.filed, url, passages.length, new Date().toISOString()],
    );
    await prune(ticker, f);
    embedded += passages.length;
  }
}

// A newer filing of the same form replaces the older one: drop the older
// one's passages and row, so search only sees each company's latest reports.
async function prune(ticker, latest) {
  for (const r of rows.filter(r => r.ticker === ticker && r.form === latest.form && r.accession !== latest.accession)) {
    const ids = Array.from({ length: r.chunks }, (_, i) => `${r.accession}-${i}`);
    for (let i = 0; i < ids.length; i += 100) await cf.vectorize.deleteByIds(CONFIG.index, ids.slice(i, i + 100));
    await db.all('DELETE FROM filings WHERE accession = ?', [r.accession]);
    console.log(`Pruned ${ticker} ${r.form} ${r.accession} (${r.chunks} passages)`);
  }
}

console.log(`\nEmbedded ${embedded} passages${dry ? ' (dry run)' : ''}.`);
if (skipped.length) console.log(`Skipped:\n  ${skipped.join('\n  ')}`);
