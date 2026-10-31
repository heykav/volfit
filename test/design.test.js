import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../docs/styles.css', import.meta.url), 'utf8');
const rootBlock = css.match(/:root\{([\s\S]*?)\n\}/)[1];
const rest = css.replace(/:root\{[\s\S]*?\n\}/, '');
const tok = {};
for (const m of rootBlock.matchAll(/--c-([a-z-]+):(#[0-9A-Fa-f]{6})/g)) tok[m[1]] = m[2];

const lum = hex => {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('text and status colours meet WCAG AA (4.5:1) on every surface they sit on', () => {
  for (const bg of ['bg', 'surface', 'raised']) {
    for (const fg of ['text', 'muted', 'accent', 'select', 'warn', 'bad']) {
      assert.ok(ratio(tok[fg], tok[bg]) >= 4.5, `${fg} on ${bg}: ${ratio(tok[fg], tok[bg]).toFixed(2)}`);
    }
  }
});

test('dark text on the accent fills (buttons, active chips) meets AA', () => {
  for (const fill of ['accent', 'select']) assert.ok(ratio(tok['on-accent'], tok[fill]) >= 4.5, fill);
});

test('token block defines colour, type, space and motion scales', () => {
  for (const name of ['--c-bg', '--t-md', '--t-h1', '--s-4', '--d-base', '--e-out', '--f-mono']) assert.ok(rootBlock.includes(name), name);
});

test('everything below the token block uses tokens: no raw hex colours, no raw font sizes, no raw durations', () => {
  const sans = rest.replace(/\/\*[\s\S]*?\*\//g, '');
  const hex = sans.match(/#[0-9A-Fa-f]{3,8}\b/g) || [];
  assert.deepEqual(hex.filter(h => h.toLowerCase() !== '#0b2a17'), [], 'raw hex colours');
  assert.deepEqual(sans.match(/font-size:\s*[\d.]+px/g) || [], [], 'raw font-size');
  assert.deepEqual(sans.match(/rgba?\(/g) || [], [], 'raw rgb()');
  assert.deepEqual(sans.match(/[:\s,]\d+(\.\d+)?m?s\b(?!\))/g)?.filter(x => !/\.001ms|1\.4s|2s|1s/.test(x)) || [], [], 'raw durations');
});

test('stylesheet honours prefers-reduced-motion', () => {
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)/);
});
