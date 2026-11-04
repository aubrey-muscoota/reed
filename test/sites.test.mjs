import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annualReports, mentions } from '../lib/sites.mjs';

test('annualReports keeps one 10-K per wanted fiscal year', () => {
  const subs = { filings: { recent: {
    form: ['10-Q', '10-K', '10-K/A', '10-K', '10-K'],
    reportDate: ['2025-06-30', '2024-12-31', '2024-12-31', '2023-12-31', '2022-12-31'],
    accessionNumber: ['a', 'b', 'c', 'd', 'e'],
    filingDate: ['2025-08-01', '2025-02-01', '2025-03-01', '2024-02-01', '2023-02-01'],
    primaryDocument: ['q.htm', 'k24.htm', 'ka.htm', 'k23.htm', 'k22.htm'],
  } } };
  const r = annualReports(subs, [2022, 2024]);
  assert.deepEqual(r.map(f => [f.year, f.accession]), [[2022, 'e'], [2024, 'b']]);
});

test('mentions finds sentences naming the facility, building ones first', () => {
  const text = 'We sell cars in Texas. Gigafactory Texas is located in Austin and we began construction there in 2020. ' +
    'Our Gigafactory Texas headcount grew a lot over the year because of hiring. Unrelated sentence about tax matters here.';
  const m = mentions(text, ['Gigafactory Texas'], 1);
  assert.equal(m.length, 1);
  assert.match(m[0], /began construction/);
  assert.equal(mentions(text, ['gigafactory texas']).length, 2);
});
