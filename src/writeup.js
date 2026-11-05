// The evaluation write-up, served at /reed/eval. Table numbers come from
// src/eval-data.js, generated from eval/results/2026-11-05.jsonl
// (GitHub Actions run 41948197562) by scripts/analyze-eval.mjs.

import { RESULTS } from './eval-data.js';

export const STUDY = {
  title: 'Matching U.S. government actions to company risk disclosures: an evaluation of four open-weight models',
  published: 'November 4, 2026',
  updated: 'November 5, 2026',
  version: 2,
};

// Paired differences against dense search, percentage points with 95% CI.
const PAIRED = [
  // model, search, Δ recall@10 [lo, hi], Δ pairs found [lo, hi]
  ['Llama 3.1 8B', 'hybrid', -2, -10, 5, 7, 2, 15],
  ['Llama 3.1 8B', 'diverse', -1, -9, 6, 4, 0, 9],
  ['Mistral Small 3.1 24B', 'hybrid', -3, -11, 4, 3, 0, 6],
  ['Mistral Small 3.1 24B', 'diverse', 2, -6, 9, 0, -6, 4],
  ['Qwen3 30B A3B', 'hybrid', 0, -7, 5, 3, -5, 11],
  ['Qwen3 30B A3B', 'diverse', 1, -6, 8, -2, -11, 6],
  ['Llama 3.3 70B', 'hybrid', -1, -5, 4, 1, -1, 3],
  ['Llama 3.3 70B', 'diverse', 1, -5, 7, -5, -11, 0],
];

// Pairs found by topic, pooled over the four models with hybrid search.
const BY_TOPIC = [
  ['Healthcare and drug pricing', 6, 46, 96],
  ['Export controls', 4, 10, 43],
  ['Labor and immigration', 3, 4, 24],
  ['Energy and climate', 8, 7, 48],
  ['Tariffs and trade', 9, 11, 129],
  ['Interest rates and banking', 6, 7, 84],
  ['Other topics (sanctions, technology, tax, defense, transportation, other)', 9, 11, 76],
];

const pm = n => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');
const range = (lo, hi) => `<span class="ci">${lo}–${hi}</span>`;
const prange = (lo, hi) => `<span class="ci">${pm(lo)} to ${pm(hi)}</span>`;

function mainTable() {
  let last = '';
  const rows = RESULTS.map(([m, s, n, err, tag, rec, rlo, rhi, found, of, , , , pub, prec, plo, phi, sup]) => {
    const first = m !== last; last = m;
    return `<tr${first ? ' class="grp"' : ''}><td>${first ? m : ''}</td><td>${s}</td><td class="n">${n}${err ? `<sup>${err}</sup>` : ''}</td><td class="n">${first ? `${tag}%` : ''}</td><td class="n">${rec}% ${range(rlo, rhi)}</td><td class="n">${found} / ${of}</td><td class="n">${pub.toFixed(1)}</td><td class="n">${prec}% ${range(plo, phi)}</td><td class="n">${sup}%</td></tr>`;
  }).join('');
  return `<thead><tr><th>Model</th><th>Search</th><th class="n">Actions scored</th><th class="n">Topic correct</th><th class="n">Recall@10</th><th class="n">Pairs found</th><th class="n">Notes per action</th><th class="n">Notes on list</th><th class="n">Supported</th></tr></thead><tbody>${rows}</tbody>`;
}

function pairedTable() {
  const rows = PAIRED.map(([m, s, r, rlo, rhi, p, plo, phi]) =>
    `<tr><td>${m}</td><td>${s}</td><td class="n">${pm(r)} ${prange(rlo, rhi)}</td><td class="n">${pm(p)} ${prange(plo, phi)}</td></tr>`).join('');
  return `<thead><tr><th>Model</th><th>Search</th><th class="n">Δ Recall@10</th><th class="n">Δ Pairs found</th></tr></thead><tbody>${rows}</tbody>`;
}

function topicTable() {
  const rows = BY_TOPIC.map(([t, n, f, of]) =>
    `<tr><td>${t}</td><td class="n">${n}</td><td class="n">${f} / ${of}</td><td class="n">${Math.round((100 * f) / of)}%</td></tr>`).join('');
  return `<thead><tr><th>Topic</th><th class="n">Actions</th><th class="n">Pairs found</th><th class="n">Share</th></tr></thead><tbody>${rows}</tbody>`;
}

