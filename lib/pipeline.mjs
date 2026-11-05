// The three steps for each event: tag it, find filing passages, write notes.

import { CATEGORIES, CONFIG } from './config.mjs';
import { parseJson } from './cf.mjs';
import { terms } from './text.mjs';

// 1. Tag ------------------------------------------------------------------

// Routine trade-remedy and procedural notices about narrow products. They
// are numerous and almost never specific to large-cap companies, and small
// models tend to mark them relevant anyway.
const ROUTINE = /antidumping|countervailing|less[- ]than[- ]fair[- ]value|sunset review|administrative review|scope ruling|panel decision|court decision not in harmony|performance review board|delegation of authority|sunshine act|meeting notice|agency information collection|privacy act of 1974|correction$/i;

export function isRoutine(event) {
  return ROUTINE.test(event.title ?? '');
}

export async function tagEvent(cf, event, model = CONFIG.model) {
  if (isRoutine(event)) return { category: 'other', relevant: false, keywords: [], routine: true };
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

// Diverse: take the 100 nearest passages, keep at most `perFiling` from any
// one filing, then fetch text for the survivors. Stops a few long filings
// with generic risk language from filling every slot.
export async function retrieveDiverse(cf, event, tag, { topK = CONFIG.topK, perFiling = 2 } = {}) {
  const [vec] = await cf.embed(CONFIG.embedModel, [queryText(event, tag)]);
  const matches = await cf.vectorize.query(CONFIG.index, vec, 100, { metadata: false });
  const picked = capPerFiling(matches, perFiling).slice(0, topK);
  const full = new Map((await cf.vectorize.getByIds(CONFIG.index, picked.map(m => m.id)) ?? []).map(v => [v.id, v.metadata]));
  return picked.filter(m => full.has(m.id)).map(m => ({ id: m.id, score: m.score, ...full.get(m.id) }));
}

// Passage ids are "<accession>-<n>"; keep the best `cap` per accession, in score order.
export function capPerFiling(matches, cap) {
  const count = new Map();
  return [...matches].sort((a, b) => b.score - a.score).filter(m => {
    const acc = m.id.replace(/-\d+$/, '');
    const n = (count.get(acc) ?? 0) + 1;
    count.set(acc, n);
    return n <= cap;
  });
}

export async function retrieve(cf, event, tag, mode = 'dense') {
  if (mode === 'diverse') return rerankHybrid(await retrieveDiverse(cf, event, tag), event, tag);
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

// Second check by the judge model: does the cited text name this specific
// action, or the product, industry or country it targets? Generic "tariffs
// could hurt us" passages fail. Notes that fail are dropped.
export async function checkSpecific(cf, event, notes, model = CONFIG.judgeModel) {
  const kept = [];
  for (const n of notes) {
    const prompt = `Government action: ${event.title}
${event.abstract || ''}

Company filing text:
${n.citations.map(c => c.text).join('\n---\n')}

Does this filing text specifically name this action, or the specific product, industry, or country it targets? A general statement about tariffs, trade, regulation, or changes in law does NOT count.
Answer with JSON only: {"specific": true or false}`;
    try {
      if (parseJson(await cf.chat(model, [{ role: 'user', content: prompt }])).specific === true) kept.push(n);
    } catch { /* unreadable answer: drop the note */ }
  }
  return kept;
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
