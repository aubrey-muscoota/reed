// Ask open vision models on Workers AI to read each site's yearly Sentinel-2
// images and say when construction first shows. Compares their answer with
// the pixel measurement in sites/results/results.json and with the year the
// filing gives. The model sees only the dated images, not our measurement or
// the claim's year. Writes sites/results/judge.json and judge.md.
//
//   node scripts/sites-judge.mjs [--models a,b] [--only id1,id2]

import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { cloudflare, parseJson } from '../lib/cf.mjs';

const { values: args } = parseArgs({ options: {
  models: { type: 'string', default: process.env.SITES_MODELS ?? '@cf/meta/llama-4-scout-17b-16e-instruct,@cf/mistralai/mistral-small-3.1-24b-instruct' },
  only: { type: 'string' },
} });
const root = new URL('../sites/', import.meta.url);
let { claims } = JSON.parse(await readFile(new URL('claims.json', root), 'utf8'));
if (args.only) claims = claims.filter(c => args.only.split(',').includes(c.id));
const measured = Object.fromEntries(JSON.parse(await readFile(new URL('results/results.json', root), 'utf8')).results.map(r => [r.id, r]));
const cf = cloudflare();

function prompt(c, years) {
  return `These are Sentinel-2 satellite images (10 m pixels, true color, north up) of the same ${2 * (c.half_km ?? 1)} km square, one per year, with the image date above each: ${years.join(', ')}.
The square is centered on: ${c.site}.
Compare each image with the first one. Say in which image construction first becomes visible: cleared or graded ground, new pads, roads, tanks or buildings that stay in later images. Ignore changes that come and go, such as crops, clouds, haze and seasonal color.
Answer with JSON only: {"first_visible": "<date of that image, or null if none>", "built_by_last": true|false, "reason": "<one sentence on what you see>"}`;
}

const rows = [];
for (const c of claims) {
  const m = measured[c.id];
  if (!m?.snapshots) continue;
  const dates = m.snapshots.map(s => `${s.date.slice(0, 4)}-${s.date.slice(4, 6)}-${s.date.slice(6)}`);
  const jpg = await readFile(new URL(`results/plain/${c.id}.jpg`, root));
  const image = `data:image/jpeg;base64,${jpg.toString('base64')}`;
  for (const model of args.models.split(',')) {
    let answer, error;
    try {
      const text = await cf.chat(model, [
        { role: 'system', content: 'You read satellite images carefully. Reply with one JSON object and nothing else.' },
        { role: 'user', content: [
        { type: 'text', text: prompt(c, dates) },
        { type: 'image_url', image_url: { url: image } },
      ] }], { max_tokens: 800 });
      answer = parseJson(text);
    } catch (e) { error = e.message; }
    const year = answer?.first_visible ? Number(String(answer.first_visible).slice(0, 4)) : null;
    const pixel = m.first_visible ? Number(m.first_visible.slice(0, 4)) : null;
    rows.push({ id: c.id, model, answer, error,
      agrees_with_pixels: error ? null : year === pixel,
      within_a_year_of_filing: error || year == null ? null : Math.abs(year - c.claim_year) <= 1 });
    console.error(`${c.id} ${model}: ${error ?? JSON.stringify(answer)}`);
  }
}

await writeFile(new URL('results/judge.json', root), JSON.stringify({ generated: new Date().toISOString().slice(0, 10), rows }, null, 1) + '\n');
const md = ['# Model check', '', 'Each model saw only the dated yearly images for a site and was asked when construction first shows.', '',
  '| Site | Model | First visible (model) | First visible (pixels) | Filing year | Model reason |', '| --- | --- | --- | --- | --- | --- |'];
for (const r of rows) {
  const c = claims.find(x => x.id === r.id);
  const px = measured[r.id].first_visible;
  md.push(`| ${c.site} | ${r.model.split('/').pop()} | ${r.error ? 'error' : r.answer?.first_visible ?? 'none'} | ${px ? `${px.slice(0, 4)}-${px.slice(4, 6)}-${px.slice(6)}` : 'none'} | ${c.claim_year} | ${(r.error ?? r.answer?.reason ?? '').replace(/\|/g, '/').slice(0, 200)} |`);
}
for (const model of args.models.split(',')) {
  const mine = rows.filter(r => r.model === model && !r.error);
  md.push('', `${model}: agrees with pixels on ${mine.filter(r => r.agrees_with_pixels).length}/${mine.length}; within a year of the filing on ${mine.filter(r => r.within_a_year_of_filing).length}/${mine.length}.`);
}
await writeFile(new URL('results/judge.md', root), md.join('\n') + '\n');
console.log(md.join('\n'));
