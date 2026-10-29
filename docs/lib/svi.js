// Raw SVI total-variance smile, w(k) = a + b (rho (k - m) + sqrt((k - m)^2 + s^2)),
// with k = ln(K / F) and w = sigma_imp^2 * T. Fit follows the two-step idea of
// Zeliade (2009): for fixed (m, s) the rest is a constrained linear least squares.

export function sviW(p, k) {
  const x = k - p.m;
  return p.a + p.b * (p.rho * x + Math.sqrt(x * x + p.s * p.s));
}

export function sviDeriv(p, k) {
  const x = k - p.m;
  const r = Math.sqrt(x * x + p.s * p.s);
  return { w: p.a + p.b * (p.rho * x + r), w1: p.b * (p.rho + x / r), w2: p.b * p.s * p.s / (r * r * r) };
}

// Gatheral's butterfly density g(k); g >= 0 everywhere means no butterfly arbitrage.
export function butterflyG(p, k) {
  const { w, w1, w2 } = sviDeriv(p, k);
  if (w <= 0) return -Infinity;
  const t = 1 - (k * w1) / (2 * w);
  return t * t - (w1 * w1 / 4) * (1 / w + 0.25) + w2 / 2;
}

// Scan g(k) on a grid; returns the minimum and where it occurs.
export function butterflyCheck(p, kmin, kmax, n = 400) {
  let min = Infinity;
  let at = kmin;
  for (let i = 0; i <= n; i++) {
    const k = kmin + (kmax - kmin) * i / n;
    const g = butterflyG(p, k);
    if (g < min) { min = g; at = k; }
  }
  return { min, at, ok: min >= -1e-9 };
}

// Lee's moment bound for the wings: b (1 + |rho|) <= 4 (total variance form).
export function leeWingOk(p) {
  return p.b * (1 + Math.abs(p.rho)) <= 4;
}

// Calendar check between two fitted slices (earlier, later): w must not fall with maturity.
export function calendarCheck(pEarly, pLate, kmin, kmax, n = 200) {
  let worst = Infinity;
  let at = kmin;
  for (let i = 0; i <= n; i++) {
    const k = kmin + (kmax - kmin) * i / n;
    const d = sviW(pLate, k) - sviW(pEarly, k);
    if (d < worst) { worst = d; at = k; }
  }
  return { worst, at, ok: worst >= -1e-9 };
}

function solve3(A, y) {
  const M = A.map((row, i) => [...row, y[i]]);
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-14) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = c + 1; r < 3; r++) {
      const f = M[r][c] / M[c][c];
      for (let j = c; j < 4; j++) M[r][j] -= f * M[c][j];
    }
  }
  const x = [0, 0, 0];
  for (let r = 2; r >= 0; r--) {
    let s = M[r][3];
    for (let j = r + 1; j < 3; j++) s -= M[r][j] * x[j];
    x[r] = s / M[r][r];
  }
  return x;
}

// Inner step: with (m, s) fixed, w ~ a + d*y + c*sqrt(y^2+1), y = (k-m)/s.
function innerFit(ks, ws, wt, m, s) {
  const n = ks.length;
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const y3 = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const y = (ks[i] - m) / s;
    const f = [1, y, Math.sqrt(y * y + 1)];
    for (let r = 0; r < 3; r++) {
      y3[r] += wt[i] * f[r] * ws[i];
      for (let c = 0; c < 3; c++) A[r][c] += wt[i] * f[r] * f[c];
    }
  }
  let sol = solve3(A, y3) || [Math.min(...ws), 0, 1e-6];
  let [a, d, c] = sol;
  // Constraints: b >= 0, |rho| < 1, minimum variance >= 0.
  c = Math.max(c, 1e-8);
  d = Math.max(-0.999 * c, Math.min(0.999 * c, d));
  // Re-solve a for the clamped (d, c).
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const y = (ks[i] - m) / s;
    num += wt[i] * (ws[i] - d * y - c * Math.sqrt(y * y + 1));
    den += wt[i];
  }
  a = num / den;
  const minVar = a + c * Math.sqrt(1 - (d / c) * (d / c));
  if (minVar < 0) a -= minVar;
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const y = (ks[i] - m) / s;
    const e = a + d * y + c * Math.sqrt(y * y + 1) - ws[i];
    sse += wt[i] * e * e;
  }
  return { a, d, c, sse };
}

