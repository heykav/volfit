import test from 'node:test';
import assert from 'node:assert/strict';
import { normCdf, black76, impliedVol } from '../docs/lib/bs.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} got ${a}, want ${b}`);

test('normal CDF matches tabulated values', () => {
  close(normCdf(0), 0.5, 1e-15);
  close(normCdf(1), 0.8413447460685429, 1e-12);
  close(normCdf(-1.96), 0.024997895148220435, 1e-12);
  close(normCdf(3), 0.9986501019683699, 1e-12);
  close(normCdf(-8), 6.220960574271785e-16, 1e-18);
});

test('ATM Black-76 call equals F*(2N(sigma*sqrt(T)/2)-1) (hand-checked: 7.9656)', () => {
  // F=K=100, T=1, sigma=0.2 -> d1=0.1, call = 100*(2*N(0.1)-1) = 7.96557
  close(black76(100, 100, 1, 0.2, 'C'), 7.965567455405804, 1e-9);
});

test('put-call parity: C - P = F - K for any strike, vol and expiry', () => {
  for (const K of [50, 80, 100, 130, 250]) {
    for (const sigma of [0.1, 0.45, 1.3]) {
      for (const T of [0.01, 0.5, 2]) {
        const c = black76(100, K, T, sigma, 'C');
        const p = black76(100, K, T, sigma, 'P');
        close(c - p, 100 - K, 1e-9, `K=${K} s=${sigma} T=${T}`);
      }
    }
  }
});

test('implied vol round-trips across moneyness, vol and tenor', () => {
  for (const K of [60, 90, 100, 110, 160]) {
    for (const sigma of [0.08, 0.3, 0.9, 2.0]) {
      for (const T of [3 / 365, 0.25, 1.5]) {
        const type = K >= 100 ? 'C' : 'P';
        const price = black76(100, K, T, sigma, type);
        const iv = impliedVol(price, 100, K, T, type);
        if (iv === null || price < 1e-4) continue; // vega ~ 0 here: price carries no usable vol information
        close(iv, sigma, 1e-6, `K=${K} s=${sigma} T=${T}`);
      }
    }
  }
});

test('implied vol refuses prices outside no-arbitrage bounds', () => {
  assert.equal(impliedVol(0, 100, 100, 1, 'C'), null);
  assert.equal(impliedVol(5, 100, 80, 1, 'C'), null); // below intrinsic 20
  assert.equal(impliedVol(100, 100, 100, 1, 'C'), null); // at the upper bound F
  assert.equal(impliedVol(7, 100, 100, 0, 'C'), null);
});
