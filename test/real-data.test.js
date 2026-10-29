import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseInstrument, buildSmiles } from '../docs/lib/deribit.js';
import { fitSvi, butterflyCheck, leeWingOk, calendarCheck } from '../docs/lib/svi.js';

const load = c => JSON.parse(readFileSync(new URL(`../docs/data/${c}.json`, import.meta.url)));

test('instrument names parse to 08:00 UTC expiries', () => {
  const p = parseInstrument('BTC-31OCT26-87000-C');
  assert.equal(new Date(p.expiry).toISOString(), '2026-10-31T08:00:00.000Z');
  assert.equal(p.K, 87000);
  assert.equal(p.type, 'C');
  assert.equal(parseInstrument('BTC-1NOV26-86000-P').label, '1NOV26');
  assert.equal(parseInstrument('garbage'), null);
});

for (const cur of ['btc', 'eth']) {
  const snap = load(cur);
  const smiles = buildSmiles(snap.result, snap.meta.fetchedAtMs).filter(s => !s.skipped);

  test(`${cur}: recorded snapshot yields several fit-able expiries`, () => {
    assert.ok(smiles.length >= 5, `only ${smiles.length}`);
  });

  test(`${cur}: our IV from bid/ask mid agrees with Deribit's own mark_iv (median < 1 vol pt)`, () => {
    for (const s of smiles) {
      const d = s.points.filter(p => p.markIv).map(p => Math.abs(p.iv - p.markIv)).sort((a, b) => a - b);
      assert.ok(d[d.length >> 1] < 0.01, `${s.label} median diff ${d[d.length >> 1]}`);
    }
  });

  test(`${cur}: every fitted smile is butterfly-free, inside Lee's bound, RMSE < 1.5 vol pts`, () => {
    for (const s of smiles) {
      const f = fitSvi(s.points.map(p => p.k), s.points.map(p => p.iv), s.T);
      assert.ok(f.rmse < 0.015, `${s.label} rmse ${f.rmse}`);
      assert.ok(leeWingOk(f.params), `${s.label} Lee`);
      const ks = s.points.map(p => p.k);
      const r = butterflyCheck(f.params, Math.min(...ks) - 0.05, Math.max(...ks) + 0.05);
      assert.ok(r.ok, `${s.label} butterfly min g ${r.min}`);
    }
  });
}
