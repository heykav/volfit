import { fetchLive, buildSmiles } from './lib/deribit.js';
import { fitSvi, sviW, butterflyCheck, leeWingOk, calendarCheck } from './lib/svi.js';

const $ = id => document.getElementById(id);
const FONT = { family: '"DejaVu Sans Mono", monospace', color: '#d7e3d7', size: 11 };
const state = { data: null, rows: [], sel: 0 };

function setBanner(cls, text) {
  const b = $('banner');
  b.className = 'banner ' + cls;
  b.textContent = text;
}

async function getData(cur, forceSnapshot) {
  if (!forceSnapshot) {
    try {
      const live = await fetchLive(cur);
      return { ...live, source: 'live' };
    } catch (e) {
      state.liveError = String(e.message || e);
    }
  }
  const res = await fetch(`data/${cur.toLowerCase()}.json`);
  if (!res.ok) throw new Error('snapshot missing');
  const s = await res.json();
  return { result: s.result, fetchedAtMs: s.meta.fetchedAtMs, url: s.meta.url, source: 'snapshot', meta: s.meta };
}

function analyse(data) {
  const smiles = buildSmiles(data.result, data.fetchedAtMs);
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

const pct = (x, d = 2) => (x * 100).toFixed(d);
const utc = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

function renderProv(data, rows) {
  const used = rows.reduce((a, r) => a + (r.fit ? r.used : 0), 0);
  const items = [
    ['source', 'Deribit public API, get_book_summary_by_currency'],
    ['request', data.url],
    ['data time', utc(data.fetchedAtMs) + (data.source === 'snapshot' ? ' (stored snapshot)' : ' (server clock at response)')],
    ['instruments', `${data.result.length} listed, ${used} usable OTM two-sided quotes across ${rows.filter(r => r.fit).length} fitted expiries`],
    ['method', 'IV: Black-76 on per-expiry forward from bid/ask mid. Fit: raw SVI, least squares in total variance.'],
  ];
  $('prov').innerHTML = items.map(([k, v]) => `<dt>${k}</dt><dd></dd>`).join('');
  [...$('prov').querySelectorAll('dd')].forEach((d, i) => { d.textContent = items[i][1]; });
}

function renderTable(rows) {
  const t = $('report');
  const head = '<thead><tr><th>expiry</th><th>days</th><th>forward</th><th>quotes</th><th>ATM IV %</th><th>RMSE (vol pts)</th><th>max err</th><th>vs Deribit mark (median)</th><th>butterfly min g</th><th>Lee wing</th><th>calendar vs prev</th></tr></thead>';
  const body = rows.map((r, i) => {
    if (!r.fit) return `<tr data-i="${i}" class="dim"><td>${r.label}</td><td>${r.days.toFixed(1)}</td><td>${Math.round(r.F)}</td><td>${r.used}</td><td colspan="7" style="text-align:left">not fitted: ${r.skipped}</td></tr>`;
    const cal = r.cal === undefined ? '<span class="dim">first</span>' : r.cal === null ? '<span class="dim">no overlap</span>'
      : r.cal.ok ? '<span class="ok">pass</span>' : `<span class="no">fail (${(r.cal.worst).toExponential(1)})</span>`;
    return `<tr data-i="${i}"><td>${r.label}</td><td>${r.days.toFixed(1)}</td><td>${Math.round(r.F)}</td><td>${r.used}</td>` +
      `<td>${pct(r.atm)}</td><td>${pct(r.fit.rmse, 3)}</td><td>${pct(r.fit.maxErr, 2)}</td><td>${r.markDiff === null ? 'n/a' : pct(r.markDiff, 2)}</td>` +
      `<td class="${r.bf.ok ? 'ok' : 'no'}">${r.bf.min.toFixed(3)}</td><td class="${r.lee ? 'ok' : 'no'}">${r.lee ? 'pass' : 'fail'}</td><td>${cal}</td></tr>`;
  }).join('');
  t.innerHTML = head + '<tbody>' + body + '</tbody>';
  t.querySelectorAll('tbody tr').forEach(tr => tr.addEventListener('click', () => {
    const i = Number(tr.dataset.i);
    if (rows[i].fit) selectExpiry(i);
  }));
  const bad = rows.filter(r => r.fit && (!r.bf.ok || !r.lee || (r.cal && !r.cal.ok))).length;
  $('calendar').textContent = `Butterfly g is Gatheral's density condition scanned on 400 points over the quoted strike range plus 0.05 log-moneyness either side (must be >= 0). Calendar compares total variance of adjacent expiries over the range both trade. Expiries flagged: ${bad}. "vs Deribit mark" is the median absolute gap between our mid-based IV and Deribit's own mark_iv, in vol points.`;
}

function renderSurface(rows) {
  const fitted = rows.filter(r => r.fit);
  if (!fitted.length) { $('surface').textContent = 'No expiry had enough two-sided quotes to fit.'; return; }
  const KCLIP = 0.5; // 3D view only: short-dated wings beyond this dominate the z-axis
  const gmin = Math.max(-KCLIP, Math.min(...fitted.map(r => r.kmin))), gmax = Math.min(KCLIP, Math.max(...fitted.map(r => r.kmax)));
  const N = 60;
  const kg = Array.from({ length: N + 1 }, (_, i) => gmin + (gmax - gmin) * i / N);
  const z = fitted.map(r => kg.map(k => (k >= r.kmin && k <= r.kmax) ? 100 * Math.sqrt(sviW(r.fit.params, k) / r.T) : null));
  const yi = fitted.map((_, i) => i);
  const surf = {
    type: 'surface', x: kg, y: yi, z, opacity: 0.85, showscale: false, connectgaps: false,
    colorscale: [[0, '#0b2a17'], [0.5, '#00c24e'], [1, '#B6FF2E']],
    hovertemplate: 'k=%{x:.3f}<br>IV %{z:.1f}%<extra></extra>',
  };
  const px = [], py = [], pz = [], ptxt = [];
  fitted.forEach((r, i) => r.points.filter(p => Math.abs(p.k) <= KCLIP).forEach(p => { px.push(p.k); py.push(i); pz.push(100 * p.iv); ptxt.push(`${r.label} K=${p.K} ${p.type}`); }));
  const pts = { type: 'scatter3d', mode: 'markers', x: px, y: py, z: pz, text: ptxt, hovertemplate: '%{text}<br>IV %{z:.1f}%<extra></extra>', marker: { size: 2.2, color: '#ffffff', opacity: 0.9 } };
  const ax = (title, extra) => ({ title, color: '#7d8b7d', gridcolor: '#1f261f', zerolinecolor: '#1f261f', backgroundcolor: '#090A09', showbackground: true, ...extra });
  Plotly.react('surface', [surf, pts], {
    paper_bgcolor: 'rgba(0,0,0,0)', font: FONT, margin: { l: 0, r: 0, t: 0, b: 0 },
    scene: {
      xaxis: ax('log-moneyness ln(K/F)'), yaxis: ax('expiry', { tickvals: yi, ticktext: fitted.map(r => r.label) }),
      zaxis: ax('implied vol %'), camera: { eye: { x: 1.7, y: -1.7, z: 0.9 } },
    },
  }, { responsive: true, displaylogo: false });
}

function renderSmile() {
  const r = state.rows[state.sel];
  if (!r || !r.fit) return;
  const kk = Array.from({ length: 121 }, (_, i) => r.kmin - 0.05 + (r.kmax - r.kmin + 0.1) * i / 120);
  const fitTrace = { x: kk, y: kk.map(k => 100 * Math.sqrt(sviW(r.fit.params, k) / r.T)), mode: 'lines', name: 'SVI fit', line: { color: '#00FF66', width: 2 }, hoverinfo: 'skip' };
  const mkt = { x: r.points.map(p => p.k), y: r.points.map(p => 100 * p.iv), mode: 'markers', name: 'market mid IV (OTM)', marker: { color: '#ffffff', size: 6 }, text: r.points.map(p => `K=${p.K} ${p.type}`), hovertemplate: '%{text}<br>IV %{y:.2f}%<extra></extra>' };
  const mark = { x: r.points.filter(p => p.markIv).map(p => p.k), y: r.points.filter(p => p.markIv).map(p => 100 * p.markIv), mode: 'markers', name: 'Deribit mark_iv', marker: { color: '#B6FF2E', symbol: 'diamond-open', size: 8 }, hoverinfo: 'skip' };
  Plotly.react('smile', [fitTrace, mkt, mark], {
    paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: '#0a0c0a', font: FONT, margin: { l: 50, r: 10, t: 10, b: 45 },
    xaxis: { title: 'log-moneyness ln(K/F)', gridcolor: '#1f261f', zerolinecolor: '#2a332a' }, yaxis: { title: 'implied vol %', gridcolor: '#1f261f' },
    legend: { orientation: 'h', y: -0.2 },
  }, { responsive: true, displaylogo: false });
  const p = r.fit.params;
  const cell = (k, v, cls = '') => `<div><b>${k}</b><span class="${cls}">${v}</span></div>`;
  $('metrics').innerHTML = [
    cell('expiry', `${r.label} (${r.days.toFixed(1)} d)`), cell('forward F', r.F.toFixed(1)), cell('quotes used', r.used),
    cell('fit RMSE', pct(r.fit.rmse, 3) + ' vol pts'), cell('max error', pct(r.fit.maxErr, 2) + ' vol pts'),
    cell('butterfly min g', r.bf.min.toFixed(4) + (r.bf.ok ? ' pass' : ' FAIL'), r.bf.ok ? 'ok' : 'no'),
    cell('Lee wing b(1+|rho|)', (p.b * (1 + Math.abs(p.rho))).toFixed(3) + (r.lee ? ' <= 4' : ' > 4'), r.lee ? 'ok' : 'no'),
    cell('SVI a, b', `${p.a.toFixed(4)}, ${p.b.toFixed(4)}`), cell('SVI rho, m, sigma', `${p.rho.toFixed(3)}, ${p.m.toFixed(3)}, ${p.s.toFixed(3)}`),
  ].join('');
  document.querySelectorAll('#report tbody tr').forEach(tr => tr.classList.toggle('sel', Number(tr.dataset.i) === state.sel));
}

function selectExpiry(i) { state.sel = i; $('expiry').value = String(i); renderSmile(); }

function fillExpiries(rows) {
  const sel = $('expiry');
  sel.innerHTML = '';
  rows.forEach((r, i) => { if (r.fit) { const o = document.createElement('option'); o.value = i; o.textContent = `${r.label} (${r.days.toFixed(0)} d)`; sel.appendChild(o); } });
  const first = rows.findIndex(r => r.fit);
  const mid = rows.findIndex((r, i) => r.fit && r.days > 25);
  state.sel = mid >= 0 ? mid : first;
  sel.value = String(state.sel);
}

async function run(forceSnapshot) {
  const cur = $('asset').value;
  $('refresh').disabled = $('snap').disabled = true;
  setBanner('', 'Loading...');
  try {
    state.liveError = null;
    const data = await getData(cur, forceSnapshot);
    state.rows = analyse(data);
    renderProv(data, state.rows);
    if (data.source === 'live') {
      setBanner('live', `LIVE: Deribit ${cur} options fetched ${utc(data.fetchedAtMs)}.`);
    } else {
      const why = forceSnapshot ? 'you chose the stored snapshot' : `live fetch failed (${state.liveError})`;
      setBanner('snap', `SNAPSHOT, NOT LIVE: stored Deribit ${cur} data from ${utc(data.fetchedAtMs)}; ${why}.`);
    }
    fillExpiries(state.rows);
    renderTable(state.rows);
    renderSurface(state.rows);
    renderSmile();
  } catch (e) {
    setBanner('err', 'Could not load data: ' + (e.message || e));
  } finally {
    $('refresh').disabled = $('snap').disabled = false;
  }
}

$('refresh').addEventListener('click', () => run(false));
$('snap').addEventListener('click', () => run(true));
$('asset').addEventListener('change', () => run(false));
$('expiry').addEventListener('change', e => selectExpiry(Number(e.target.value)));
if (typeof Plotly === 'undefined') setBanner('err', 'Plotly failed to load from the CDN, so charts cannot draw.');
else run(false);
