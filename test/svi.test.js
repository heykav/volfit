import test from 'node:test';
import assert from 'node:assert/strict';
import { sviW, butterflyG, butterflyCheck, calendarCheck, leeWingOk, fitSvi } from '../docs/lib/svi.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} got ${a}, want ${b}`);
const P = { a: 0.04, b: 0.4, rho: -0.4, m: 0, s: 0.1 };

test('SVI total variance at k=m is a + b*s (hand-checked: 0.08)', () => {
  close(sviW(P, 0), 0.08, 1e-15);
});

test('butterfly density g(k) matches the finite-difference definition', () => {
  const k = 0.13, h = 1e-4;
  const w = x => sviW(P, x);
  const w1 = (w(k + h) - w(k - h)) / (2 * h);
  const w2 = (w(k + h) - 2 * w(k) + w(k - h)) / (h * h);
  const t = 1 - k * w1 / (2 * w(k));
  const g = t * t - (w1 * w1 / 4) * (1 / w(k) + 0.25) + w2 / 2;
  close(butterflyG(P, k), g, 1e-5);
});

test('benign parameters pass the butterfly check', () => {
  const r = butterflyCheck(P, -1, 1);
  assert.ok(r.ok, `min g = ${r.min}`);
});

test('a known-bad parameter set is flagged (Gatheral-Jacquier raw SVI example)', () => {
  const bad = { a: -0.041, b: 0.1331, rho: 0.306, m: 0.3586, s: 0.4153 };
  const r = butterflyCheck(bad, -1.5, 1.5);
  assert.ok(!r.ok && r.min < 0, `min g = ${r.min}`);
});

test('calendar check: scaling total variance up with maturity passes, down fails', () => {
  const later = { ...P, a: P.a * 2, b: P.b * 2 };
  assert.ok(calendarCheck(P, later, -1, 1).ok);
  assert.ok(!calendarCheck(later, P, -1, 1).ok);
});

test('Lee wing bound', () => {
  assert.ok(leeWingOk(P));
  assert.ok(!leeWingOk({ ...P, b: 3, rho: 0.5 }));
});

test('fit recovers synthetic SVI parameters from noiseless data', () => {
  const T = 0.25;
  const ks = Array.from({ length: 31 }, (_, i) => -0.6 + i * 0.04);
  const ivs = ks.map(k => Math.sqrt(sviW(P, k) / T));
  const f = fitSvi(ks, ivs, T);
  assert.ok(f.rmse < 1e-5, `rmse ${f.rmse}`);
  for (const k of [-0.5, -0.1, 0, 0.2, 0.5]) close(sviW(f.params, k), sviW(P, k), 1e-4);
});

test('fit stays close under small deterministic noise and reports an honest RMSE', () => {
  const T = 0.5;
  const ks = Array.from({ length: 25 }, (_, i) => -0.5 + i * 0.045);
  const ivs = ks.map((k, i) => Math.sqrt(sviW(P, k) / T) + 0.002 * Math.sin(7 * i));
  const f = fitSvi(ks, ivs, T);
  assert.ok(f.rmse > 0.0005 && f.rmse < 0.003, `rmse ${f.rmse}`);
  assert.ok(butterflyCheck(f.params, -0.6, 0.7).ok);
});
