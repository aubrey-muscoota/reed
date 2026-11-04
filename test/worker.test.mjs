import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

// Minimal stand-in for the D1 binding.
function fakeDb({ events = [], notes = [], filings = 3 } = {}) {
  return {
    prepare(sql) {
      let params = [];
      const stmt = {
        bind: (...p) => { params = p; return stmt; },
        async all() {
          if (sql.includes('FROM events')) return { results: events };
          if (sql.includes('FROM notes')) return { results: notes.filter(n => !n.event_id || params.includes(n.event_id)) };
          return { results: [] };
        },
        async first() {
          if (sql.includes('COUNT(*)')) return { count: filings };
          if (sql.includes('FROM events')) return events.find(e => e.id === params[0]) ?? null;
          return null;
        },
      };
      return stmt;
    },
  };
}

const env = {
  DB: fakeDb({
    events: [{ id: '2026-01234', title: 'Export controls <on> chips', url: 'https://www.federalregister.gov/d/2026-01234', published: '2026-11-02', category: 'export controls', agencies: '["Industry and Security Bureau"]' }],
    notes: [{ event_id: '2026-01234', ticker: 'NVDA', company: 'NVIDIA CORP', summary: 'NVIDIA says controls limit sales.', citations: '[{"text":"quoted","url":"https://www.sec.gov/x","form":"10-K","filed":"2026-02-20","section":"Item 1A. Risk Factors"}]' }],
  }),
};

test('home page lists events, notes and the notice, and escapes HTML', async () => {
  const res = await worker.fetch(new Request('https://muscoota.com/reed'), env);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.includes('Export controls &lt;on&gt; chips'));
  assert.ok(body.includes('NVIDIA CORP'));
  assert.ok(body.includes('Not investment advice'));
  assert.ok(body.includes('3 filings indexed'));
});

test('event page and JSON feed work; unknown paths 404', async () => {
  assert.equal((await worker.fetch(new Request('https://muscoota.com/reed/event/2026-01234'), env)).status, 200);
  assert.equal((await worker.fetch(new Request('https://muscoota.com/reed/event/nope'), env)).status, 404);
  const feed = await (await worker.fetch(new Request('https://muscoota.com/reed/events.json'), env)).json();
  assert.equal(feed[0].notes[0].citations[0].form, '10-K');
  assert.equal((await worker.fetch(new Request('https://muscoota.com/reed/zzz'), env)).status, 404);
});

test('eval write-up page renders with its results table', async () => {
  const res = await worker.fetch(new Request('https://muscoota.com/reed/eval'), env);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.includes('How well does Reed work?'));
  assert.ok(body.includes('<td>Llama 3.3 70B</td><td>hybrid</td><td>62%</td><td>22</td><td>55%</td><td>12 of 57</td>'));
  assert.ok(body.includes('Not investment advice'));
});
