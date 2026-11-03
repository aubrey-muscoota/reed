// Turning filing HTML into clean text, finding sections, and cutting passages.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', bull: '•', hellip: '…' };

export function htmlToText(html) {
  return html
    // Inline XBRL headers and hidden blocks carry no prose.
    .replace(/<ix:header[\s\S]*?<\/ix:header>/gi, ' ')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<div[^>]*display:\s*none[^>]*>[\s\S]*?<\/div>/gi, ' ')
    // Block-level tags become line breaks so headings stay on their own line.
    .replace(/<\/?(p|div|br|tr|li|h[1-6]|table|section)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Item 1A (Risk Factors). A filing names it several times: in the table of
// contents, in cross-references ("see Item 1A. Risk Factors, ..."), and as
// the real heading. Only line-start headings count, a section must run to
// an end heading, and the longest such span wins.
const HEAD = String.raw`(?:^|\n)[ \t]*`;
const SEP = String.raw`\.?\s*[-\u2013\u2014:.]?\s*`;
const SECTION_RULES = {
  risk_factors: {
    start: new RegExp(`${HEAD}item\\s*1a${SEP}risk\\s+factors`, 'gi'),
    end: new RegExp(`${HEAD}item\\s*(?:1b${SEP}unresolved|1c${SEP}cybersecurity|2${SEP}(?:properties|unregistered))`, 'gi'),
    // Fallback for filings that split "Item 1A" from its title, or keep
    // risk factors in an annual report exhibit: a line that is just the
    // words "Risk Factors", up to the next major heading.
    looseStart: new RegExp(`${HEAD}(?:item\\s*1a${SEP})?risk\\s+factors(?:[ \t]*(?=\n)|\\.[ \t])`, 'gi'),
    // Last resort: any line starting "Item 1A" that is not a table-of-contents
    // row (those reach "Item 1B" within a few words). Catches filings whose
    // body heading is styled oddly but whose page headers repeat "Item 1A".
    pageStart: new RegExp(`${HEAD}item\\s*1a\\b(?![\\s\\S]{0,120}item\\s*1b)`, 'gi'),
    looseEnd: new RegExp(`${HEAD}(?:item\\s*(?:1b|1c|2|3|7)\\b|unresolved staff comments|cybersecurity[ \t]*\n|properties[ \t]*\n|legal proceedings[ \t]*\n|management.s discussion and analysis)`, 'gi'),
  },
};

function longestSpan(text, startRe, endRe, cap) {
  const starts = [...text.matchAll(startRe)].map(m => m.index);
  const ends = [...text.matchAll(endRe)].map(m => m.index);
  let best = '';
  for (const s of starts) {
    const e = ends.find(i => i > s);
    if (e === undefined && !cap) continue;
    const piece = text.slice(s, e ?? Math.min(text.length, s + cap));
    if (piece.length > best.length) best = piece;
  }
  return best.trim();
}

export function extractSection(text, name = 'risk_factors', { minLength = 3000 } = {}) {
  const rule = SECTION_RULES[name];
  const strict = longestSpan(text, rule.start, rule.end);
  if (strict.length >= minLength) return strict;
  let best = strict;
  for (const candidate of [
    longestSpan(text, rule.looseStart, rule.looseEnd, 300_000),
    firstToEnd(text, rule.pageStart, rule.end),
  ]) if (candidate.length > best.length) best = candidate;
  return best;
}

// From the first match of startRe to the next end heading after it.
function firstToEnd(text, startRe, endRe) {
  const s = text.search(new RegExp(startRe.source, 'i'));
  if (s < 0) return '';
  const ends = [...text.matchAll(endRe)].map(m => m.index).filter(i => i > s);
  return ends.length ? text.slice(s, ends[0]).trim() : '';
}

// Cut text into passages of about `size` words with `overlap` words carried
// over, breaking on paragraph edges where possible.
export function chunk(text, { size = 280, overlap = 40, min = 40 } = {}) {
  const paras = text.split(/\n+/).map(p => p.trim()).filter(Boolean);
  const out = [];
  let cur = [];
  let fresh = 0; // words added since the last passage was cut
  const flush = () => {
    if (cur.length >= min) out.push(cur.join(' '));
    cur = cur.slice(Math.max(0, cur.length - overlap));
    fresh = 0;
  };
  for (const p of paras) {
    const words = p.split(/\s+/);
    if (cur.length + words.length > size && fresh >= min) flush();
    for (const w of words) {
      cur.push(w);
      fresh++;
      if (cur.length >= size * 1.5) flush();
    }
  }
  if (fresh > 0 && (cur.length >= min || out.length === 0)) out.push(cur.join(' '));
  return out;
}

// Lowercase word tokens, minus common words, for the keyword half of hybrid search.
const STOP = new Set('a an and are as at be by for from has have in is it its of on or that the this to was were will with which our we may could would can such any other these those than not into upon also more'.split(' '));
export function terms(text) {
  return (text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []).filter(w => !STOP.has(w));
}
