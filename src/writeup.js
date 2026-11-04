// The first evaluation write-up, served at /reed/eval. Numbers come from
// eval/results/2026-11-04.jsonl (GitHub Actions run 41757310705).

const ROWS = [
  // model, search, recall@10, published, on list, pairs found, pairs scored
  ['Llama 3.1 8B', 'dense', 51, 24, 8, 8, 53],
  ['Llama 3.1 8B', 'hybrid', 55, 25, 10, 10, 53],
  ['Mistral Small 3.1 24B', 'dense', 61, 23, 11, 11, 61],
  ['Mistral Small 3.1 24B', 'hybrid', 62, 22, 11, 11, 61],
  ['Qwen3 30B A3B', 'dense', 60, 26, 13, 13, 61],
  ['Qwen3 30B A3B', 'hybrid', 61, 20, 11, 11, 61],
  ['Llama 3.3 70B', 'dense', 60, 26, 12, 12, 57],
  ['Llama 3.3 70B', 'hybrid', 62, 22, 12, 12, 57],
];

const pct = (a, b) => `${Math.round((100 * a) / b)}%`;

export function writeup(base) {
  const rows = ROWS.map(([m, s, r, pub, on, found, of]) =>
    `<tr><td>${m}</td><td>${s}</td><td>${r}%</td><td>${pub}</td><td>${pct(on, pub)}</td><td>${found} of ${of}</td></tr>`).join('');
  return `
<p class="meta">November 4, 2026</p>
<p class="lead">Reed reads new U.S. government actions and points to S&amp;P 100 companies whose own filings describe exposure to them. This is a first check of how often it gets that right, and which open-weight model does it best.</p>

<h2>Setup</h2>
<p>We took 17 past federal actions, such as Section 301 tariffs on China, Medicare drug price negotiation, and the credit card late fee rule. For each one we listed the S&amp;P 100 companies whose latest 10-K Risk Factors section names that kind of action, checked by searching the filing text. That gives 61 company and action pairs. The list and the check are in the <a href="https://github.com/aubrey-muscoota/reed/tree/main/eval">repository</a>.</p>
<p>Four open-weight models running on Cloudflare Workers AI each ran the full pipeline on every action: tag the topic, search the filings, and write cited notes. A note is published only if a second check finds it specific to the action. Each model ran twice, once with plain vector search (dense) and once with a keyword rerank on top (hybrid).</p>

<h2>Results</h2>
<div class="scroll"><table>
<thead><tr><th>Model</th><th>Search</th><th>Right company in top 10 passages</th><th>Notes published</th><th>On the list</th><th>Pairs found</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>
<p class="meta">Llama 3.1 8B failed on 3 of 17 actions and Llama 3.3 70B on 1, by returning malformed output. Those actions are left out of that model's numbers, which is why fewer pairs are scored.</p>

<h2>What we learned</h2>
<ol>
<li><strong>Tagging is the easy part.</strong> Every model put all 17 actions in the right topic. With ten broad topics, this test can't tell the models apart.</li>
<li><strong>Search is the weak step.</strong> The right companies showed up in the ten passages handed to the model only about 60% of the time. The keyword rerank adds one to four points. Our guess is that generic risk language from many companies crowds out the few passages that name the action.</li>
<li><strong>Reed is cautious.</strong> It published one to two notes per action and found about one in five of the listed pairs. Some actions with clear exposure got no notes at all, including the steel and aluminum tariffs (Ford, GM, Caterpillar, Boeing) and the offshore oil and gas leasing program (ConocoPhillips).</li>
<li><strong>About half the published notes name a listed company.</strong> The rest are not necessarily wrong, because the lists are incomplete. For the global minimum tax rule, Reed named 13 companies beyond the five listed, and many large multinationals do discuss it. These notes need a read by hand before anyone can call them errors.</li>
<li><strong>Notes stay close to their sources.</strong> A judge model found that the quoted filing text supports the note 92% to 100% of the time. The judge is Llama 3.3 70B, which is also one of the models tested, so its own score may be generous.</li>
<li><strong>Mid-size models match the large one.</strong> Mistral Small 24B and Qwen3 30B did as well as Llama 3.3 70B. The 8B model was clearly worse. With 17 actions, a gap of one or two notes between the larger models is noise.</li>
</ol>

<h2>Limits</h2>
<ul>
<li>17 actions is a small set, and each configuration ran once.</li>
<li>The expected lists come from keyword checks on 10-K text, not a full reading, so they miss some exposures.</li>
<li>Two of the 102 companies were not indexed for this run: BNY Mellon and Exxon Mobil.</li>
</ul>

<h2>Next</h2>
<ul>
<li>Grow the set to about 50 actions, and review the notes that name unlisted companies by hand.</li>
<li>Improve search, for example by searching each company's filings separately so a few long filings can't fill all ten slots.</li>
</ul>
<p>Raw results: <a href="https://github.com/aubrey-muscoota/reed/blob/main/eval/results/2026-11-04.jsonl">eval/results/2026-11-04.jsonl</a>. <a href="${base}/method">How Reed works</a> · <a href="${base}">Back to events</a></p>`;
}
