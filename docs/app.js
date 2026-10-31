import { fetchLive } from './lib/deribit.js';
import { analyse } from './lib/analyse.js';
import { sviW } from './lib/svi.js';
import { summarise, headline, subline } from './lib/summary.js';
import { tween, cancelTween, animateNumber, ease, reduced } from './lib/motion.js';

const $ = id => document.getElementById(id);
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const CAMS = {
  angled: { x: 1.4, y: -1.65, z: 0.9 },
  smiles: { x: 0.02, y: -2.0, z: 0.28 },
  top: { x: 0.02, y: -0.5, z: 2.2 },
};
const camOf = n => { const c = CAMS[n] || CAMS.angled, k = innerWidth < 640 ? 0.78 : 1; return { x: c.x * k, y: c.y * k, z: c.z * k }; };
const KCLIP = 0.5; // 3D view only: short-dated wings beyond this dominate the z-axis
const ASPECT = { x: 1.3, y: 1.1, z: 0.8 };
const state = { cur: 'BTC', rows: [], fitted: [], sel: 0, data: null, summary: null, cam: 'angled', liveError: null, surf: null, selSeq: 0 };

const nextFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
const pct = (x, d = 2) => (x * 100).toFixed(d);
const utc = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const hasGL = () => { try { const c = document.createElement('canvas'); return !!(c.getContext('webgl') || c.getContext('experimental-webgl')); } catch { return false; } };
const fonts = () => ({ family: css('--f-mono'), color: css('--c-text'), size: 11 });

function setStatus(kind, text) {
  $('status').dataset.kind = kind;
  $('status-text').textContent = text;
  document.body.dataset.state = kind === 'loading' ? 'loading' : 'ready';
}

