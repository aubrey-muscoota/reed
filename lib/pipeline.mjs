// The three steps for each event: tag it, find filing passages, write notes.

import { CATEGORIES, CONFIG } from './config.mjs';
import { parseJson } from './cf.mjs';
import { terms } from './text.mjs';

// 1. Tag ------------------------------------------------------------------

export async function tagEvent(cf, event, model = CONFIG.model) {
  const prompt = `You label U.S. government actions for a research index of large U.S. public companies.

Action:
Title: ${event.title}
Agencies: ${(event.agencies ?? []).join(', ')}
Summary: ${event.abstract || '(none)'}

Answer with JSON only:
{"category": one of ${JSON.stringify(CATEGORIES)},
 "relevant": true only if the action directly changes costs, revenue, or rules for an identifiable industry (for example new tariffs, sanctions, export controls, drug pricing, bank capital). false for routine or procedural items: delegations of authority, meeting notices, sunset reviews, panel decisions, single-company licenses, corrections, and administrative rules,
 "keywords": 3 to 8 short phrases a company might use in its own risk factors when describing exposure to this kind of action}`;
  const out = parseJson(await cf.chat(model, [{ role: 'user', content: prompt }]));
  return {
    category: CATEGORIES.includes(out.category) ? out.category : 'other',
    relevant: out.relevant === true,
    keywords: Array.isArray(out.keywords) ? out.keywords.map(String).slice(0, 8) : [],
  };
}

// 2. Retrieve ---------------------------------------------------------------

export function queryText(event, tag) {
  return [event.title, event.abstract, tag?.category, ...(tag?.keywords ?? [])].filter(Boolean).join('. ');
}

// Dense search: embed the event and ask Vectorize for the nearest passages.
export async function retrieveDense(cf, event, tag, topK = CONFIG.topK) {
  const [vec] = await cf.embed(CONFIG.embedModel, [queryText(event, tag)]);
  const matches = await cf.vectorize.query(CONFIG.index, vec, topK);
  return matches.map(m => ({ id: m.id, score: m.score, ...m.metadata }));
}

// Hybrid: rerank the dense results by blending in keyword overlap with the
// tagger's keywords and the event title. Cheap, and needs no second index.
export function rerankHybrid(passages, event, tag, weight = 0.35) {
  const q = new Set(terms([event.title, ...(tag?.keywords ?? [])].join(' ')));
  if (q.size === 0) return passages;
  return passages
    .map(p => {
      const words = new Set(terms(p.text ?? ''));
      let hit = 0;
      for (const t of q) if (words.has(t)) hit++;
      return { ...p, score: (1 - weight) * p.score + weight * (hit / q.size) };
    })
    .sort((a, b) => b.score - a.score);
}

export async function retrieve(cf, event, tag, mode = 'dense') {
  const dense = await retrieveDense(cf, event, tag);
  return mode === 'hybrid' ? rerankHybrid(dense, event, tag) : dense;
}

// 3. Explain ----------------------------------------------------------------

export async function explain(cf, event, passages, model = CONFIG.model) {
  const numbered = passages.map((p, i) => `[${i + 1}] ${p.company} (${p.ticker}), ${p.form} filed ${p.filed}:\n${p.text}`).join('\n\n');
  const prompt = `You are writing a research note, not investment advice. Never say whether to buy or sell, never predict prices, and never rank companies.

Government action:
${event.title}
${event.abstract || ''}

Passages from company SEC filings:
${numbered}

For each company whose own passages describe exposure to this kind of action, write one or two plain sentences saying what the company itself says about that exposure. Use only what the passages say. Cite the passage numbers you used.

Include a company only if a cited passage specifically names this kind of action, or the product, industry, or country it targets. General statements about regulation, the economy, or "changes in law" do not count. Most actions affect few or none of these companies; an empty list is a good answer when nothing specific applies.

Answer with JSON only:
{"companies": [{"ticker": "...", "summary": "...", "cites": [1, 2]}]}`;
  const out = parseJson(await cf.chat(model, [{ role: 'user', content: prompt }]));
  return validateNotes(out.companies, passages);
}

// No citation, no sentence: keep a note only when every cited passage exists
// and belongs to the same company.
export function validateNotes(companies, passages) {
  const notes = [];
  for (const c of Array.isArray(companies) ? companies : []) {
    const ticker = String(c.ticker ?? '').toUpperCase();
    const cites = (Array.isArray(c.cites) ? c.cites : []).map(Number).filter(n => Number.isInteger(n));
    const used = cites.map(n => passages[n - 1]).filter(Boolean);
    if (!ticker || !c.summary || used.length === 0) continue;
    if (used.length !== cites.length || used.some(p => p.ticker !== ticker)) continue;
    if (/\b(buy|sell|outperform|underperform|price target)\b/i.test(c.summary)) continue;
    if (notes.some(n => n.ticker === ticker)) continue;
    notes.push({
      ticker,
      company: used[0].company,
      summary: String(c.summary).trim(),
      citations: used.map(p => ({ chunk_id: p.id, form: p.form, filed: p.filed, url: p.url, section: p.section, text: p.text })),
    });
  }
  return notes;
}
