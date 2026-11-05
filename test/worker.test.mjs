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
          if (sql.includes('GROUP BY month')) return { results: [...new Set(events.map(e => e.published.slice(0, 7)))].map(month => ({ month, n: events.filter(e => e.published.startsWith(month)).length })) };
          if (sql.includes('FROM events')) return { results: events.filter(e => !sql.includes('substr(published') || e.published.startsWith(params[0])) };
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
    events: [
      { id: '2026-01234', title: 'Export controls <on> chips', url: 'https://www.federalregister.gov/d/2026-01234', published: '2026-11-02', category: 'export controls', agencies: '["Industry and Security Bureau"]', processed_at: '2026-11-03T14:00:00Z' },
      { id: '2025-00500', title: 'Steel tariffs', url: 'https://www.federalregister.gov/d/2025-00500', published: '2025-02-11', category: 'tariffs and trade', agencies: '[]', processed_at: '2026-11-05T02:00:00Z' },
    ],
    notes: [{ event_id: '2025-00500', ticker: 'F', company: 'FORD MOTOR CO', summary: 'Ford says steel tariffs raise costs.', citations: '[]' }, { event_id: '2026-01234', ticker: 'NVDA', company: 'NVIDIA CORP', summary: 'NVIDIA says controls limit sales.', citations: '[{"text":"quoted","url":"https://www.sec.gov/x","form":"10-K","filed":"2026-02-20","section":"Item 1A. Risk Factors"}]' }],
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
  assert.ok(body.includes('Matching U.S. government actions'));
  assert.ok(body.includes('Last updated'));
  assert.match(body, /<td>Mistral Small 3\.1 24B<\/td><td>dense<\/td>/);
  assert.match(body, /<td><\/td><td>hybrid<\/td><td class="n">44<sup>1<\/sup><\/td>/);
  assert.equal((body.match(/<tr/g) || []).length, 1 + 12 + 1 + 8 + 1 + 7);
  assert.ok(body.includes('Not investment advice'));
});

test('month pages list that month and label backfilled events', async () => {
  const home = await (await worker.fetch(new Request('https://muscoota.com/reed'), env)).text();
  assert.ok(home.includes('href="/reed/month/2025-02">February 2025</a>'));
  const res = await worker.fetch(new Request('https://muscoota.com/reed/month/2025-02'), env);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.includes('Steel tariffs'));
  assert.ok(!body.includes('Export controls'));
  assert.ok(body.includes('Added 2026-11-05 using filings current then'));
  assert.ok(body.includes('1 action with company notes'));
  assert.equal((await worker.fetch(new Request('https://muscoota.com/reed/month/2024-01'), env)).status, 404);
});

test('events processed within two weeks carry no backfill label', async () => {
  const body = await (await worker.fetch(new Request('https://muscoota.com/reed/event/2026-01234'), env)).text();
  assert.ok(!body.includes('Added '));
});

test('every page links back to Muscoota and marks its section in the Reed nav', async () => {
  const pages = { '/reed': 'Events', '/reed/method': 'How it works', '/reed/eval': 'Results', '/reed/month/2026-11': 'Events' };
  for (const [path, label] of Object.entries(pages)) {
    const body = await (await worker.fetch(new Request(`https://muscoota.com${path}`), env)).text();
    assert.ok(body.includes('href="/" aria-label="Muscoota Ventures home"'), path);
    assert.match(body, new RegExp(`aria-current="page">${label}<`), path);
    assert.equal(body.match(/aria-current="page"/g).length, 1, path);
  }
});
