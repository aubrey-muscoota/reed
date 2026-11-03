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

// Item 1A (Risk Factors). A filing names it twice or more: once in the table
// of contents and once as the real heading. Take the start/end pair that
// spans the most text, which is the real section.
const SECTION_RULES = {
  risk_factors: {
    start: /item\s*1a\.?\s*[-–—:.]?\s*risk\s+factors/gi,
    end: /item\s*1b\.?\s*[-–—:.]?\s*unresolved|item\s*1c\.?\s*[-–—:.]?\s*cybersecurity|item\s*2\.?\s*[-–—:.]?\s*(properties|unregistered)/gi,
  },
};

export function extractSection(text, name = 'risk_factors') {
  const rule = SECTION_RULES[name];
  const starts = [...text.matchAll(rule.start)].map(m => m.index);
  const ends = [...text.matchAll(rule.end)].map(m => m.index);
  let best = '';
  for (const s of starts) {
    const e = ends.find(i => i > s);
    const piece = text.slice(s, e ?? Math.min(text.length, s + 400_000));
    if (piece.length > best.length) best = piece;
  }
  return best.trim();
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