function ageText() {
  const d = state.data;
  if (!d || d.source !== 'live') return '';
  const s = Math.max(0, Math.round((Date.now() - d.fetchedAtMs) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m ago`;
}
setInterval(() => { $('age').textContent = ageText(); }, 1000);

async function getData(cur, forceSnapshot) {
  if (!forceSnapshot) {
    try { return { ...(await fetchLive(cur)), source: 'live' }; } catch (e) { state.liveError = String(e.message || e); }
  }
  const res = await fetch(`data/${cur.toLowerCase()}.json`);
  if (!res.ok) throw new Error('snapshot missing');
  const s = await res.json();
  return { result: s.result, fetchedAtMs: s.meta.fetchedAtMs, url: s.meta.url, source: 'snapshot', meta: s.meta };
}

/* ---------- hero ---------- */
function renderHero(s, data) {
  const asset = state.cur;
  $('eyebrow').textContent = `Implied volatility / Deribit ${asset} options / ${data.source === 'live' ? 'live' : 'stored snapshot'}`;
  $('headline').innerHTML = headline(asset, s);
  $('subline').textContent = subline(s);
  animateNumber($('s-atm'), s.atm, { decimals: 1, suffix: '%', dur: 1100 });
  $('c-atm').textContent = `${s.pick.label}, ${s.pick.days.toFixed(0)} days to expiry, read off the SVI fit at the forward.`;
  if (s.skew === null) {
    $('s-skew').classList.remove('sk'); $('s-skew').textContent = 'n/a'; $('s-skew').dataset.value = '';
    $('c-skew').textContent = 'The closest expiry does not trade wide enough.';
  } else {
    animateNumber($('s-skew'), s.skew, { decimals: 1, prefix: s.skew > 0 ? '+' : '', dur: 1100 });
    $('c-skew').textContent = s.skew >= 0 ? 'Puts priced above equally distant calls (negative skew).' : 'Calls priced above equally distant puts.';
  }
  animateNumber($('s-rmse'), s.medianRmse, { decimals: 2, dur: 1100 });
  $('c-rmse').textContent = `Median across expiries. Worst is ${s.worstRmse.toFixed(2)} (${s.worstLabel}).`;
  animateNumber($('s-pass'), s.passed, { decimals: 0, dur: 1100 });
  $('s-total').textContent = ` of ${s.total} pass`;
  $('c-pass').textContent = s.passed === s.total ? 'Butterfly, wing bound and calendar all hold on the fitted curves.' : 'Some expiries break a check. See the diagnostics table.';
  $('c-pass').className = 'cap ' + (s.passed === s.total ? '' : 'no');
  $('hero').setAttribute('aria-busy', 'false');
}

/* ---------- camera ---------- */
const sph = e => { const r = Math.hypot(e.x, e.y, e.z); return { r, az: Math.atan2(e.y, e.x), el: Math.asin(e.z / r) }; };
const eyeOf = o => ({ x: o.r * Math.cos(o.el) * Math.cos(o.az), y: o.r * Math.cos(o.el) * Math.sin(o.az), z: o.r * Math.sin(o.el) });
const curEye = () => $('surface').layout.scene.camera.eye;
const wrapAngle = a => Math.atan2(Math.sin(a), Math.cos(a));
const focusCenter = i => ({ x: 0, y: state.fitted.length > 1 ? 0.28 * (i / (state.fitted.length - 1) - 0.5) * ASPECT.y : 0, z: 0 });

let camPending = false, camNext = null;
function applyCam(eye, center) {
  camNext = { eye, center };
  if (camPending) return;
  camPending = true;
  requestAnimationFrame(() => {
    camPending = false;
    const u = { 'scene.camera.eye': camNext.eye };
    if (camNext.center) u['scene.camera.center'] = camNext.center;
    Plotly.relayout('surface', u);
  });
}

// Spherical glide: keeps the camera at a constant orbit radius instead of cutting through the scene.
function glide(toEye, toCenter, dur = 800, key = 'cam') {
  const el = $('surface');
  if (!el.layout) return Promise.resolve();
  const a = sph(curEye()), b = sph(toEye), c0 = el.layout.scene.camera.center || { x: 0, y: 0, z: 0 };
  const daz = wrapAngle(b.az - a.az);
  return tween(key, dur, p => {
    const o = { r: a.r + (b.r - a.r) * p, az: a.az + daz * p, el: a.el + (b.el - a.el) * p };
    Plotly.relayout('surface', {
      'scene.camera.eye': eyeOf(o),
      'scene.camera.center': toCenter ? { x: 0, y: c0.y + (toCenter.y - c0.y) * p, z: 0 } : c0,
    });
  }, ease.inOut);
}

function setCam(name) {
  state.cam = name;
  document.querySelectorAll('.cams button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.cam === name)));
  return glide(camOf(name), focusCenter(state.sel >= 0 ? state.fitted.indexOf(state.rows[state.sel]) : 0), 850);
}

// Own orbit control: drag to rotate with inertia, double-click to reset, arrow keys to nudge.
function wireOrbit() {
  const el = $('surface');
  let down = null, vaz = 0, vel = 0, inertia = 0;
  const o = () => sph(curEye());
  const manual = () => { state.cam = 'custom'; document.querySelectorAll('.cams button').forEach(b => b.setAttribute('aria-pressed', 'false')); cancelTween('cam'); cancelAnimationFrame(inertia); };
  el.addEventListener('pointerdown', e => {
    if (!el.layout || (e.pointerType === 'mouse' && e.button !== 0)) return;
    down = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId, t: performance.now() };
    vaz = vel = 0; cancelAnimationFrame(inertia);
  });
  el.addEventListener('pointermove', e => {
    if (!down || e.pointerId !== down.id) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (!down.moved && Math.hypot(dx, dy) < 4) return;
    if (!down.moved) { down.moved = true; manual(); el.classList.add('drag'); try { el.setPointerCapture(e.pointerId); } catch {} }
    const s = o();
    vaz = -dx * 0.007; vel = dy * 0.005;
    s.az += vaz; s.el = clamp(s.el + vel, 0.08, 1.45);
    applyCam(eyeOf(s));
    down.x = e.clientX; down.y = e.clientY;
  });
  const end = () => {
    if (!down) return;
    const moved = down.moved; down = null; el.classList.remove('drag');
    if (!moved || reduced() || Math.abs(vaz) < 0.0015) return;
    const spin = () => {
      vaz *= 0.94; vel *= 0.94;
      if (Math.abs(vaz) < 0.0004 && Math.abs(vel) < 0.0004) return;
      const s = o(); s.az += vaz; s.el = clamp(s.el + vel, 0.08, 1.45);
      applyCam(eyeOf(s)); inertia = requestAnimationFrame(spin);
    };
    inertia = requestAnimationFrame(spin);
  };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  el.addEventListener('dblclick', () => setCam(CAMS[state.cam] ? state.cam : 'angled'));
  el.addEventListener('keydown', e => {
    const d = { ArrowLeft: [0.18, 0], ArrowRight: [-0.18, 0], ArrowUp: [0, 0.12], ArrowDown: [0, -0.12] }[e.key];
    if (!d || !el.layout) return;
    e.preventDefault(); manual();
    const s = o(); const t = { r: s.r, az: s.az + d[0], el: clamp(s.el + d[1], 0.08, 1.45) };
    glide(eyeOf(t), null, 300, 'key');
  });
}

/* ---------- surface ---------- */
async function renderSurface(rows, animate) {
  const el = $('surface');
  const fitted = state.fitted;
  if (!hasGL()) { el.innerHTML = '<p class="note" style="padding:24px">The 3D surface needs WebGL, which this browser has switched off. The smile charts and the diagnostics table still work.</p>'; document.body.dataset.surface = 'ready'; return; }
  if (!fitted.length) { el.textContent = 'No expiry had enough two-sided quotes to fit.'; document.body.dataset.surface = 'ready'; return; }
  const gmin = Math.max(-KCLIP, Math.min(...fitted.map(r => r.kmin))), gmax = Math.min(KCLIP, Math.max(...fitted.map(r => r.kmax)));
  const N = 60;
  const kg = Array.from({ length: N + 1 }, (_, i) => gmin + (gmax - gmin) * i / N);
  const zFull = fitted.map(r => kg.map(k => (k >= r.kmin && k <= r.kmax) ? 100 * Math.sqrt(sviW(r.fit.params, k) / r.T) : null));
  const flat = Math.min(...zFull.flat().filter(v => v !== null)) - 2;
  const yi = fitted.map((_, i) => i);
  const P = { x: [], y: [], z: [], t: [], row: [] };
  fitted.forEach((r, i) => r.points.filter(p => Math.abs(p.k) <= KCLIP).forEach(p => { P.x.push(p.k); P.y.push(i); P.z.push(100 * p.iv); P.t.push(`${r.label} K=${p.K} ${p.type}`); P.row.push(i); }));
  state.surf = { kg, zFull, flat, yi, P };
  const run = animate && !reduced();
  const flatZ = zFull.map(r => r.map(v => (v === null ? null : flat)));
  const surf = {
    type: 'surface', x: kg, y: yi, z: run ? flatZ : zFull, opacity: 0.94, connectgaps: false,
    colorscale: [[0, '#0b2a17'], [0.5, '#00c24e'], [1, css('--c-select')]],
    colorbar: { thickness: 8, len: 0.55, x: 0.98, outlinewidth: 0, tickfont: { size: 10, color: css('--c-muted') }, ticksuffix: '%' },
    lighting: { ambient: 0.75, diffuse: 0.6, specular: 0.15, roughness: 0.7 },
    hovertemplate: 'k=%{x:.3f}<br>IV %{z:.1f}%<extra></extra>',
  };
  const pts = {
    type: 'scatter3d', mode: 'markers', x: run ? [] : P.x, y: run ? [] : P.y, z: run ? [] : P.z, text: P.t,
    hovertemplate: '%{text}<br>IV %{z:.2f}%<extra></extra>', marker: { size: 2.6, color: css('--c-text'), opacity: 0.92 },
  };
  const line = { type: 'scatter3d', mode: 'lines', x: [], y: [], z: [], hoverinfo: 'skip', line: { color: css('--c-select'), width: 7 } };
  const ax = (title, extra) => ({ title: { text: title, font: { size: 11 } }, color: css('--c-muted'), gridcolor: css('--c-rule'), zerolinecolor: css('--c-rule'), backgroundcolor: css('--c-bg'), showbackground: true, ...extra });
  const final = camOf(state.cam);
  const s0 = sph(final);
  const start = run ? eyeOf({ r: s0.r * 1.55, az: s0.az + 0.95, el: Math.min(1.2, s0.el + 0.35) }) : final;
  await Plotly.newPlot('surface', [surf, pts, line], {
    paper_bgcolor: 'rgba(0,0,0,0)', font: fonts(), margin: { l: 0, r: 0, t: 0, b: 20 }, showlegend: false,
    hoverlabel: { bgcolor: css('--c-surface'), bordercolor: css('--c-rule-strong'), font: { family: css('--f-mono'), size: 12, color: css('--c-text') } },
    scene: {
      xaxis: ax(innerWidth < 640 ? '' : 'ln(K/F)'), yaxis: ax('expiry', { tickvals: yi, ticktext: fitted.map(r => r.label), tickfont: { size: 9 } }),
      zaxis: ax('IV %'), camera: { eye: start, center: focusCenter(fitted.indexOf(state.rows[state.sel])), up: { x: 0, y: 0, z: 1 } },
      aspectmode: 'manual', aspectratio: ASPECT, dragmode: false,
    },
  }, { responsive: true, displaylogo: false, displayModeBar: false, scrollZoom: false });
  document.body.dataset.surface = run ? 'building' : 'ready';
  if (run) {
    const n = fitted.length;
    const sweep = r => Math.min(1, Math.max(0, r));
    await tween('build', 2600, p => {
      const rp = i => sweep((p - 0.55 * i / n) / 0.45);
      const z = zFull.map((r, i) => { const t = ease.out(sweep((rp(i) - 0.25) / 0.75)); return r.map(v => (v === null ? null : flat + (v - flat) * t)); });
      const idx = P.row.map((r, j) => (rp(r) > 0.04 ? j : -1)).filter(j => j >= 0);
      const e = eyeOf({ r: s0.r + (sph(start).r - s0.r) * (1 - p), az: sph(start).az + wrapAngle(s0.az - sph(start).az) * p, el: sph(start).el + (s0.el - sph(start).el) * p });
      Plotly.update('surface', { z: [z, idx.map(j => P.z[j])], x: [kg, idx.map(j => P.x[j])], y: [yi, idx.map(j => P.y[j])] }, { 'scene.camera.eye': e }, [0, 1]);
    }, ease.inOut);
  }
  setHighlight();
  document.body.dataset.surface = 'ready';
}

function setHighlight() {
  const S = state.surf, el = $('surface');
  if (!S || !el.data) return;
  const i = state.fitted.indexOf(state.rows[state.sel]);
  if (i < 0) return;
  const xs = [], zs = [];
  S.kg.forEach((k, j) => { if (S.zFull[i][j] !== null) { xs.push(k); zs.push(S.zFull[i][j] + 0.05); } });
  Plotly.restyle('surface', { x: [xs], y: [xs.map(() => i)], z: [zs] }, [2]);
}

/* ---------- smile ---------- */
function fillChips(rows) {
  const box = $('chips');
  box.innerHTML = '';
  rows.forEach((r, i) => {
    if (!r.fit) return;
    const b = document.createElement('button');
    b.type = 'button'; b.setAttribute('role', 'radio'); b.dataset.i = i;
    b.textContent = `${r.label} · ${r.days.toFixed(0)}d`;
    b.addEventListener('click', () => selectExpiry(i, true));
    b.addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const all = [...box.children];
      const nxt = all[(all.indexOf(b) + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length];
      nxt.focus(); nxt.click(); e.preventDefault();
    });
    box.appendChild(b);
  });
  const sc = $('scrub');
  sc.max = String(Math.max(0, state.fitted.length - 1));
  const n = state.fitted.length;
  $('ticks').innerHTML = state.fitted.map((_, i) => `<i style="left:${n > 1 ? (100 * i / (n - 1)).toFixed(2) : 0}%"></i>`).join('');
}

function smileSpec(r) {
  const kk = Array.from({ length: 121 }, (_, i) => r.kmin - 0.05 + (r.kmax - r.kmin + 0.1) * i / 120);
  const fy = kk.map(k => 100 * Math.sqrt(sviW(r.fit.params, k) / r.T));
  const my = r.points.map(p => 100 * p.iv);
  const fitAt = r.points.map(p => 100 * Math.sqrt(sviW(r.fit.params, p.k) / r.T));
  const lo = Math.min(...fy, ...my), hi = Math.max(...fy, ...my), pad = (hi - lo) * 0.08 + 0.5;
  return {
    line: { x: kk, y: fy },
    mkt: { x: r.points.map(p => p.k), y: my, customdata: r.points.map((p, i) => [p.K, p.type, fitAt[i], my[i] - fitAt[i], p.bid, p.ask]) },
    mark: { x: r.points.filter(p => p.markIv).map(p => p.k), y: r.points.filter(p => p.markIv).map(p => 100 * p.markIv), customdata: r.points.filter(p => p.markIv).map(p => [p.K, p.type]) },
    xr: [r.kmin - 0.05, r.kmax + 0.05], yr: [lo - pad, hi + pad],
  };
}
const HT = 'K=%{customdata[0]} %{customdata[1]}<br>market mid IV <b>%{y:.2f}%</b><br>SVI fit IV %{customdata[2]:.2f}%<br>residual %{customdata[3]:+.2f} pts<br>bid %{customdata[4]} / ask %{customdata[5]} (coin)<extra></extra>';

async function drawSmile(first, seq) {
  const r = state.rows[state.sel];
  const sp = smileSpec(r);
  const el = $('smile');
  const traces = [
    { ...sp.line, mode: 'lines', name: 'SVI fit', line: { color: css('--c-accent'), width: 2.5 }, hovertemplate: 'SVI fit<br>k=%{x:.3f}<br>IV %{y:.2f}%<extra></extra>' },
    { ...sp.mkt, mode: 'markers', name: 'market mid IV', marker: { color: css('--c-text'), size: 7, opacity: 1 }, hovertemplate: HT },
    { ...sp.mark, mode: 'markers', name: 'Deribit mark_iv', marker: { color: css('--c-select'), symbol: 'diamond-open', size: 9 }, hovertemplate: 'Deribit mark_iv<br>K=%{customdata[0]} %{customdata[1]}<br>IV %{y:.2f}%<extra></extra>' },
  ];
  const axis = t => ({ gridcolor: css('--c-rule'), zerolinecolor: css('--c-rule-strong'), linecolor: css('--c-rule-strong'), tickcolor: css('--c-rule-strong'), color: css('--c-muted'), title: { text: t, font: { size: 11 } } });
  const layout = {
    paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)', font: fonts(), margin: { l: 48, r: 12, t: 8, b: 78 },
    xaxis: { ...axis('log-moneyness ln(K/F)'), range: sp.xr }, yaxis: { ...axis('implied vol %'), range: sp.yr },
    legend: { orientation: 'h', y: -0.3, font: { size: 11 } }, hovermode: 'closest',
    hoverlabel: { bgcolor: css('--c-surface'), bordercolor: css('--c-rule-strong'), font: { family: css('--f-mono'), size: 12, color: css('--c-text') }, align: 'left' },
  };
  if (first || !el.data || reduced()) { await Plotly.react('smile', traces, layout, { responsive: true, displaylogo: false, displayModeBar: false }); return; }
  await tween('smile-fade', 140, p => Plotly.restyle('smile', { 'marker.opacity': [1 - p] }, [1]));
  if (seq !== state.selSeq) return;
  Plotly.restyle('smile', { x: [sp.mkt.x], y: [sp.mkt.y], customdata: [sp.mkt.customdata] }, [1]);
  Plotly.restyle('smile', { x: [sp.mark.x], y: [sp.mark.y], customdata: [sp.mark.customdata] }, [2]);
  Plotly.animate('smile', { data: [{ x: sp.line.x, y: sp.line.y }], traces: [0], layout: { xaxis: { range: sp.xr }, yaxis: { range: sp.yr } } },
    { transition: { duration: 450, easing: 'cubic-in-out' }, frame: { duration: 450, redraw: true } });
  await tween('smile-fade', 320, p => Plotly.restyle('smile', { 'marker.opacity': [p] }, [1]));
}

function renderMetrics(r) {
  const p = r.fit.params;
  animateNumber($('m-atm'), 100 * r.atm, { decimals: 1, dur: 500 });
  animateNumber($('m-rmse'), 100 * r.fit.rmse, { decimals: 3, dur: 500 });
  animateNumber($('m-max'), 100 * r.fit.maxErr, { decimals: 2, dur: 500 });
  animateNumber($('m-n'), r.used, { decimals: 0, dur: 500 });
  animateNumber($('m-bfv'), r.bf.min, { decimals: 3, dur: 500 });
  animateNumber($('m-leev'), p.b * (1 + Math.abs(p.rho)), { decimals: 3, dur: 500 });
  $('m-bfs').textContent = r.bf.ok ? 'pass' : 'FAIL'; $('m-bf').className = r.bf.ok ? 'ok' : 'no';
  $('m-lees').textContent = r.lee ? '<= 4 pass' : '> 4 FAIL'; $('m-lee').className = r.lee ? 'ok' : 'no';
  $('params').textContent = `${r.label} · forward ${r.F.toFixed(1)} · SVI a=${p.a.toFixed(4)} b=${p.b.toFixed(4)} rho=${p.rho.toFixed(3)} m=${p.m.toFixed(3)} sigma=${p.s.toFixed(3)}`;
  $('scrub-label').textContent = r.label;
  $('scrub-days').textContent = `${r.days.toFixed(1)} days to expiry`;
}

async function selectExpiry(i, animate) {
  const seq = ++state.selSeq;
  state.sel = i;
  const fi = state.fitted.indexOf(state.rows[i]);
  document.querySelectorAll('#chips button').forEach(b => b.setAttribute('aria-checked', String(Number(b.dataset.i) === i)));
  document.querySelectorAll('#report tbody tr').forEach(tr => tr.classList.toggle('sel', Number(tr.dataset.i) === i));
  $('scrub').value = String(fi);
  document.querySelectorAll('#ticks i').forEach((t, j) => t.classList.toggle('on', j === fi));
  renderTerm();
  $('scrub').setAttribute('aria-valuetext', `${state.rows[i].label}, ${state.rows[i].days.toFixed(0)} days`);
  const chip = document.querySelector(`#chips button[data-i="${i}"]`);
  if (chip && chip.scrollIntoView) { const box = $('chips'); box.scrollTo({ left: chip.offsetLeft - box.clientWidth / 2 + chip.clientWidth / 2, behavior: reduced() ? 'auto' : 'smooth' }); }
  renderMetrics(state.rows[i]);
  document.body.dataset.expiry = state.rows[i].label;
  if ($('surface').data) {
    setHighlight();
    if (animate && state.cam !== 'custom') glide(curEye(), focusCenter(fi), 700, 'focus');
  }
  await drawSmile(!animate, seq);
}

/* ---------- term structure sparkline ---------- */
function renderTerm() {
  const f = state.fitted, svg = $('term');
  if (!f.length) { svg.innerHTML = ''; return; }
  const W = 320, H = 120, L = 8, R = 8, T = 22, B = 26;
  const xs = f.map(r => Math.sqrt(r.days)), x0 = Math.min(...xs), x1 = Math.max(...xs);
  const ys = f.map(r => 100 * r.atm), lo = Math.min(...ys), hi = Math.max(...ys), pad = Math.max(0.5, (hi - lo) * 0.15);
  const X = v => L + (W - L - R) * (x1 === x0 ? 0.5 : (v - x0) / (x1 - x0));
  const Y = v => T + (H - T - B) * (1 - (v - (lo - pad)) / (hi - lo + 2 * pad));
  const sel = state.fitted.indexOf(state.rows[state.sel]);
  const pts = f.map((r, i) => [X(xs[i]), Y(ys[i])]);
  const NS = 'http://www.w3.org/2000/svg';
  svg.innerHTML = '';
  const add = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text !== undefined) e.textContent = text; svg.appendChild(e); return e; };
  add('line', { class: 'ax', x1: L, x2: W - R, y1: H - B + 6, y2: H - B + 6 });
  add('polyline', { class: 'ln', points: pts.map(p => p.join(',')).join(' ') });
  pts.forEach((p, i) => add('circle', { class: 'pt' + (i === sel ? ' on' : ''), cx: p[0], cy: p[1], r: i === sel ? 5 : 3 }));
  const sp = pts[sel];
  add('text', { class: 'hot', x: Math.min(W - 30, Math.max(30, sp[0])), y: Math.max(12, sp[1] - 11), 'text-anchor': 'middle' }, `${ys[sel].toFixed(1)}%`);
  add('text', { x: L, y: H - 6 }, f[0].label);
  add('text', { x: W - R, y: H - 6, 'text-anchor': 'end' }, f[f.length - 1].label);
  svg.setAttribute('aria-label', `ATM implied vol by expiry: ${f.map((r, i) => `${r.label} ${ys[i].toFixed(1)} percent`).join(', ')}`);
}

