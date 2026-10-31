import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyse } from '../docs/lib/analyse.js';
import { summarise, headline } from '../docs/lib/summary.js';

for (const cur of ['btc', 'eth']) {
  const snap = JSON.parse(readFileSync(new URL(`../docs/data/${cur}.json`, import.meta.url)));
  const rows = analyse(snap.result, snap.meta.fetchedAtMs);
  const s = summarise(rows);

  test(`${cur}: headline figures are read straight off the fits`, () => {
    assert.ok(s.atm > 5 && s.atm < 300);
    assert.equal(Math.round(s.atm * 1000) / 1000, Math.round(100 * s.pick.atm * 1000) / 1000);
    assert.ok(Math.abs(s.pick.days - 30) <= Math.min(...rows.filter(r => r.fit && r.kmin <= -0.1 && r.kmax >= 0.1).map(r => Math.abs(r.days - 30))) + 1e-9);
    assert.ok(s.total === rows.filter(r => r.fit).length && s.passed <= s.total);
    assert.ok(s.medianRmse <= s.worstRmse);
    assert.match(headline(cur.toUpperCase(), s), new RegExp(`${cur.toUpperCase()} options price <b>${s.atm.toFixed(1)}%</b>`));
  });
}
