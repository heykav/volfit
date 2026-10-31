// Builds smiles from the raw book, fits each expiry and runs the no-arbitrage checks.
import { buildSmiles } from './deribit.js';
import { fitSvi, sviW, butterflyCheck, leeWingOk, calendarCheck } from './svi.js';

export function analyse(result, nowMs) {
  const smiles = buildSmiles(result, nowMs);
  const rows = smiles.map(s => {
    if (s.skipped) return { ...s, fit: null };
    const ks = s.points.map(p => p.k);
    const fit = fitSvi(ks, s.points.map(p => p.iv), s.T);
    const kmin = Math.min(...ks), kmax = Math.max(...ks);
    const bf = butterflyCheck(fit.params, kmin - 0.05, kmax + 0.05);
    const diffs = s.points.filter(p => p.markIv).map(p => Math.abs(p.iv - p.markIv)).sort((a, b) => a - b);
    return {
      ...s, fit, kmin, kmax, bf, lee: leeWingOk(fit.params),
      atm: Math.sqrt(sviW(fit.params, 0) / s.T), markDiff: diffs.length ? diffs[diffs.length >> 1] : null,
    };
  });
  const fitted = rows.filter(r => r.fit);
  for (let i = 1; i < fitted.length; i++) {
    const lo = Math.max(fitted[i - 1].kmin, fitted[i].kmin);
    const hi = Math.min(fitted[i - 1].kmax, fitted[i].kmax);
    fitted[i].cal = hi > lo ? calendarCheck(fitted[i - 1].fit.params, fitted[i].fit.params, lo, hi) : null;
  }
  return rows;
}
