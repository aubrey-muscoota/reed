// Serves muscoota.com/reed from D1. All the heavy work (filings, tagging,
// notes) happens in scheduled GitHub Actions; this Worker only reads.

import { writeup } from './writeup.js';

const BASE = '/reed';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (path === BASE || path === '/' || path === '') return html(await home(env));
      if (path === `${BASE}/method`) return html(method());
      if (path === `${BASE}/eval`) return html(layout('How well does Reed work?', writeup(BASE)));
      if (path === `${BASE}/events.json`) return json(await recent(env, 50));
      const month = path.match(new RegExp(`^${BASE}/month/(\\d{4}-\\d{2})$`));
      if (month) {
        const page = await monthPage(env, month[1]);
        return page ? html(page) : html(layout('Not found', '<p>No events that month.</p>'), 404);
      }
      if (path.startsWith(`${BASE}/event/`)) {
        const page = await eventPage(env, decodeURIComponent(path.slice(`${BASE}/event/`.length)));
        return page ? html(page) : html(layout('Not found', '<p>No such event.</p>'), 404);
      }
      return html(layout('Not found', '<p>Page not found.</p>'), 404);
    } catch (err) {
      console.error(err);
      return html(layout('Error', '<p>Something went wrong loading this page.</p>'), 500);
    }
  },
};

async function recent(env, limit, month) {
  const { results: events } = await env.DB.prepare(
    `SELECT id, title, url, published, category, agencies, processed_at FROM events
     WHERE relevant = 1 ${month ? "AND substr(published, 1, 7) = ?" : ''} ORDER BY published DESC, id DESC LIMIT ?`,
  ).bind(...(month ? [month, limit] : [limit])).all();
  return withNotes(env, events);
}

async function withNotes(env, events) {
  if (events.length === 0) return [];
  // D1 allows at most 100 bound parameters per query.
  const notes = [];
  for (let i = 0; i < events.length; i += 90) {
    const ids = events.slice(i, i + 90).map(e => e.id);
    const { results } = await env.DB.prepare(
      `SELECT event_id, ticker, company, summary, citations FROM notes
       WHERE event_id IN (${ids.map(() => '?').join(',')}) ORDER BY ticker`,
    ).bind(...ids).all();
    notes.push(...results);
  }
  return events.map(e => ({
    ...e,
    agencies: safeJson(e.agencies, []),
    notes: notes.filter(n => n.event_id === e.id).map(n => ({ ticker: n.ticker, company: n.company, summary: n.summary, citations: safeJson(n.citations, []) })),
  }));
}

async function home(env) {
  const events = await recent(env, 30);
  const { count } = (await env.DB.prepare('SELECT COUNT(*) AS count FROM filings').first()) ?? { count: 0 };
  const { results: months } = await env.DB.prepare(
    `SELECT substr(published, 1, 7) AS month, COUNT(*) AS n FROM events WHERE relevant = 1 GROUP BY month ORDER BY month DESC`,
  ).all();
  const body = `
    <p class="lead">When a U.S. government action is published, Reed tags it and shows which large companies' own SEC filings describe exposure to that kind of action, quoting the passages.</p>
    <p class="meta">${count} filings indexed from the S&amp;P 100. Sources: Federal Register, SEC EDGAR. <a href="${BASE}/method">How it works</a> · <a href="${BASE}/eval">How well it works</a></p>
    ${events.length === 0 ? '<p>No events yet. The first daily run fills this page.</p>' : events.map(e => eventBlock(e)).join('')}
    ${months.length ? `<nav class="months"><h2>By month</h2>${months.map(m => `<a href="${BASE}/month/${esc(m.month)}">${monthName(m.month)}</a> <span class="tk">${m.n}</span>`).join(' · ')}</nav>` : ''}`;
  return layout('Reed', body);
}

async function monthPage(env, month) {
  const events = await recent(env, 500, month);
  if (events.length === 0) return null;
  return layout(monthName(month), `<p class="meta">${events.length} actions. <a href="${BASE}">Latest</a></p>${events.map(e => eventBlock(e)).join('')}`);
}

function monthName(m) {
  const [y, mo] = m.split('-').map(Number);
  return `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][mo - 1] ?? ''} ${y}`;
}

// Events tagged long after they were published came from a backfill: their
// notes quote the filings indexed on the processing date, not those in force
// when the action came out.
function addedLater(e) {
  if (!e.processed_at || !e.published) return '';
  const days = (Date.parse(e.processed_at) - Date.parse(e.published)) / 864e5;
  return days > 14 ? ` · <span class="later">Added ${esc(e.processed_at.slice(0, 10))} using filings current then</span>` : '';
}

async function eventPage(env, id) {
  const e = (await env.DB.prepare('SELECT id, title, url, published, category, agencies, abstract, processed_at FROM events WHERE id = ?').bind(id).first());
  if (!e) return null;
  const { results: notes } = await env.DB.prepare('SELECT ticker, company, summary, citations FROM notes WHERE event_id = ? ORDER BY ticker').bind(id).all();
  const full = { ...e, agencies: safeJson(e.agencies, []), notes: notes.map(n => ({ ...n, citations: safeJson(n.citations, []) })) };
  return layout(e.title, `${eventBlock(full, true)}<p><a href="${BASE}">All events</a></p>`);
}

