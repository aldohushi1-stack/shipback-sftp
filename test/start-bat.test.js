'use strict';
// start.bat is what gets double-clicked. If cmd hits a syntax error it kills the window
// before any `pause`, so the failure is invisible ("black box opens, closes").
// cmd parses a whole ( ... ) block before running it, and a bare ")" inside echo text
// closes the block early — so one stray bracket breaks every run, even when the IF is false.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BAT_FILE = process.env.START_BAT || path.join(__dirname, '..', 'start.bat');
const BAT = fs.readFileSync(BAT_FILE, 'utf8');
const LINES = BAT.split(/\r?\n/);

// Drop ^-escaped characters and quoted strings — cmd treats both as literal text.
const strip = line => line.replace(/\^./g, '').replace(/"[^"]*"/g, '""');
const isComment = line => /^\s*(@?rem\b|::)/i.test(line);

test('start.bat uses CRLF line endings', () => {
  const raw = BAT.split('\n').slice(0, -1);
  assert.ok(raw.length > 0, 'start.bat is empty');
  raw.forEach((l, i) => assert.ok(l.endsWith('\r'), `line ${i + 1} ends in LF only`));
});

test('every ( ... ) block opens and closes on the same line', () => {
  LINES.forEach((raw, i) => {
    if (isComment(raw)) return;
    let depth = 0;
    for (const ch of strip(raw)) {
      if (ch === '(') depth++;
      if (ch === ')') { depth--; assert.ok(depth >= 0, `line ${i + 1}: ")" with no matching "(" — ${raw.trim()}`); }
    }
    assert.equal(depth, 0, `line ${i + 1} opens a multi-line block (use goto instead) — ${raw.trim()}`);
  });
});

test('echo text contains no bare brackets', () => {
  LINES.forEach((raw, i) => {
    if (isComment(raw)) return;
    const segments = strip(raw).split(/&&|&|\|\||\|/);
    segments.forEach((seg, j) => {
      const m = seg.match(/^\s*\(?\s*@?echo(?=[\s.:])(.*)$/i);
      if (!m) return;
      let text = m[1];
      if (j === segments.length - 1) text = text.replace(/\)\s*$/, ''); // the bracket that closes a one-line block
      assert.ok(!/[()]/.test(text), `line ${i + 1}: bracket in echo text breaks cmd parsing (escape as ^( ^) or drop it) — ${raw.trim()}`);
    });
  });
});
