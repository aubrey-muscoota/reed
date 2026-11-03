import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, extractSection, chunk } from '../lib/text.mjs';

const filing = `<html><head><style>p{}</style></head><body>
<ix:header><ix:hidden>junk</ix:hidden></ix:header>
<table><tr><td>Item 1A.</td><td>Risk Factors</td><td>12</td></tr><tr><td>Item 1B.</td><td>Unresolved Staff Comments</td></tr></table>
<p>Item 1. Business</p><p>We sell widgets.</p>
<p><b>Item 1A. Risk Factors</b></p>
<p>Tariffs on imports from China could raise our costs &amp; reduce margins.</p>
<p>Export controls could limit sales of our chips.</p>
<p>Item 1B. Unresolved Staff Comments</p><p>None.</p>
<p>Item 2. Properties</p></body></html>`;

test('htmlToText strips tags, styles and XBRL headers, decodes entities', () => {
  const t = htmlToText(filing);
  assert.ok(!t.includes('junk'));
  assert.ok(!t.includes('p{}'));
  assert.ok(t.includes('costs & reduce'));
});

test('extractSection skips the table of contents and takes the real section', () => {
  const s = extractSection(htmlToText(filing));
  assert.ok(s.startsWith('Item 1A. Risk Factors'));
  assert.ok(s.includes('Export controls'));
  assert.ok(!s.includes('None.'));
});

test('extractSection handles a 10-K with Item 1C before Item 2', () => {
  const t = 'Item 1A. Risk Factors\nRisk text here.\nItem 1C. Cybersecurity\nWe have a program.';
  assert.equal(extractSection(t), 'Item 1A. Risk Factors\nRisk text here.');
});

test('extractSection returns empty when absent', () => {
  assert.equal(extractSection('no such heading'), '');
});

test('chunk makes overlapping passages of bounded size and keeps all text', () => {
  const paras = Array.from({ length: 30 }, (_, i) => Array.from({ length: 50 }, (_, j) => `w${i}_${j}`).join(' ')).join('\n');
  const parts = chunk(paras, { size: 200, overlap: 20, min: 40 });
  assert.ok(parts.length >= 7);
  for (const p of parts) assert.ok(p.split(' ').length <= 300);
  assert.ok(parts[0].startsWith('w0_0'));
  assert.ok(parts.at(-1).endsWith('w29_49'));
});

test('chunk keeps a short section as one passage', () => {
  assert.deepEqual(chunk('just a few words'), ['just a few words']);
});

const body = Array.from({ length: 80 }, (_, i) => `Risk paragraph ${i} about export controls and supply chains in many markets.`).join('\n');

test('extractSection ignores mid-sentence cross-references that run to the end', () => {
  const t = `Item 1A. Risk Factors\nItem 1B. Unresolved Staff Comments\nItem 1. Business\nSee Item 1A. Risk Factors\nItem 1A. Risk Factors\n${body}\nItem 1B. Unresolved Staff Comments\nNone.\nItem 7. MD&A\nAs discussed in "Item 1A. Risk Factors," our results vary.\n${'Long MD&A text. '.repeat(2000)}`;
  const s = extractSection(t);
  assert.ok(s.startsWith('Item 1A. Risk Factors\nRisk paragraph 0'));
  assert.ok(!s.includes('MD&A'));
});

test('extractSection falls back to a bare Risk Factors heading', () => {
  const t = `Item 1A\nPages 37 - 51\nRisk Factors\n${body}\nUnresolved Staff Comments\nNone.`;
  const s = extractSection(t);
  assert.ok(s.startsWith('Risk Factors'));
  assert.ok(s.includes('Risk paragraph 79'));
  assert.ok(!s.includes('None.'));
});

test('extractSection uses repeated "Item 1A" page headers when the heading is odd', () => {
  const t = `Item 1A.\n\nRisk Factors\n\n14\n\nItem 1B.\n\nUnresolved\n\nPart I\nItem 1A\n${body}\nPart I\nItem 1A\nMore risks.\nItem 1B. Unresolved Staff Comments\nNone.`;
  const s = extractSection(t);
  assert.ok(s.includes('Risk paragraph 79') && s.includes('More risks.'));
  assert.ok(!s.includes('None.'));
});

test('extractSection accepts an inline "Risk Factors." heading', () => {
  const t = `Cybersecurity\n23\nRisk factors\n24\nLegal proceedings\n31\nRisk factors. The following discussion covers risks.\n${body}\nLegal proceedings\nNone.`;
  const s = extractSection(t);
  assert.ok(s.startsWith('Risk factors. The following'));
  assert.ok(!s.includes('None.'));
});
