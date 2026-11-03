import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateNotes, rerankHybrid } from '../lib/pipeline.mjs';
import { parseJson } from '../lib/cf.mjs';
import { latestFilings, filingUrl } from '../lib/sec.mjs';

const passages = [
  { id: 'a-0', ticker: 'NVDA', company: 'NVIDIA', form: '10-K', filed: '2026-02-20', url: 'u1', section: 'Item 1A', text: 'export controls on data center chips to China', score: 0.8 },
  { id: 'b-0', ticker: 'AAPL', company: 'Apple', form: '10-K', filed: '2025-10-31', url: 'u2', section: 'Item 1A', text: 'supply chain in China', score: 0.82 },
];

test('validateNotes keeps cited notes for the right company', () => {
  const out = validateNotes([{ ticker: 'nvda', summary: 'NVIDIA says export controls limit China sales.', cites: [1] }], passages);
  assert.equal(out.length, 1);
  assert.equal(out[0].ticker, 'NVDA');
  assert.equal(out[0].citations[0].url, 'u1');
});

test('validateNotes drops notes with no, missing, or mismatched citations', () => {
  const out = validateNotes([
    { ticker: 'NVDA', summary: 'x', cites: [] },
    { ticker: 'NVDA', summary: 'x', cites: [9] },
    { ticker: 'NVDA', summary: 'x', cites: [2] },
    { ticker: 'AAPL', summary: 'x', cites: [1, 2] },
  ], passages);
  assert.equal(out.length, 0);
});

test('validateNotes drops trade-call language', () => {
  const out = validateNotes([{ ticker: 'NVDA', summary: 'Investors should sell NVIDIA.', cites: [1] }], passages);
  assert.equal(out.length, 0);
});

test('rerankHybrid lifts passages that share the event keywords', () => {
  const out = rerankHybrid(passages, { title: 'Export controls on chips' }, { keywords: ['export controls', 'data center'] });
  assert.equal(out[0].ticker, 'NVDA');
});

test('parseJson reads JSON wrapped in prose or code fences', () => {
  assert.deepEqual(parseJson('Sure:\n```json\n{"a": [1, {"b": "}"}]}\n```'), { a: [1, { b: '}' }] });
});

test('latestFilings picks the newest 10-K and 10-Q and builds the archive URL', () => {
  const sub = { filings: { recent: {
    form: ['8-K', '10-Q', '10-K', '10-Q'],
    accessionNumber: ['1', '0000320193-26-000010', '0000320193-25-000079', '3'],
    filingDate: ['2026-01-30', '2026-01-30', '2025-10-31', '2025-08-01'],
    reportDate: ['', '2025-12-27', '2025-09-27', ''],
    primaryDocument: ['x.htm', 'aapl-20251227.htm', 'aapl-20250927.htm', 'y.htm'],
  } } };
  const [k, q] = latestFilings(sub);
  assert.equal(k.form, '10-K');
  assert.equal(q.accession, '0000320193-26-000010');
  assert.equal(filingUrl(320193, k), 'https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/aapl-20250927.htm');
});

import { isRoutine } from '../lib/pipeline.mjs';

test('isRoutine skips trade-remedy and procedural notices, keeps real actions', () => {
  assert.ok(isRoutine({ title: "Truck Bed Covers From the People's Republic of China: Amended Preliminary Determination of the Less-Than-Fair-Value Investigation" }));
  assert.ok(isRoutine({ title: 'Certain Softwood Lumber Products From Canada: Notice of NAFTA Panel Decision' }));
  assert.ok(isRoutine({ title: 'Performance Review Board Membership' }));
  assert.ok(!isRoutine({ title: 'Adjusting Imports of Robotics, Industrial Machinery, and Their Parts and Components Into the United States' }));
  assert.ok(!isRoutine({ title: 'Imposing Duties to Address the Flow of Illicit Drugs Across Our Northern Border' }));
});

test('parseJson skips reasoning in think tags', () => {
  assert.deepEqual(parseJson('<think>maybe {"x": 1}?</think>\n{"category": "tax"}'), { category: 'tax' });
  assert.deepEqual(parseJson('thinking about {"no": 1}...</think>{"ok": true}'), { ok: true });
});
