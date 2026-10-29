// Black-76 (Black-Scholes on a forward) and an implied-vol solver.
// Prices are undiscounted: on Deribit the premium is paid in the coin and
// the forward already carries the cost of carry, so no rate input is needed.

// Standard normal CDF, Hart (1968) rational approximation, ~1e-15 absolute error.
export function normCdf(x) {
  const xa = Math.abs(x);
  let c;
  if (xa > 37) {
    c = 0;
  } else {
    const e = Math.exp(-xa * xa / 2);
    if (xa < 7.07106781186547) {
      let b = 0.0352624965998911 * xa + 0.700383064443688;
      b = b * xa + 6.37396220353165;
      b = b * xa + 33.912866078383;
      b = b * xa + 112.079291497871;
      b = b * xa + 221.213596169931;
      b = b * xa + 220.206867912376;
      c = e * b;
      b = 0.0883883476483184 * xa + 1.75566716318264;
      b = b * xa + 16.064177579207;
      b = b * xa + 86.7807322029461;
      b = b * xa + 296.564248779674;
      b = b * xa + 637.333633378831;
      b = b * xa + 793.826512519948;
      b = b * xa + 440.413735824752;
      c = c / b;
    } else {
      let b = xa + 0.65;
      b = xa + 4 / b;
      b = xa + 3 / b;
      b = xa + 2 / b;
      b = xa + 1 / b;
      c = e / b / 2.506628274631;
    }
  }
  return x > 0 ? 1 - c : c;
}

export function normPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

// Undiscounted Black-76 price. type: 'C' or 'P'.
export function black76(F, K, T, sigma, type) {
  const intrinsic = type === 'C' ? Math.max(F - K, 0) : Math.max(K - F, 0);
  if (T <= 0 || sigma <= 0) return intrinsic;
  const sd = sigma * Math.sqrt(T);
  const d1 = (Math.log(F / K) + 0.5 * sd * sd) / sd;
  const d2 = d1 - sd;
  return type === 'C'
    ? F * normCdf(d1) - K * normCdf(d2)
    : K * normCdf(-d2) - F * normCdf(-d1);
}

export function vega76(F, K, T, sigma) {
  const sd = sigma * Math.sqrt(T);
  const d1 = (Math.log(F / K) + 0.5 * sd * sd) / sd;
  return F * normPdf(d1) * Math.sqrt(T);
}

// Implied vol by bracketed Newton with bisection fallback.
// Returns null when the price is outside the no-arbitrage bounds.
export function impliedVol(price, F, K, T, type, tol = 1e-10) {
  if (!(price > 0) || !(T > 0) || !(F > 0) || !(K > 0)) return null;
  const intrinsic = type === 'C' ? Math.max(F - K, 0) : Math.max(K - F, 0);
  const upper = type === 'C' ? F : K;
  if (price <= intrinsic + 1e-14 || price >= upper) return null;
  let lo = 1e-4;
  let hi = 10;
  if (black76(F, K, T, hi, type) < price) return null;
  let s = 0.5;
  for (let i = 0; i < 100; i++) {
    const diff = black76(F, K, T, s, type) - price;
    if (Math.abs(diff) < tol * 1e-3 * F) return s;
    if (diff > 0) hi = s; else lo = s;
    const v = vega76(F, K, T, s);
    let next = v > 1e-12 ? s - diff / v : NaN;
    if (!(next > lo && next < hi)) next = 0.5 * (lo + hi);
    s = next;
  }
  return Math.abs(black76(F, K, T, s, type) - price) < 1e-8 * F ? s : null;
}
