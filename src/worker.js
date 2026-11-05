// Serves muscoota.com/reed from D1. All the heavy work (filings, tagging,
// notes) happens in scheduled GitHub Actions; this Worker only reads.

import { writeup, STUDY } from './writeup.js';

const BASE = '/reed';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (path === BASE || path === '/' || path === '') return html(await home(env));
      if (path === `${BASE}/method`) return html(method());
      if (path === `${BASE}/eval`) return html(layout(STUDY.title, writeup(BASE), 'eval'));
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
    <p class="meta">${count} filings indexed from the S&amp;P 100. Sources: Federal Register, SEC EDGAR.</p>
    ${events.length === 0 ? '<p>No events yet. The first daily run fills this page.</p>' : events.map(e => eventBlock(e)).join('')}
    ${months.length ? `<nav class="months"><h2>By month</h2>${months.map(m => `<a href="${BASE}/month/${esc(m.month)}">${monthName(m.month)}</a> <span class="tk">${m.n}</span>`).join(' · ')}</nav>` : ''}`;
  return layout('Reed', body, 'events');
}

async function monthPage(env, month) {
  const events = await recent(env, 500, month);
  if (events.length === 0) return null;
  // Archive pages show actions with at least one company note; the rest are counted.
  const shown = events.filter(e => e.notes.length > 0);
  const rest = events.length - shown.length;
  return layout(monthName(month), `<p class="meta">${shown.length} ${shown.length === 1 ? "action" : "actions"} with company notes${rest ? `, and ${rest} more tagged relevant where no filing passage was specific enough` : ''}. <a href="${BASE}">Latest</a></p>${shown.map(e => eventBlock(e)).join('')}`, 'events');
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
  return layout(e.title, `${eventBlock(full, true)}<p><a href="${BASE}">All events</a></p>`, 'events');
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
      <li>An open-weight model running on Cloudflare Workers AI (currently Mistral Small 3.1 24B, chosen in <a href="${BASE}/eval">the evaluation</a>) tags each action by topic and decides whether it could matter to large U.S. companies.</li>
      <li>For relevant actions, Reed searches, by meaning and then by keyword, the Risk Factors sections of the latest 10-K and 10-Q filings of S&amp;P 100 companies, taken from <a href="https://www.sec.gov/edgar/search/">SEC EDGAR</a>.</li>
      <li>The model writes one or two sentences per company, using only those passages. A note is kept only if every passage it cites belongs to that company.</li>
    </ol>
    <p>The model can miss companies or misread a passage. Each note links to the filing text so it can be checked. <a href="${BASE}/eval">The first evaluation</a> measures how often this happens.</p>
    <h2>Not investment advice</h2>
    <p>Reed is a research project. It reports what companies say about themselves in public filings. It does not recommend buying or selling any security, rank companies, or predict prices.</p>
`, 'method');
}

const MARK = `<svg aria-hidden="true" viewBox="0 0 32 32"><g fill="none" stroke-width="1.5" stroke-linecap="round"><path stroke="currentColor" d="M6.7 5.4V10.6M9.3 5.4V10.6M5.4 14.7H10.6M5.4 17.3H10.6M6.7 21.4V26.6M9.3 21.4V26.6M13.4 6.7H18.6M13.4 9.3H18.6M14.7 13.4V18.6M17.3 13.4V18.6M13.4 22.7H18.6M13.4 25.3H18.6M22.7 5.4V10.6M25.3 5.4V10.6M22.7 21.4V26.6M25.3 21.4V26.6"/><path stroke="#CC785C" d="M21.4 14.7H26.6M21.4 17.3H26.6"/></g></svg>`;
const FAVICON = "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2032%2032'%3E%3Crect%20width='32'%20height='32'%20rx='6'%20fill='%23F3F0E8'/%3E%3Cg%20fill='none'%20stroke-width='1.5'%20stroke-linecap='round'%3E%3Cpath%20stroke='%23191917'%20d='M6.7%205.4V10.6M9.3%205.4V10.6M5.4%2014.7H10.6M5.4%2017.3H10.6M6.7%2021.4V26.6M9.3%2021.4V26.6M13.4%206.7H18.6M13.4%209.3H18.6M14.7%2013.4V18.6M17.3%2013.4V18.6M13.4%2022.7H18.6M13.4%2025.3H18.6M22.7%205.4V10.6M25.3%205.4V10.6M22.7%2021.4V26.6M25.3%2021.4V26.6'/%3E%3Cpath%20stroke='%23CC785C'%20d='M21.4%2014.7H26.6M21.4%2017.3H26.6'/%3E%3C/g%3E%3C/svg%3E";
const NAV = [['events', '', 'Events'], ['method', '/method', 'How it works'], ['eval', '/eval', 'Results']];

