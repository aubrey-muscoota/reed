// Federal Register API (no key needed): https://www.federalregister.gov/developers/documentation/api/v1
// v0 takes presidential documents, significant rules, and rules or notices
// from the trade and sanctions agencies.

const FIELDS = ['document_number', 'title', 'abstract', 'html_url', 'publication_date', 'type', 'agencies'];
const TRADE_AGENCIES = ['industry-and-security-bureau', 'foreign-assets-control-office', 'trade-representative-office-of-united-states', 'international-trade-administration'];

function url(params) {
  const q = new URLSearchParams();
  for (const f of FIELDS) q.append('fields[]', f);
  q.set('per_page', '100');
  q.set('order', 'newest');
  for (const [k, v] of params) q.append(k, v);
  return `https://www.federalregister.gov/api/v1/documents.json?${q}`;
}

export function queries(since, until) {
  const d = ['conditions[publication_date][gte]', since];
  const u = until ? [['conditions[publication_date][lte]', until]] : [];
  return [
    url([d, ...u, ['conditions[type][]', 'PRESDOCU']]),
    url([d, ...u, ['conditions[type][]', 'RULE'], ['conditions[significant]', '1']]),
    url([d, ...u, ...TRADE_AGENCIES.map(a => ['conditions[agencies][]', a]), ['conditions[type][]', 'RULE'], ['conditions[type][]', 'NOTICE']]),
  ];
}

export function toEvent(doc) {
  return {
    id: doc.document_number,
    title: doc.title,
    abstract: doc.abstract ?? '',
    url: doc.html_url,
    published: doc.publication_date,
    doc_type: doc.type,
    agencies: (doc.agencies ?? []).map(a => a.name ?? a.raw_name).filter(Boolean),
  };
}

// Follows next_page_url, so a long window (a backfill month) returns every
// document, not just the first 100 per query.
export async function recentEvents(since, until, fetchImpl = fetch) {
  const seen = new Map();
  for (const first of queries(since, until)) {
    for (let u = first, pages = 0; u && pages < 50; pages++) {
      const res = await fetchImpl(u, { headers: { 'User-Agent': 'Reed research (muscoota.com)' } });
      if (!res.ok) throw new Error(`Federal Register ${res.status}`);
      const json = await res.json();
      for (const doc of json.results ?? []) if (!seen.has(doc.document_number)) seen.set(doc.document_number, toEvent(doc));
      u = json.next_page_url;
    }
  }
  return [...seen.values()].sort((a, b) => b.published.localeCompare(a.published));
}
