// SEC EDGAR: map tickers to CIKs, find a company's latest filings, fetch text.
// SEC asks automated clients to identify themselves and stay under 10
// requests a second: https://www.sec.gov/os/accessing-edgar-data

import { htmlToText, extractSection } from './text.mjs';

export const SEC_USER_AGENT = process.env.SEC_USER_AGENT ?? 'Reed research (muscoota.com) aubrey@muscoota.com';

let last = 0;
async function secFetch(url, fetchImpl = fetch) {
  const wait = last + 150 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  last = Date.now();
  const res = await fetchImpl(url, { headers: { 'User-Agent': SEC_USER_AGENT, 'Accept-Encoding': 'gzip, deflate' } });
  if (!res.ok) throw new Error(`SEC ${res.status} for ${url}`);
  return res;
}

// New CIK -> the CIK that filed before a holding-company reorganization
// (Form 8-K12B). Exxon Mobil moved to a new parent in 2026.
export const PREDECESSOR_CIK = { 2115436: 34088 };

const CIK_FALLBACK = { BK: { cik: 1390777, company: 'Bank of New York Mellon Corp' } };

export async function tickerMap(fetchImpl) {
  const json = await (await secFetch('https://www.sec.gov/files/company_tickers.json', fetchImpl)).json();
  const map = new Map();
  for (const row of Object.values(json)) map.set(row.ticker.toUpperCase(), { cik: row.cik_str, company: row.title });
  // Companies missing from SEC's ticker file under their trading symbol.
  for (const [t, e] of Object.entries(CIK_FALLBACK)) if (!map.has(t)) map.set(t, e);
  return map;
}

// Latest filing of each wanted form from the submissions feed.
export function latestFilings(submissions, forms = ['10-K', '10-Q']) {
  const r = submissions.filings.recent;
  const found = {};
  for (let i = 0; i < r.form.length; i++) {
    const form = r.form[i];
    if (forms.includes(form) && !found[form]) {
      found[form] = {
        form,
        accession: r.accessionNumber[i],
        filed: r.filingDate[i],
        period: r.reportDate[i],
        primaryDocument: r.primaryDocument[i],
      };
    }
  }
  return forms.map(f => found[f]).filter(Boolean);
}

export function filingUrl(cik, filing) {
  return `https://www.sec.gov/Archives/edgar/data/${Number(filing.cik ?? cik)}/${filing.accession.replace(/-/g, '')}/${filing.primaryDocument}`;
}

export async function submissions(cik, fetchImpl) {
  const padded = String(cik).padStart(10, '0');
  return (await secFetch(`https://data.sec.gov/submissions/CIK${padded}.json`, fetchImpl)).json();
}

// Latest 10-K and 10-Q, looking in the first older page when the recent
// list (about a year, or 1,000 filings) has no 10-K. Busy filers such as
// Exxon Mobil can push their 10-K out of the recent list.
export async function latestReports(cik, fetchImpl) {
  const subs = await submissions(cik, fetchImpl);
  const found = latestFilings(subs);
  // Big filers (e.g. Exxon) push the last 10-K past the recent list; walk the
  // older pages, newest first, until one turns up.
  for (const { name } of subs.filings.files ?? []) {
    if (found.some(f => f.form === '10-K')) break;
    const older = await submissionsPage(name, fetchImpl);
    found.push(...latestFilings({ filings: { recent: older } }, ['10-K']));
  }
  // A company that moved its listing to a new holding company files under a
  // new CIK, and its last 10-K stays under the old one.
  const prev = PREDECESSOR_CIK[Number(cik)];
  if (prev && !found.some(f => f.form === '10-K')) {
    const k = (await latestReports(prev, fetchImpl)).find(f => f.form === '10-K');
    if (k) found.push({ ...k, cik: prev });
  }
  return found;
}

// Older filings live in extra pages listed under filings.files.
export async function submissionsPage(name, fetchImpl) {
  return (await secFetch(`https://data.sec.gov/submissions/${name}`, fetchImpl)).json();
}

export async function secText(url, fetchImpl) {
  return htmlToText(await (await secFetch(url, fetchImpl)).text());
}

// Fetch a filing and return its Risk Factors text ('' if not found). Some
// banks (Citi, Morgan Stanley, Wells Fargo) keep risk factors in the annual
// report filed as Exhibit 13, so look there when the main document is thin.
export async function riskFactors(url, fetchImpl) {
  const html = await (await secFetch(url, fetchImpl)).text();
  const main = extractSection(htmlToText(html), 'risk_factors');
  if (main.length >= 3000) return main;
  const base = url.slice(0, url.lastIndexOf('/'));
  let best = main;
  try {
    // The filing's index page lists each document with its exhibit type.
    const folder = base.slice(base.lastIndexOf('/') + 1);
    const acc = `${folder.slice(0, 10)}-${folder.slice(10, 12)}-${folder.slice(12)}`;
    const page = await (await secFetch(`${base}/${acc}-index.htm`, fetchImpl)).text();
    const exhibits = [...page.matchAll(/<tr[\s\S]*?<\/tr>/gi)]
      .map(m => m[0])
      .filter(row => />\s*EX-13(?:\.\d+)?\s*</i.test(row))
      .map(row => row.match(/href="([^"]+\.html?)"/i)?.[1])
      .filter(Boolean)
      .map(h => (h.startsWith('http') ? h : `https://www.sec.gov${h.startsWith('/') ? '' : '/'}${h}`).replace('/ix?doc=', ''));
    if (process.env.REED_DEBUG) console.error(`${url}: EX-13 documents ${JSON.stringify(exhibits)}`);
    for (const exUrl of exhibits) {
      const text = extractSection(htmlToText(await (await secFetch(exUrl, fetchImpl)).text()), 'risk_factors');
      if (text.length > best.length) best = text;
    }
  } catch (e) { if (process.env.REED_DEBUG) console.error(`exhibit lookup failed for ${url}: ${e.message}`); }
  return best;
}