// Every page shares the Muscoota site header, plus Reed's own section nav.
// `active` is one of the NAV keys, or empty.
function layout(title, body, active = '') {
  const nav = NAV.map(([key, href, label]) =>
    `<a href="${BASE}${href}"${key === active ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}${title === 'Reed' ? ' · Muscoota Ventures' : ' · Reed'}</title>
<meta name="description" content="Which companies' SEC filings describe exposure to new U.S. government actions. A Muscoota research project.">
<meta name="theme-color" content="#F3F0E8">
<link rel="icon" href="${FAVICON}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@300..600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{--bg:#F3F0E8;--fg:#191917;--fg2:#3D3B36;--muted:#7A766C;--rule:rgba(25,25,23,.12);--quote:#EAE6DB;--link:#2F6770;--accent:#CC785C;
--sans:'Geist',ui-sans-serif,system-ui,-apple-system,'Helvetica Neue',Arial,sans-serif;--mono:'Geist Mono',ui-monospace,'SF Mono',Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#191917;--fg:#F3F0E8;--fg2:#D6D2C8;--muted:#9A958A;--rule:rgba(243,240,232,.14);--quote:#23221F;--link:#8FC3CB}}
*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 var(--sans);-webkit-font-smoothing:antialiased}
a{color:var(--link)}
.top{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px 28px;max-width:960px;margin:0 auto;padding:22px 16px 18px;border-bottom:1px solid var(--rule)}
.crumb{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:500;letter-spacing:-.01em}
.crumb a{color:var(--fg);text-decoration:none}.crumb .mark{display:inline-flex;align-items:center;gap:10px}.crumb svg{width:22px;height:22px}
.crumb .sep{color:var(--muted);font-weight:300}
.sub{display:flex;gap:22px;font-size:14px}.sub a{color:var(--fg2);text-decoration:none;padding:4px 0;border-bottom:1px solid transparent}
.sub a:hover{border-color:var(--rule)}.sub a[aria-current]{color:var(--fg);border-color:var(--accent)}
main{max-width:720px;margin:0 auto;padding:36px 16px 64px}
h1{font-size:26px;font-weight:500;letter-spacing:-.015em;line-height:1.25;margin:0 0 10px}
h2{font-size:18px;font-weight:500;margin:4px 0 6px;line-height:1.35}h2 a{color:var(--fg);text-decoration:none}h2 a:hover{text-decoration:underline}
.lead{font-size:17px;color:var(--fg2)}.meta,.src,.none{color:var(--muted);font-size:14px}
article{border-top:1px solid var(--rule);padding:20px 0}
ul.notes{list-style:none;padding:0;margin:12px 0 0}ul.notes>li{margin:0 0 14px}ul.notes p{margin:2px 0 4px}
.tk{color:var(--muted);font:13px var(--mono);margin-left:4px}
details summary{cursor:pointer;color:var(--muted);font-size:14px}
blockquote{margin:8px 0;padding:10px 12px;background:var(--quote);border-left:3px solid var(--rule);font-size:14px;overflow-wrap:anywhere}
blockquote footer{margin-top:6px;color:var(--muted)}
.scroll{overflow-x:auto}table{border-collapse:collapse;font-size:14px;width:100%}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--rule);vertical-align:top}th{font-weight:500}
ol li,ul li{margin-bottom:6px}
.byline{color:var(--muted);font-size:14px;margin:0 0 24px}
.abstract{background:var(--quote);padding:4px 20px 8px;margin:0 0 28px;border-radius:2px}.abstract p{font-size:15px}
h3{font-size:16px;font-weight:500;margin:20px 0 4px}
figure{margin:24px 0}figure.wide{width:min(960px,calc(100vw - 32px));margin-left:calc(50% - min(480px,50vw - 16px))}.nowrap td:first-child{white-space:nowrap}figcaption{font-size:14px;color:var(--fg2);margin-bottom:8px}figcaption strong{color:var(--fg)}
td.n,th.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.ci{color:var(--muted);font-size:12px;margin-left:4px}
tr.grp td{border-top:1px solid var(--muted)}sup{color:var(--muted);font-size:10px;margin-left:2px}
.history li{font-size:14px}
.months{margin-top:32px;border-top:1px solid var(--rule);padding-top:12px;font-size:14px;line-height:2}.later{font-style:italic}
.foot{max-width:960px;margin:0 auto;padding:16px 16px 28px;border-top:1px solid var(--rule);display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px 24px;color:var(--muted);font-size:12px}
.foot a{color:var(--muted)}
@media (max-width:600px){.sub{gap:18px;width:100%}}
</style></head><body>
<header class="top">
<div class="crumb"><a class="mark" href="/" aria-label="Muscoota Ventures home">${MARK}<span>Muscoota Ventures</span></a><span class="sep">/</span><a href="${BASE}">Reed</a></div>
<nav class="sub" aria-label="Reed">${nav}</nav>
</header>
<main>
${title === 'Reed' ? '' : `<h1>${esc(title)}</h1>`}
${body}
</main>
<footer class="foot"><span>Research and education only. Not investment advice.</span><span class="mono"><a href="/">Muscoota Ventures</a> · <a href="https://github.com/aubrey-muscoota/reed">Source</a></span></footer>
</body></html>`;
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
