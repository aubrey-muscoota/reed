// Summarize an eval results file with 95% bootstrap intervals, resampling
// events. Prints a Markdown table per model and search mode, and paired
// differences between search modes for each model.
//
//   node scripts/analyze-eval.mjs eval/results/2026-11-05.jsonl [eval/events.jsonl]

import { readFileSync } from 'node:fs';

const [resultsPath, setPath = 'eval/events.jsonl'] = process.argv.slice(2);
const rows = readFileSync(resultsPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const byId = new Map(readFileSync(setPath, 'utf8').trim().split('\n').map(l => JSON.parse(l)).map(e => [e.id, e]));
const B = 2000;

// Small seeded generator so reruns give the same intervals.
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

const mean = xs => { const v = xs.filter(x => typeof x === 'number'); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
function interval(items, stat) {
  const draws = [];
  for (let b = 0; b < B; b++) {
    const s = stat(items.map(() => items[Math.floor(rand() * items.length)]));
    if (s != null) draws.push(s);
  }
  draws.sort((a, b) => a - b);
  return [draws[Math.floor(0.025 * draws.length)], draws[Math.floor(0.975 * draws.length)]];
}

// Per event: share of expected companies with a published note.
const pairRate = (r, mode) => {
  const exp = byId.get(r.event).expected;
  return new Set(r[mode].publishedTickers.filter(t => exp.includes(t))).size / exp.length;
};
const METRICS = {
  recall: (rs, m) => mean(rs.map(r => r[m].recall)),
  pairs: (rs, m) => mean(rs.map(r => pairRate(r, m))),
  precision: (rs, m) => mean(rs.map(r => r[m].publishedPrecision)),
  published: (rs, m) => mean(rs.map(r => r[m].published)),
  supported: (rs, m) => mean(rs.map(r => r[m].supported)),
};

const models = [...new Set(rows.map(r => r.model))];
const modes = ['dense', 'hybrid', 'diverse'].filter(m => rows.some(r => r[m]));
const fmt = (x, pct = true) => (x == null ? 'n/a' : pct ? `${Math.round(100 * x)}` : x.toFixed(1));
const ci = ([lo, hi], pct = true) => `${fmt(lo, pct)}–${fmt(hi, pct)}`;

const out = [];
out.push(`Results: ${resultsPath}. ${new Set(rows.map(r => r.event)).size} events. Bootstrap ${B} resamples of events.\n`);
out.push('| Model | Search | Events | Errors | Tag acc. | Recall@10 (95% CI) | Pairs found % (95% CI) | Pairs found | Published/event | Precision % (95% CI) | Supported % |');
out.push('|---|---|---|---|---|---|---|---|---|---|---|');
const json = [];
for (const model of models) {
  const all = rows.filter(r => r.model === model);
  const ok = all.filter(r => !r.error);
  for (const m of modes) {
    const found = ok.reduce((n, r) => n + new Set(r[m].publishedTickers.filter(t => byId.get(r.event).expected.includes(t))).size, 0);
    const pairs = ok.reduce((n, r) => n + byId.get(r.event).expected.length, 0);
    const s = Object.fromEntries(Object.entries(METRICS).map(([k, f]) => [k, f(ok, m)]));
    const c = Object.fromEntries(['recall', 'pairs', 'precision'].map(k => [k, interval(ok, rs => METRICS[k](rs, m))]));
    json.push({ model, mode: m, events: ok.length, errors: all.length - ok.length, tag: mean(ok.map(r => (r.tagCorrect ? 1 : 0))), found, pairTotal: pairs, ...s, ci: c });
    out.push(`| ${model.split('/').pop()} | ${m} | ${ok.length} | ${all.length - ok.length} | ${fmt(mean(ok.map(r => (r.tagCorrect ? 1 : 0))))} | ${fmt(s.recall)} (${ci(c.recall)}) | ${fmt(s.pairs)} (${ci(c.pairs)}) | ${found} of ${pairs} | ${fmt(s.published, false)} | ${fmt(s.precision)} (${ci(c.precision)}) | ${fmt(s.supported)} |`);
  }
}

out.push('\nPaired differences in recall@10 and pairs found, percentage points (95% CI), vs dense:\n');
out.push('| Model | Search | Δ recall@10 | Δ pairs found |');
out.push('|---|---|---|---|');
for (const model of models) {
  const ok = rows.filter(r => r.model === model && !r.error);
  for (const m of modes.filter(m => m !== 'dense')) {
    const d = (rs, k) => mean(rs.map(r => (k === 'recall' ? r[m].recall - r.dense.recall : pairRate(r, m) - pairRate(r, 'dense'))));
    const pp = x => `${x >= 0 ? '+' : ''}${Math.round(100 * x)}`;
    const [rl, rh] = interval(ok, rs => d(rs, 'recall'));
    const [pl, ph] = interval(ok, rs => d(rs, 'pairs'));
    out.push(`| ${model.split('/').pop()} | ${m} | ${pp(d(ok, 'recall'))} (${pp(rl)} to ${pp(rh)}) | ${pp(d(ok, 'pairs'))} (${pp(pl)} to ${pp(ph)}) |`);
  }
}
console.log(out.join('\n'));
if (process.env.JSON) console.log(JSON.stringify(json));