function eventBlock(e, open = false) {
  const notes = e.notes.length === 0
    ? '<p class="none">No company filings in the index describe exposure to this action.</p>'
    : `<ul class="notes">${e.notes.map(n => `
        <li><strong>${esc(n.company)}</strong> <span class="tk">${esc(n.ticker)}</span>
          <p>${esc(n.summary)}</p>
          <details${open ? ' open' : ''}><summary>Filing text</summary>
            ${n.citations.map(c => `<blockquote>${esc(c.text)}<footer><a href="${esc(c.url)}" rel="noopener">${esc(c.form)} filed ${esc(c.filed)}, ${esc(c.section ?? '')}</a></footer></blockquote>`).join('')}
          </details>
        </li>`).join('')}</ul>`;
  return `<article>
    <p class="meta">${esc(e.published)} · ${esc(e.category ?? '')}${e.agencies?.length ? ` · ${esc(e.agencies.join(', '))}` : ''}${addedLater(e)}</p>
    <h2><a href="${BASE}/event/${encodeURIComponent(e.id)}">${esc(e.title)}</a></h2>
    ${e.abstract && open ? `<p>${esc(e.abstract)}</p>` : ''}
    <p class="src"><a href="${esc(e.url)}" rel="noopener">Federal Register ${esc(e.id)}</a></p>
    ${notes}
  </article>`;
}

function method() {
  return layout('How Reed works', `
    <ol>
      <li>Each day, Reed pulls new presidential documents, significant rules, and trade and sanctions actions from the <a href="https://www.federalregister.gov/developers/documentation/api/v1">Federal Register API</a>.</li>
      <li>An open-weight model running on Cloudflare Workers AI tags each action by topic and decides whether it could matter to large U.S. companies.</li>
      <li>For relevant actions, Reed searches the Risk Factors sections of the latest 10-K and 10-Q filings of S&amp;P 100 companies, taken from <a href="https://www.sec.gov/edgar/search/">SEC EDGAR</a>.</li>
      <li>The model writes one or two sentences per company, using only those passages. A note is kept only if every passage it cites belongs to that company.</li>
    </ol>
    <p>The model can miss companies or misread a passage. Each note links to the filing text so it can be checked. <a href="${BASE}/eval">The first evaluation</a> measures how often this happens.</p>
    <h2>Not investment advice</h2>
    <p>Reed is a research project. It reports what companies say about themselves in public filings. It does not recommend buying or selling any security, rank companies, or predict prices.</p>
    <p><a href="${BASE}">Back to events</a></p>`);
}

function layout(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}${title === 'Reed' ? ' · Muscoota' : ' · Reed'}</title>
<meta name="description" content="Which companies' SEC filings describe exposure to new U.S. government actions. A Muscoota research project.">
<style>
:root{--bg:#fbfbf9;--fg:#1d1d1b;--muted:#6b6b66;--rule:#e2e2dc;--quote:#f1f1ec;--link:#1d4f73}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ececea;--muted:#9a9a94;--rule:#2c2c2a;--quote:#1d1d1b;--link:#8cbbe0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:40px 16px 80px}a{color:var(--link)}
header{display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid var(--rule);padding-bottom:12px;margin-bottom:24px}
header a{color:var(--fg);text-decoration:none}header .home{font-weight:600}
h1{font-size:22px;margin:0 0 8px}h2{font-size:18px;margin:4px 0 6px;line-height:1.35}h2 a{color:var(--fg);text-decoration:none}
.lead{font-size:17px}.meta,.src,.none,footer{color:var(--muted);font-size:14px}
article{border-top:1px solid var(--rule);padding:20px 0}
ul.notes{list-style:none;padding:0;margin:12px 0 0}ul.notes>li{margin:0 0 14px}ul.notes p{margin:2px 0 4px}
.tk{color:var(--muted);font-size:13px;margin-left:4px}
details summary{cursor:pointer;color:var(--muted);font-size:14px}
blockquote{margin:8px 0;padding:10px 12px;background:var(--quote);border-left:3px solid var(--rule);font-size:14px;overflow-wrap:anywhere}
blockquote footer{margin-top:6px}
.scroll{overflow-x:auto}table{border-collapse:collapse;font-size:14px;width:100%}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--rule);vertical-align:top}th{font-weight:600}
ol li,ul li{margin-bottom:6px}
.months{margin-top:32px;border-top:1px solid var(--rule);padding-top:12px;font-size:14px;line-height:2}.later{font-style:italic}
.notice{margin-top:40px;border-top:1px solid var(--rule);padding-top:12px;color:var(--muted);font-size:13px}
</style></head><body><main>
<header><a class="home" href="${BASE}">Reed</a><a href="/">Muscoota</a></header>
${title === 'Reed' ? '' : `<h1>${esc(title)}</h1>`}
${body}
<p class="notice">Research and education only. Not investment advice.</p>
</main></body></html>`;
}

function html(body, status = 200) {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' } });
}
function json(data) {
  return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' } });
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function safeJson(s, fallback) {
  try { return JSON.parse(s) ?? fallback; } catch { return fallback; }
}