function toParams(m, s, inner) {
  const b = inner.c / s;
  return { a: inner.a, b, rho: inner.d / inner.c, m, s };
}

function nelderMead(f, x0, step, iters = 300) {
  const n = x0.length;
  let pts = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const x = x0.slice();
    x[i] += step[i];
    pts.push(x);
  }
  let vals = pts.map(f);
  for (let it = 0; it < iters; it++) {
    const order = vals.map((v, i) => i).sort((i, j) => vals[i] - vals[j]);
    pts = order.map(i => pts[i]);
    vals = order.map(i => vals[i]);
    if (Math.abs(vals[n] - vals[0]) < 1e-16) break;
    const cen = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) cen[j] += pts[i][j] / n;
    const worst = pts[n];
    const refl = cen.map((c, j) => c + (c - worst[j]));
    const fr = f(refl);
    if (fr < vals[0]) {
      const exp = cen.map((c, j) => c + 2 * (c - worst[j]));
      const fe = f(exp);
      if (fe < fr) { pts[n] = exp; vals[n] = fe; } else { pts[n] = refl; vals[n] = fr; }
    } else if (fr < vals[n - 1]) {
      pts[n] = refl; vals[n] = fr;
    } else {
      const con = cen.map((c, j) => c + 0.5 * (worst[j] - c));
      const fc = f(con);
      if (fc < vals[n]) { pts[n] = con; vals[n] = fc; } else {
        for (let i = 1; i <= n; i++) {
          pts[i] = pts[i].map((v, j) => pts[0][j] + 0.5 * (v - pts[0][j]));
          vals[i] = f(pts[i]);
        }
      }
    }
  }
  const best = vals.indexOf(Math.min(...vals));
  return { x: pts[best], f: vals[best] };
}

// Fit one slice. ks: log-moneyness, ivs: implied vols (decimals), T: years.
// Weights are 1 on total variance scaled by 1/(iv^2 T)^2, i.e. roughly relative-variance
// error, so wings are not drowned out by the ATM region.
export function fitSvi(ks, ivs, T) {
  const ws = ivs.map(v => v * v * T);
  const wt = ws.map(w => 1 / (w * w));
  const kmin = Math.min(...ks);
  const kmax = Math.max(...ks);
  const span = Math.max(kmax - kmin, 1e-3);
  let best = null;
  const starts = [];
  for (const mf of [0, 0.25, 0.5, 0.75, 1]) {
    for (const sf of [0.05, 0.15, 0.4]) starts.push([kmin + mf * span, Math.log(sf * span)]);
  }
  for (const x0 of starts) {
    const obj = x => {
      const s = Math.exp(x[1]);
      // Keep the kink inside (a margin around) the data and the wings inside Lee's bound,
      // otherwise the fit can trade a good in-sample error for a meaningless one-wing hyperbola.
      if (s < 1e-3 || s > 2 || x[0] < kmin - 0.25 * span || x[0] > kmax + 0.25 * span) return 1e9;
      const inner = innerFit(ks, ws, wt, x[0], s);
      const p = toParams(x[0], s, inner);
      const lee = p.b * (1 + Math.abs(p.rho));
      return lee > 4 ? inner.sse + 1e3 * (lee - 4) + 1 : inner.sse;
    };
    const r = nelderMead(obj, x0, [0.1 * span, 0.5]);
    if (!best || r.f < best.f) best = r;
  }
  const m = best.x[0];
  const s = Math.exp(best.x[1]);
  const p = toParams(m, s, innerFit(ks, ws, wt, m, s));
  const resid = ks.map((k, i) => Math.sqrt(Math.max(sviW(p, k), 0) / T) - ivs[i]);
  const rmse = Math.sqrt(resid.reduce((q, e) => q + e * e, 0) / resid.length);
  const maxErr = Math.max(...resid.map(Math.abs));
  return { params: p, rmse, maxErr, n: ks.length };
}
