// Deribit public option book summaries -> per-expiry smiles ready to fit.
import { impliedVol } from './bs.js';

export const API = 'https://www.deribit.com/api/v2/public/get_book_summary_by_currency';
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
const YEAR_MS = 365 * 86400e3;

// "BTC-31OCT26-87000-C" -> expiry at 08:00 UTC (Deribit's settlement time).
export function parseInstrument(name) {
  const m = /^([A-Z]+)-(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:\.\d+)?)-([CP])$/.exec(name);
  if (!m || !(m[3] in MONTHS)) return null;
  const expiry = Date.UTC(2000 + Number(m[4]), MONTHS[m[3]], Number(m[2]), 8, 0, 0);
  return { base: m[1], expiry, label: `${m[2]}${m[3]}${m[4]}`, K: Number(m[5]), type: m[6] };
}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  const n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2])) : NaN;
}

export async function fetchLive(currency, fetchImpl = fetch) {
  const url = `${API}?currency=${currency}&kind=option`;
  const res = await fetchImpl(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Deribit HTTP ${res.status}`);
  const j = await res.json();
  if (!Array.isArray(j.result) || !j.result.length) throw new Error('Deribit returned no options');
  return { result: j.result, fetchedAtMs: Math.round((j.usOut || j.usIn) / 1000), url, live: true };
}

// Build smiles. Only out-of-the-money quotes with a two-sided market are used,
// and the option price is the bid/ask mid, converted from coin to USD.
export function buildSmiles(summaries, nowMs, opts = {}) {
  const minDays = opts.minDays ?? 2;
  const minPoints = opts.minPoints ?? 7;
  const byExp = new Map();
  for (const s of summaries) {
    const ins = parseInstrument(s.instrument_name);
    if (!ins) continue;
    if (!byExp.has(ins.expiry)) byExp.set(ins.expiry, { ins, rows: [] });
    byExp.get(ins.expiry).rows.push({ ins, s });
  }
  const out = [];
  for (const [expiry, { ins, rows }] of [...byExp].sort((a, b) => a[0] - b[0])) {
    const T = (expiry - nowMs) / YEAR_MS;
    const entry = { expiry, label: ins.label, T, days: T * 365, F: NaN, points: [], used: 0, listed: rows.length, skipped: null };
    entry.F = median(rows.map(r => r.s.underlying_price).filter(x => x > 0));
    if (T * 365 < minDays) { entry.skipped = `under ${minDays} days to expiry`; out.push(entry); continue; }
    for (const { ins: i, s } of rows) {
      const otm = i.type === 'C' ? i.K >= entry.F : i.K < entry.F;
      if (!otm) continue;
      const bid = s.bid_price, ask = s.ask_price;
      if (!(bid > 0) || !(ask > 0) || ask > 3 * bid) continue;
      const mid = 0.5 * (bid + ask);
      const iv = impliedVol(mid * s.underlying_price, entry.F, i.K, T, i.type);
      if (iv === null || iv > 5) continue;
      entry.points.push({
        K: i.K, k: Math.log(i.K / entry.F), iv, type: i.type, bid, ask,
        markIv: s.mark_iv > 0 ? s.mark_iv / 100 : null, oi: s.open_interest ?? 0,
      });
    }
    entry.points.sort((a, b) => a.k - b.k);
    entry.used = entry.points.length;
    if (entry.used < minPoints) entry.skipped = `only ${entry.used} usable quotes`;
    out.push(entry);
  }
  return out;
}
