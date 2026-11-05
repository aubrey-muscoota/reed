// Compare models and retrieval setups on a hand-checked event set.
//
//   node scripts/eval.mjs [--set eval/events.jsonl] [--models a,b] [--limit 5]
//
// For each event:
//   tagging   - does the model's category match the expected one?
//   retrieval - share of expected companies found in the top 10 passages,
//               dense search alone versus dense plus keyword rerank
//   notes     - share of notes about an expected company (precision), and
//               share a separate judge model says the cited text supports
//
// Writes out/eval-results.json and out/eval-report.md.

import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { cloudflare, parseJson } from '../lib/cf.mjs';
import { CONFIG } from '../lib/config.mjs';
import { tagEvent, retrieveDense, retrieveDiverse, rerankHybrid, explain, checkSpecific } from '../lib/pipeline.mjs';

const { values: args } = parseArgs({
  options: {
    set: { type: 'string', default: 'eval/events.jsonl' },
    models: { type: 'string' },
    modes: { type: 'string', default: 'dense,hybrid,diverse' },
    limit: { type: 'string' },
  },
});

const events = (await readFile(args.set, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l)).slice(0, args.limit ? Number(args.limit) : undefined);
const models = args.models ? args.models.split(',') : CONFIG.evalModels;
const K = 10;
const modes = args.modes.split(',');
const byId = new Map(events.map(e => [e.id, e]));
const cf = cloudflare();

function recallAt(passages, expected, k = K) {
  const found = new Set(passages.slice(0, k).map(p => p.ticker));
  return expected.length ? expected.filter(t => found.has(t)).length / expected.length : 0;
}

async function judge(note) {
  const prompt = `Does the quoted filing text support the summary? Answer with JSON only: {"supported": true or false}

Summary: ${note.summary}

Filing text:
${note.citations.map(c => c.text).join('\n---\n')}`;
  try { return parseJson(await cf.chat(CONFIG.judgeModel, [{ role: 'user', content: prompt }])).supported === true; }
  catch { return false; }
}

const rows = [];
for (const e of events) {
  // Each model's own tag feeds its retrieval, so tagging mistakes carry
  // through, as they would in the daily run.
  for (const model of models) {
    const row = { event: e.id, model };
    try {
      const tag = await tagEvent(cf, e, model);
      row.tagCorrect = tag.category === e.category;
      const dense = await retrieveDense(cf, e, tag);
      const runs = {
        dense: () => dense,
        hybrid: () => rerankHybrid(dense, e, tag),
        // Diverse candidates, then the same keyword rerank as hybrid.
        diverse: async () => rerankHybrid(await retrieveDiverse(cf, e, tag), e, tag),
      };
      for (const mode of modes) {
        const passages = await runs[mode]();
        const top = passages.slice(0, K);
        const notes = await explain(cf, e, top, model);
        const supported = [];
        for (const n of notes) supported.push(await judge(n));
        // The live site only publishes notes that pass the specificity check.
        const kept = await checkSpecific(cf, e, notes);
        const precision = list => (list.length ? list.filter(n => e.expected.includes(n.ticker)).length / list.length : null);
        row[mode] = {
          recall: recallAt(passages, e.expected),
          notes: notes.length,
          precision: precision(notes),
          supported: notes.length ? supported.filter(Boolean).length / notes.length : null,
          published: kept.length,
          publishedPrecision: precision(kept),
          tickers: notes.map(n => n.ticker),
          publishedTickers: kept.map(n => n.ticker),
        };
      }
    } catch (err) {
      row.error = err.message;
    }
    rows.push(row);
    console.log(JSON.stringify(row));
  }
}

const mean = xs => { const v = xs.filter(x => typeof x === 'number'); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const pct = x => (x == null ? 'n/a' : `${Math.round(x * 100)}%`);
const summary = [];
for (const model of models) {
  const mine = rows.filter(r => r.model === model && !r.error);
  for (const mode of modes) {
    summary.push({
      model, mode, events: mine.length,
      tagAccuracy: mean(mine.map(r => (r.tagCorrect ? 1 : 0))),
      // Expected company and event pairs that got a published note.
      pairsFound: mine.reduce((n, r) => n + new Set(r[mode].publishedTickers.filter(t => byId.get(r.event).expected.includes(t))).size, 0),
      pairs: mine.reduce((n, r) => n + byId.get(r.event).expected.length, 0),
      recallAt10: mean(mine.map(r => r[mode].recall)),
      notePrecision: mean(mine.map(r => r[mode].precision)),
      supported: mean(mine.map(r => r[mode].supported)),
      publishedPrecision: mean(mine.map(r => r[mode].publishedPrecision)),
      publishedPerEvent: mean(mine.map(r => r[mode].published)),
    });
  }
}

await mkdir('out', { recursive: true });
await writeFile('out/eval-results.json', JSON.stringify({ ranAt: new Date().toISOString(), set: args.set, judge: CONFIG.judgeModel, summary, rows }, null, 2));
const table = [
  '| Model | Retrieval | Events | Tag accuracy | Recall@10 | Note precision | Supported by cited text | Published per event | Published precision | Pairs found |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...summary.map(s => `| ${s.model} | ${s.mode} | ${s.events} | ${pct(s.tagAccuracy)} | ${pct(s.recallAt10)} | ${pct(s.notePrecision)} | ${pct(s.supported)} | ${s.publishedPerEvent == null ? 'n/a' : s.publishedPerEvent.toFixed(1)} | ${pct(s.publishedPrecision)} | ${s.pairsFound} of ${s.pairs} |`),
].join('\n');
await writeFile('out/eval-report.md', `# Reed evaluation\n\nRun ${new Date().toISOString().slice(0, 10)} on ${events.length} events from ${args.set}. Judge model: ${CONFIG.judgeModel}.\n\n${table}\n\nErrors: ${rows.filter(r => r.error).length}\n`);
console.log(`\n${table}`);
