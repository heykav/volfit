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

import { SURFACE_MIN_DAYS, surfaceReason, widthAtBound } from '../docs/lib/analyse.js';

for (const cur of ['btc', 'eth']) {
  test(`${cur}: expiries under ${SURFACE_MIN_DAYS} days stay fitted and listed but are marked not shown on the surface`, () => {
    const snap = JSON.parse(readFileSync(new URL(`../docs/data/${cur}.json`, import.meta.url)));
    const rows = analyse(snap.result, snap.meta.fetchedAtMs).filter(r => r.fit);
    const short = rows.filter(r => r.days < SURFACE_MIN_DAYS);
    assert.ok(short.length >= 1, 'snapshot has short-dated expiries');
    for (const r of rows) {
      assert.equal(r.onSurface, r.days >= SURFACE_MIN_DAYS);
      assert.equal(r.surfaceReason, r.onSurface ? null : `under ${SURFACE_MIN_DAYS} days to expiry`);
      assert.ok(Number.isFinite(r.fit.rmse) && r.bf && typeof r.lee === 'boolean', 'metrics are kept for every fitted expiry');
    }
    assert.ok(rows.some(r => r.onSurface));
  });
}

test('rule helpers: boundary at exactly 7 days, and bound detection', () => {
  assert.equal(surfaceReason({ days: 6.99 }), 'under 7 days to expiry');
  assert.equal(surfaceReason({ days: 7 }), null);
  assert.ok(widthAtBound({ s: 2 }) && widthAtBound({ s: 0.001 }) && !widthAtBound({ s: 0.3 }));
});