/* ---------- secondary ---------- */
function renderTable(rows) {
  const t = $('report');
  const head = '<thead><tr><th>expiry</th><th>days</th><th>forward</th><th>quotes</th><th>ATM IV %</th><th>RMSE (pts)</th><th>max err</th><th>vs Deribit mark</th><th>butterfly min g</th><th>wing bound</th><th>calendar vs prev</th></tr></thead>';
  const body = rows.map((r, i) => {
    if (!r.fit) return `<tr data-i="${i}" class="dim"><td>${r.label}</td><td>${r.days.toFixed(1)}</td><td>${Math.round(r.F)}</td><td>${r.used}</td><td colspan="7" style="text-align:left">not fitted: ${r.skipped}</td></tr>`;
    const cal = r.cal === undefined ? '<span class="dim">first</span>' : r.cal === null ? '<span class="dim">no overlap</span>'
      : r.cal.ok ? '<span class="ok">pass</span>' : `<span class="no">fail (${r.cal.worst.toExponential(1)})</span>`;
    return `<tr data-i="${i}"><td>${r.label}</td><td>${r.days.toFixed(1)}</td><td>${Math.round(r.F)}</td><td>${r.used}</td>` +
      `<td>${pct(r.atm)}</td><td>${pct(r.fit.rmse, 3)}</td><td>${pct(r.fit.maxErr, 2)}</td><td>${r.markDiff === null ? 'n/a' : pct(r.markDiff, 2)}</td>` +
      `<td class="${r.bf.ok ? 'ok' : 'no'}">${r.bf.min.toFixed(3)}</td><td class="${r.lee ? 'ok' : 'no'}">${r.lee ? 'pass' : 'fail'}</td><td>${cal}</td></tr>`;
  }).join('');
  t.innerHTML = head + '<tbody>' + body + '</tbody>';
  t.querySelectorAll('tbody tr').forEach(tr => tr.addEventListener('click', () => {
    const i = Number(tr.dataset.i);
    if (rows[i].fit) { selectExpiry(i, true); $('t-smile').scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' }); }
  }));
  $('table-note').textContent = 'Butterfly g is Gatheral\'s density condition scanned on 400 points over the quoted strikes plus 0.05 log-moneyness each side (must be >= 0). Calendar compares total variance of adjacent expiries over the range both trade. "vs Deribit mark" is the median absolute gap between our mid-based IV and Deribit\'s own mark_iv, in vol points. Click a row to open its smile.';
}

function renderProv(data, rows) {
  const used = rows.reduce((a, r) => a + (r.fit ? r.used : 0), 0);
  const items = [
    ['source', 'Deribit public API, get_book_summary_by_currency'],
    ['request', data.url],
    ['data time', utc(data.fetchedAtMs) + (data.source === 'snapshot' ? ' (stored snapshot)' : ' (server clock at response)')],
    ['instruments', `${data.result.length} listed, ${used} usable OTM two-sided quotes across ${rows.filter(r => r.fit).length} fitted expiries`],
    ['method', 'IV: Black-76 on the per-expiry forward from bid/ask mid. Fit: raw SVI, least squares in total variance, bounded kink, width and wing slope.'],
  ];
  $('prov').innerHTML = items.map(() => '<dt></dt><dd></dd>').join('');
  const cells = $('prov').children;
  items.forEach(([k, v], i) => { cells[2 * i].textContent = k; cells[2 * i + 1].textContent = v; });
}

/* ---------- run ---------- */
let runId = 0;
async function run(forceSnapshot) {
  const id = ++runId;
  const cur = state.cur;
  $('refresh').disabled = $('snap').disabled = true;
  setStatus('loading', `Fetching Deribit ${cur} book...`);
  $('age').textContent = '';
  $('hero').setAttribute('aria-busy', 'true');
  $('surface-ov').hidden = false; $('smile-ov').hidden = false;
  document.body.dataset.surface = 'pending';
  try {
    state.liveError = null;
    const data = await getData(cur, forceSnapshot);
    if (id !== runId) return;
    setStatus('loading', 'Inverting vols, fitting SVI, checking arbitrage...');
    await nextFrame();
    state.data = data;
    state.rows = analyse(data.result, data.fetchedAtMs);
    state.fitted = state.rows.filter(r => r.fit);
    state.summary = summarise(state.rows);
    if (!state.summary) throw new Error('no expiry had enough two-sided quotes to fit');
    if (data.source === 'live') setStatus('live', `Live ${cur} book, ${utc(data.fetchedAtMs).slice(11)}`);
    else setStatus('snapshot', `Snapshot, not live: ${utc(data.fetchedAtMs)}${forceSnapshot ? '' : ` (live fetch failed: ${state.liveError})`}`);
    $('age').textContent = ageText();
    renderHero(state.summary, data);
    renderProv(data, state.rows);
    renderTable(state.rows);
    fillChips(state.rows);
    const best = Math.min(...state.fitted.map(x => Math.abs(x.days - 30)));
    const mid = state.rows.findIndex(r => r.fit && Math.abs(r.days - 30) === best);
    state.cam = 'angled';
    document.querySelectorAll('.cams button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.cam === 'angled')));
    await selectExpiry(mid, false);
    await renderSurface(state.rows, true);
    $('hero').classList.add('reveal');
  } catch (e) {
    setStatus('error', 'Could not load data: ' + (e.message || e));
    $('hero').setAttribute('aria-busy', 'false');
    document.body.dataset.surface = 'ready';
  } finally {
    $('refresh').disabled = $('snap').disabled = false;
  }
}

$('refresh').addEventListener('click', () => run(false));
$('snap').addEventListener('click', () => run(true));
document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => {
  if (b.dataset.asset === state.cur) return;
  state.cur = b.dataset.asset;
  document.querySelectorAll('.seg button').forEach(x => x.setAttribute('aria-checked', String(x === b)));
  run(false);
}));
document.querySelectorAll('.cams button').forEach(b => b.addEventListener('click', () => setCam(b.dataset.cam)));
$('scrub').addEventListener('input', e => { const r = state.fitted[Number(e.target.value)]; if (r) selectExpiry(state.rows.indexOf(r), true); });
wireOrbit();
if (typeof Plotly === 'undefined') setStatus('error', 'Plotly failed to load from the CDN, so charts cannot draw.');
else run(false);
