// Check an evaluation set against the filings themselves, with no model:
// for each event, which companies' latest 10-K Risk Factors mention the
// event's terms? Lists expected companies that do not (candidates to drop)
// and unexpected ones that do (candidates to add). A person makes the call.
//
//   node scripts/check-set.mjs [--set eval/events.draft.jsonl]

import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { tickerMap, submissions, latestFilings, filingUrl, riskFactors } from '../lib/sec.mjs';

const { values: args } = parseArgs({ options: { set: { type: 'string', default: 'eval/events.draft.jsonl' } } });
const events = (await readFile(args.set, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
const tickers = JSON.parse(await readFile(new URL('../data/sp100.json', import.meta.url), 'utf8')).tickers;

const map = await tickerMap();
const text = new Map();
for (const t of tickers) {
  const entry = map.get(t);
  if (!entry) continue;
  const [k] = latestFilings(await submissions(entry.cik), ['10-K']);
  if (!k) continue;
  try { text.set(t, (await riskFactors(filingUrl(entry.cik, k))).toLowerCase()); } catch (e) { console.error(`${t}: ${e.message}`); }
}

const out = [`# Evaluation set check\n\n${text.size} companies' 10-K Risk Factors searched.\n`];
// Short extractions usually mean the section was not found properly (a
// table-of-contents line, or risk factors kept in an exhibit).
const lengths = [...text].map(([t, b]) => [t, b.length]).sort((a, b) => a[1] - b[1]);
out.push(`Shortest extractions (characters): ${lengths.slice(0, 25).map(([t, n]) => `${t} ${n}`).join(', ')}\n`);
for (const t of ['NVDA', 'LLY', 'WFC', 'C', 'MS', 'INTC']) {
  const b = text.get(t) ?? '';
  out.push(`${t} starts: ${JSON.stringify(b.slice(0, 160))} ... ends: ${JSON.stringify(b.slice(-160))}\n`);
}
for (const e of events) {
  const res = (e.terms ?? []).map(s => new RegExp(s, 'g'));
  const hits = new Map();
  for (const [t, body] of text) {
    const n = res.reduce((sum, re) => sum + (body.match(re)?.length ?? 0), 0);
    if (n > 0) hits.set(t, n);
  }
  const fmt = t => `${t}(${hits.get(t) ?? 0})`;
  const missing = e.expected.filter(t => !hits.has(t));
  const extra = [...hits.keys()].filter(t => !e.expected.includes(t)).sort((a, b) => hits.get(b) - hits.get(a)).slice(0, 12);
  out.push(`## ${e.id} ${e.title}\n\nTerms: ${e.terms.join(' | ')}\n\n- Expected and mentioned: ${e.expected.filter(t => hits.has(t)).map(fmt).join(', ') || 'none'}\n- Expected, not mentioned: ${missing.join(', ') || 'none'}\n- Not expected, most mentions: ${extra.map(fmt).join(', ') || 'none'}\n`);
}
console.log(out.join('\n'));
