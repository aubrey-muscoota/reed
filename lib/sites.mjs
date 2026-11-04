// Helpers for the sites-from-orbit check: find what a 10-K says about a
// facility so the claim in sites/claims.json can be read in the filing's own words.

const BUILD = /\b(construct\w*|build\w*|broke ground|groundbreaking|expan\w*|complet\w*|production|operation\w*|fab\w*|plant|facilit\w*|site|campus)\b/i;

// 10-K filings from the submissions feed whose period ends in one of `years`.
export function annualReports(submissions, years) {
  const r = submissions.filings.recent;
  const out = [];
  for (let i = 0; i < r.form.length; i++) {
    if (r.form[i] !== '10-K') continue;
    const year = Number(String(r.reportDate[i]).slice(0, 4));
    if (!years.includes(year) || out.some(f => f.year === year)) continue;
    out.push({ year, accession: r.accessionNumber[i], filed: r.filingDate[i], period: r.reportDate[i], primaryDocument: r.primaryDocument[i] });
  }
  return out.sort((a, b) => a.year - b.year);
}

// Sentences that name the facility, those about building it first.
export function mentions(text, phrases, max = 4) {
  const sentences = text.replace(/\s+/g, ' ').split(/(?<=[.;])\s+(?=[A-Z(])/);
  const hits = [];
  for (const s of sentences) {
    if (s.length < 40 || s.length > 900) continue;
    if (!phrases.some(p => s.toLowerCase().includes(p.toLowerCase()))) continue;
    if (!hits.includes(s)) hits.push(s);
  }
  return hits
    .map((s, i) => ({ s, i, build: BUILD.test(s) }))
    .sort((a, b) => (b.build - a.build) || (a.i - b.i))
    .slice(0, max)
    .sort((a, b) => a.i - b.i)
    .map(h => h.s);
}
