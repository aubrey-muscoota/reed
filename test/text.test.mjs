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