export function writeup(base) {
  return `
<p class="byline">Muscoota Ventures · Working paper, version ${STUDY.version}<br>
Published ${STUDY.published} · Last updated ${STUDY.updated}</p>

<section class="abstract">
<h2>Abstract</h2>
<p>Reed reads new U.S. federal actions and points to S&amp;P 100 companies whose own SEC filings describe exposure to that kind of action, quoting the passages. We tested the pipeline on 45 past actions with 135 company and action pairs, where each listed company names the action in the Risk Factors of its latest 10-K. Four open-weight models (8B to 70B parameters) each ran the full pipeline under three search setups. The models named the right topic for 86% to 95% of actions. The right company appeared among the ten passages given to the model about two times in three. The published notes covered 11% to 21% of the listed pairs, and 48% to 68% of published notes named a listed company. A keyword rerank on top of vector search found more pairs for all four models, by 1 to 7 points. Limiting passages per filing did not help. Differences between the three larger models were within the 95% intervals. The live site now uses Mistral Small 3.1 24B with the keyword rerank.</p>
</section>

<h2>1. Question</h2>
<p>When the government publishes an action, such as a tariff, an export rule, or a drug pricing program, which large companies have told investors that this kind of action affects them? Companies answer this themselves in the Risk Factors section of their 10-K and 10-Q filings. Reed tries to find those passages automatically, using only open-weight models. This paper measures how often it succeeds, and which model and search setup work best.</p>

<h2>2. Methods</h2>
<h3>2.1 Test set</h3>
<p>We chose 45 past federal actions across twelve topics, 33 of them from 2024 to 2026. For each action we listed the S&amp;P 100 companies whose latest 10-K Risk Factors section mentions it, found by a keyword search of the filing text with no model involved. That gives 135 company and action pairs. Actions with no matching filing were dropped. The set, the search terms, and the selection steps are in <a href="https://github.com/aubrey-muscoota/reed/tree/main/eval">the repository</a>.</p>
<h3>2.2 Pipeline</h3>
<p>For each action, the model assigns one of twelve topics and decides whether the action could matter to large companies. Reed then searches about 8,000 passages from the Risk Factors sections of the latest 10-K and 10-Q filings of 101 companies in the S&amp;P 100 and gives the model the ten best. The model writes a short note for each company it thinks is exposed, citing passages. A note is published only if every cited passage belongs to that company and a second check finds it specific to the action. <a href="${base}/method">How Reed works</a> describes each step.</p>
<h3>2.3 Conditions</h3>
<p>Four models from the Cloudflare Workers AI catalog: Llama 3.1 8B, Mistral Small 3.1 24B, Qwen3 30B A3B, and Llama 3.3 70B. Three search setups:</p>
<ul>
<li><strong>Dense:</strong> vector search with bge-base-en-v1.5 embeddings.</li>
<li><strong>Hybrid:</strong> dense search, then a rerank that rewards passages sharing words with the action.</li>
<li><strong>Diverse:</strong> dense search over the top 100 passages, keeping at most two per filing, then the same rerank.</li>
</ul>
<p>Every action ran once under each of the twelve combinations.</p>
<h3>2.4 Measures</h3>
<ul>
<li><strong>Topic correct:</strong> share of actions given the expected topic.</li>
<li><strong>Recall@10:</strong> share of listed companies with at least one passage among the ten given to the model, averaged over actions.</li>
<li><strong>Pairs found:</strong> listed company and action pairs with a published note.</li>
<li><strong>Notes on list:</strong> share of published notes that name a listed company, averaged over actions with any notes.</li>
<li><strong>Supported:</strong> share of notes that a judge model (Llama 3.3 70B) says the quoted text supports.</li>
</ul>
<h3>2.5 Statistics</h3>
<p>Intervals are 95% bootstrap intervals from 2,000 resamples of actions. Comparisons between search setups are paired, since every setup ran on the same actions with the same model. When a model returned malformed output or timed out on an action, that action is left out of that model's numbers.</p>

<h2>3. Results</h2>
<figure class="wide">
<figcaption><strong>Table 1.</strong> Results by model and search setup, with 95% intervals in grey. Superscripts give the number of actions that failed with that model.</figcaption>
<div class="scroll"><table class="nowrap">${mainTable()}</table></div>
</figure>

<figure>
<figcaption><strong>Table 2.</strong> Change against dense search for the same model, in percentage points, with 95% intervals. Pairs found is the share of each action's listed companies that got a note.</figcaption>
<div class="scroll"><table class="nowrap">${pairedTable()}</table></div>
</figure>

<figure>
<figcaption><strong>Table 3.</strong> Pairs found by topic, pooled over the four models with hybrid search.</figcaption>
<div class="scroll"><table>${topicTable()}</table></div>
</figure>

<h3>3.1 Topic tagging</h3>
<p>Accuracy ranged from 86% (Mistral) to 95% (Llama 3.3 70B). Most misses were on actions that sit between topics. The SNAP waiver restrictions and the fuel economy reset were tagged differently from our label by every model. The PFAS drinking water rule and the digital payments supervision rule were each missed by two models. In the first version of this paper, with 17 more clear-cut actions, all models scored 100%.</p>
<h3>3.2 Search</h3>
<p>Recall@10 was 62% to 69% in every condition. The intervals overlap heavily, and no search setup changed recall reliably (Table 2). On the 17 actions from version 1, recall rose by about 2 points after BNY Mellon was added and outdated filings were removed from the index.</p>
<h3>3.3 Published notes</h3>
<p>The hybrid setup found more pairs than dense for all four models: 25 against 18 for Llama 3.1 8B, 28 against 23 for Mistral, 25 against 20 for Qwen3, and 18 against 16 for Llama 3.3 70B. The interval excludes zero for Llama 3.1 8B and touches it for Mistral. The diverse setup found fewer pairs than dense for Qwen3 and Llama 3.3 70B. Mistral with hybrid search found the most pairs, 28 of 132, and failed on one action.</p>
<p>Reed published about one note per action. Of the published notes across all models with hybrid search, 71 of 167 named a company that is not on the list. Some are likely correct, because the lists only include companies whose 10-K names the action in Item 1A.</p>
<h3>3.4 Topics</h3>
<p>Results depend strongly on the topic (Table 3). Drug pricing actions found nearly half of their pairs, because the affected drug makers and insurers describe these programs by name. Tariff and banking actions found under one in ten. Many companies mention tariffs or capital rules in general terms, and the specificity check usually rejects those notes. 26 of the 45 actions got no pair found in any condition.</p>
<h3>3.5 Faithfulness and failures</h3>
<p>The judge found that the quoted passages support the note 96% to 100% of the time. The judge is also one of the models tested, so this may be generous. Twelve of 180 model runs failed: ten with malformed or cut-off JSON, one with an empty answer, and one timeout.</p>

<h2>4. Discussion</h2>
<p>Search is still the main limit. A third of listed companies never reach the model, and no setup we tried changed that. The keyword rerank helps at the next step instead: it brings up passages that name the action, so the model writes notes that pass the specificity check. Model size mattered less than expected. The 24B and 30B models did as well as the 70B model at lower cost. The 8B model was close on these measures but failed more often.</p>
<p>Based on these results, the live site switched from Llama 3.3 70B with dense search to Mistral Small 3.1 24B with hybrid search on ${STUDY.updated}. Reed now also accepts a trailing comma in model output, which caused two of the 70B model's three failures.</p>

<h2>5. Limitations</h2>
<ul>
<li>The expected lists come from keyword matches on 10-K text, not a full reading. They miss exposures described in other words or outside Item 1A, so precision is understated.</li>
<li>Each condition ran once. Model output varies between runs, so small differences may not repeat.</li>
<li>45 actions is a small set. Most topics have fewer than ten actions.</li>
<li>Older actions were scored against current filings, which may describe a risk differently than filings from the time of the action.</li>
<li>The judge model is one of the models tested.</li>
<li>Exxon Mobil's 10-K was not in the index for this run.</li>
</ul>

<h2>6. Next steps</h2>
<ul>
<li>A hand-checked gold set, read in full rather than keyword matched.</li>
<li>Search changes aimed at recall, such as searching each company separately.</li>
<li>Repeated runs, and a weekly evaluation with results over time.</li>
</ul>

<h2>Data and code</h2>
<p>Results for each action: <a href="https://github.com/aubrey-muscoota/reed/blob/main/eval/results/2026-11-05.jsonl">eval/results/2026-11-05.jsonl</a>. Analysis: <a href="https://github.com/aubrey-muscoota/reed/blob/main/scripts/analyze-eval.mjs">scripts/analyze-eval.mjs</a>. Pipeline: <a href="https://github.com/aubrey-muscoota/reed">github.com/aubrey-muscoota/reed</a>.</p>

<h2>Revision history</h2>
<ul class="history">
<li><strong>Version 2, ${STUDY.updated}.</strong> 45 actions instead of 17, a third search setup (diverse), bootstrap intervals, results by topic. BNY Mellon added to the index. Live site settings changed as described in section 4.</li>
<li><strong>Version 1, ${STUDY.published}.</strong> 17 actions, four models, dense and hybrid search. <a href="https://github.com/aubrey-muscoota/reed/blob/main/eval/results/2026-11-04.jsonl">Results</a>.</li>
</ul>`;
}
