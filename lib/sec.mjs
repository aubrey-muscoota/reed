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

export async function tickerMap(fetchImpl) {
  const json = await (await secFetch('https://www.sec.gov/files/company_tickers.json', fetchImpl)).json();
  const map = new Map();
  for (const row of Object.values(json)) map.set(row.ticker.toUpperCase(), { cik: row.cik_str, company: row.title });
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
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${filing.accession.replace(/-/g, '')}/${filing.primaryDocument}`;
}

export async function submissions(cik, fetchImpl) {
  const padded = String(cik).padStart(10, '0');
  return (await secFetch(`https://data.sec.gov/submissions/CIK${padded}.json`, fetchImpl)).json();
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
    const index = await (await secFetch(`${base}/index.json`, fetchImpl)).json();
    const names = (index.directory?.item ?? []).map(i => i.name);
    const exhibits = names.filter(n => /ex-?13/i.test(n) && /\.html?$/i.test(n));
    if (process.env.REED_DEBUG) console.error(`${url}: exhibits ${JSON.stringify(exhibits)} of ${names.length} files`);
    for (const name of exhibits) {
      const text = extractSection(htmlToText(await (await secFetch(`${base}/${name}`, fetchImpl)).text()), 'risk_factors');
      if (text.length > best.length) best = text;
    }
  } catch (e) { if (process.env.REED_DEBUG) console.error(`exhibit lookup failed for ${url}: ${e.message}`); }
  return best;
}
