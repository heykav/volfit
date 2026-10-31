// Turns the fitted expiries into the plain-words headline. Every figure is read off the fits.
import { sviW } from './svi.js';

const ivAt = (r, k) => 100 * Math.sqrt(sviW(r.fit.params, k) / r.T);
const median = a => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]); };

export function summarise(rows) {
  const fitted = rows.filter(r => r.fit);
  if (!fitted.length) return null;
  const SK = 0.1; // skew is read at +/-0.10 log-moneyness
  const covers = fitted.filter(r => r.kmin <= -SK && r.kmax >= SK);
  const pool = covers.length ? covers : fitted;
  const pick = pool.reduce((b, r) => (Math.abs(r.days - 30) < Math.abs(b.days - 30) ? r : b));
  const skew = pick.kmin <= -SK && pick.kmax >= SK ? ivAt(pick, -SK) - ivAt(pick, SK) : null;
  const shortRow = fitted.find(r => r.days >= 7) || fitted[0];
  const longRow = fitted[fitted.length - 1];
  const slope = 100 * (longRow.atm - shortRow.atm);
  const term = shortRow === longRow ? 'single' : slope > 1 ? 'rising' : slope < -1 ? 'falling' : 'roughly flat';
  const rm = fitted.map(r => 100 * r.fit.rmse);
  const worst = fitted.reduce((b, r) => (r.fit.rmse > b.fit.rmse ? r : b));
  const passed = fitted.filter(r => r.bf.ok && r.lee && (!r.cal || r.cal.ok)).length;
  return {
    pick, atm: 100 * pick.atm, skew, skewK: SK, shortRow, longRow, slope, term,
    medianRmse: median(rm), worstRmse: 100 * worst.fit.rmse, worstLabel: worst.label,
    passed, total: fitted.length, quotes: fitted.reduce((a, r) => a + r.used, 0),
  };
}

export function headline(asset, s) {
  const days = Math.round(s.pick.days);
  let t = `${asset} options price <b>${s.atm.toFixed(1)}%</b> annualised vol about ${days} days out`;
  if (s.skew !== null) {
    const side = s.skew >= 0 ? 'downside puts' : 'upside calls';
    t += `, with ${side} <b>${Math.abs(s.skew).toFixed(1)} vol points</b> richer than their mirror-image strikes`;
  }
  return t + '.';
}

export function subline(s) {
  const shape = s.term === 'single' ? '' : ` The term structure is ${s.term} from ${s.shortRow.label} (${(100 * s.shortRow.atm).toFixed(1)}%) to ${s.longRow.label} (${(100 * s.longRow.atm).toFixed(1)}%).`;
  return `SVI smiles fitted to ${s.quotes} live quotes across ${s.total} expiries.${shape}`;
}
