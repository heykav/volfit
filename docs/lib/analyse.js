// Builds smiles from the raw book, fits each expiry and runs the no-arbitrage checks.
import { buildSmiles } from './deribit.js';
import { fitSvi, sviW, butterflyCheck, leeWingOk, calendarCheck } from './svi.js';

// Display rule (documented in the README): expiries with fewer than this many days to expiry are still
// fitted, checked and listed in the table, but are not drawn on the 3D sheet or the term-structure line.
// Reason: they are quoted over a narrow strike window with a very steep smile, so the sheet's front edge
// would be a handful of wing quotes rather than a surface.
export const SURFACE_MIN_DAYS = 7;
export const surfaceReason = r => (r.days < SURFACE_MIN_DAYS ? `under ${SURFACE_MIN_DAYS} days to expiry` : null);
// SVI width at the edge of the allowed range means the bound, not the data, set that parameter.
export const widthAtBound = p => p.s >= 1.98 || p.s <= 0.0011;

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
      onSurface: surfaceReason({ days: s.days }) === null, surfaceReason: surfaceReason({ days: s.days }), atBound: widthAtBound(fit.params),
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
