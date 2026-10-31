import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serve, launch, mockDeribit } from './helpers/browser.js';

let srv, browser;
before(async () => { srv = await serve(); browser = await launch(); });
after(async () => { await browser.close(); srv.server.close(); });

async function open(opts = {}, route = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...opts });
  const page = await ctx.newPage();
  await mockDeribit(page, route);
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  return { ctx, page, errors };
}
const ready = page => page.waitForSelector('body[data-state="ready"][data-surface="ready"]', { timeout: 90000 });

test('loading state: skeletons and busy flag show while the book is in flight, then give way to real numbers', async () => {
  const { ctx, page, errors } = await open({}, { delayMs: 1500 });
  await page.goto(srv.url);
  await page.waitForSelector('#status[data-kind="loading"]');
  assert.equal(await page.getAttribute('#hero', 'aria-busy'), 'true');
  assert.ok(await page.locator('#s-atm.sk').count(), 'ATM stat shows a skeleton');
  assert.match(await page.textContent('#status-text'), /Fetching Deribit BTC/);
  await ready(page);
  assert.equal(await page.getAttribute('#hero', 'aria-busy'), 'false');
  assert.equal(await page.locator('#s-atm.sk').count(), 0);
  assert.equal(await page.locator('#status[data-kind="live"]').count(), 1);
  assert.match(await page.textContent('#headline'), /BTC options price \d+\.\d% annualised vol/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('fallback: when the live fetch fails the page says SNAPSHOT and still renders from stored data', async () => {
  const { ctx, page } = await open({}, { fail: true });
  await page.goto(srv.url);
  await ready(page);
  const txt = await page.textContent('#status-text');
  assert.match(txt, /Snapshot, not live/);
  assert.match(txt, /live fetch failed/);
  assert.equal(await page.getAttribute('#status', 'data-kind'), 'snapshot');
  assert.match(await page.textContent('#eyebrow'), /stored snapshot/);
  await ctx.close();
});

test('animation: count-up helper passes through intermediate values and lands on the exact value', async () => {
  const { ctx, page } = await open();
  await page.goto(srv.url);
  const r = await page.evaluate(async () => {
    const { animateNumber } = await import('./lib/motion.js');
    const el = document.createElement('span');
    document.body.appendChild(el);
    const seen = [];
    const t0 = performance.now();
    const p = animateNumber(el, 37.5, { decimals: 1, suffix: '%', dur: 600 });
    await new Promise(res => { const tick = () => { seen.push(parseFloat(el.textContent)); if (performance.now() - t0 < 900) requestAnimationFrame(tick); else res(); }; requestAnimationFrame(tick); });
    await p;
    return { seen, end: el.textContent, value: el.dataset.value };
  });
  assert.equal(r.end, '37.5%');
  assert.equal(r.value, '37.5');
  assert.ok(r.seen.some(v => v > 1 && v < 36), `intermediate values: ${r.seen.slice(0, 12)}`);
  assert.ok(r.seen.every((v, i) => i === 0 || !(v < r.seen[i - 1] - 1e-9) || Number.isNaN(v)), 'monotone count-up');
  await ctx.close();
});

test('animation: the surface build raises the sheet and reveals quotes progressively; hero lands on its true value', async () => {
  const { ctx, page } = await open();
  await page.addInitScript(() => {
    window.__upd = [];
    let P;
    Object.defineProperty(window, 'Plotly', {
      configurable: true, get: () => P,
      set(v) {
        P = v; const u = v.update;
        v.update = function (gd, d, ...rest) {
          if (gd === 'surface' && d && d.z && d.z.length === 2) window.__upd.push({ zmax: Math.max(...d.z[0].flat().filter(x => x !== null)), pts: d.x[1].length });
          return u.call(this, gd, d, ...rest);
        };
      },
    });
  });
  await page.goto(srv.url);
  await ready(page);
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => ({ upd: window.__upd, shown: parseFloat(document.getElementById('s-atm').textContent), final: Number(document.getElementById('s-atm').dataset.value) }));
  assert.ok(Math.abs(r.shown - r.final) < 0.06, 'hero number ends on the true value');
  assert.ok(r.upd.length >= 2, `build frames: ${r.upd.length}`); // software GL renders only a few frames; the tween is time-based
  assert.ok(r.upd.at(-1).zmax - r.upd[0].zmax > 5, 'sheet rises');
  assert.ok(r.upd[0].pts < r.upd.at(-1).pts, 'quotes appear progressively');
  assert.ok(r.upd.every((u, i) => i === 0 || u.pts >= r.upd[i - 1].pts), 'quotes never disappear during the build');
  await ctx.close();
});

test('changing expiry updates the smile metrics and the selected chip', async () => {
  const { ctx, page } = await open();
  await page.goto(srv.url);
  await ready(page);
  const before = await page.getAttribute('body', 'data-expiry');
  const chips = page.locator('#chips button');
  assert.ok(await chips.count() >= 5);
  const target = chips.nth(2);
  await target.click();
  await page.waitForSelector(`body:not([data-expiry="${before}"])`);
  assert.equal(await target.getAttribute('aria-checked'), 'true');
  assert.equal(await page.locator('#chips button[aria-checked="true"]').count(), 1);
  await page.waitForTimeout(900);
  const m = await page.evaluate(() => ({ shown: parseFloat(document.getElementById('m-rmse').textContent), final: Number(document.getElementById('m-rmse').dataset.value) }));
  assert.ok(Math.abs(m.shown - m.final) < 0.002);
  await ctx.close();
});

test('camera presets switch and report pressed state', async () => {
  const { ctx, page } = await open();
  await page.goto(srv.url);
  await ready(page);
  await page.click('button[data-cam="top"]');
  assert.equal(await page.getAttribute('button[data-cam="top"]', 'aria-pressed'), 'true');
  assert.equal(await page.getAttribute('button[data-cam="angled"]', 'aria-pressed'), 'false');
  await page.waitForTimeout(1000);
  const eye = await page.evaluate(() => document.getElementById('surface').layout.scene.camera.eye);
  assert.ok(eye.z > 2.0, `top view eye z ${eye.z}`);
  await ctx.close();
});

test('scrubber moves the smile between expiries and keeps the chip in sync', async () => {
  const { ctx, page } = await open();
  await page.goto(srv.url);
  await ready(page);
  const before = await page.getAttribute('body', 'data-expiry');
  await page.focus('#scrub');
  await page.keyboard.press('ArrowRight');
  await page.waitForSelector(`body:not([data-expiry="${before}"])`);
  const label = await page.textContent('#scrub-label');
  assert.equal(label, await page.getAttribute('body', 'data-expiry'));
  assert.equal(await page.locator('#chips button[aria-checked="true"]').textContent().then(t => t.split(' ')[0]), label);
  await ctx.close();
});

test('3D view: drag rotates the camera, double-click glides back to the preset', async () => {
  const { ctx, page } = await open();
  await page.goto(srv.url);
  await ready(page);
  const eye0 = await page.evaluate(() => ({ ...document.getElementById('surface').layout.scene.camera.eye }));
  await page.locator('#surface').scrollIntoViewIfNeeded();
  const box = await page.locator('#surface').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(cx + i * 20, cy + i * 4);
  await page.mouse.up();
  await page.waitForTimeout(400);
  const eye1 = await page.evaluate(() => ({ ...document.getElementById('surface').layout.scene.camera.eye }));
  assert.ok(Math.hypot(eye1.x - eye0.x, eye1.y - eye0.y) > 0.2, 'camera moved after drag');
  assert.equal(await page.locator('.cams button[aria-pressed="true"]').count(), 0, 'no preset is marked while the view is custom');
  await page.mouse.dblclick(cx, cy);
  await page.waitForTimeout(1300);
  const eye2 = await page.evaluate(() => ({ ...document.getElementById('surface').layout.scene.camera.eye }));
  assert.ok(Math.hypot(eye2.x - 1.4, eye2.y + 1.65, eye2.z - 0.9) < 0.05, `reset to angled, got ${JSON.stringify(eye2)}`);
  await ctx.close();
});

test('no layout shift while data arrives (skeletons match the final boxes)', async () => {
  const { ctx, page } = await open({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => {
    window.__cls = 0;
    new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
  });
  await page.goto(srv.url);
  await ready(page);
  await page.waitForTimeout(500);
  const cls = await page.evaluate(() => window.__cls);
  console.log(`# cumulative layout shift on load: ${cls.toFixed(4)}`);
  assert.ok(cls < 0.1, `CLS ${cls}`);
  await ctx.close();
});

test('short-dated expiries are not drawn on the surface or the term line but are listed in the table with the reason', async () => {
  const { ctx, page } = await open();
  await page.goto(srv.url);
  await ready(page);
  const ticks = await page.evaluate(() => document.getElementById('surface').layout.scene.yaxis.ticktext);
  const dots = await page.locator('#term circle').count();
  assert.equal(dots, ticks.length, 'term line and surface show the same expiries');
  await page.click('#d-table summary');
  const notShown = await page.locator('#report tbody tr', { hasText: 'not shown on surface: under 7 days to expiry' }).count();
  assert.ok(notShown >= 1, 'table lists the hidden short expiries with a reason');
  const rows = await page.locator('#report tbody tr').count();
  const fittedRows = await page.locator('#report tbody tr', { hasText: 'on surface' }).count();
  assert.ok(fittedRows === rows - (await page.locator('#report tbody tr', { hasText: 'not fitted' }).count()), 'every fitted expiry is accounted for in the table');
  assert.ok(ticks.length === fittedRows - notShown, 'surface count = fitted minus not shown');
  await ctx.close();
});

test('mobile: the 3D surface fills the viewport width and is tall enough to read', async () => {
  const { ctx, page } = await open({ viewport: { width: 375, height: 812 } });
  await page.goto(srv.url);
  await ready(page);
  const b = await page.locator('#surface').boundingBox();
  assert.ok(b.width >= 374, `width ${b.width}`);
  assert.ok(b.height >= 520, `height ${b.height}`);
  await ctx.close();
});

test('dense diagnostics are collapsed until opened', async () => {
  const { ctx, page } = await open();
  await page.goto(srv.url);
  await ready(page);
  assert.equal(await page.locator('#report').isVisible(), false);
  await page.click('#d-table summary');
  assert.equal(await page.locator('#report').isVisible(), true);
  assert.ok(await page.locator('#report tbody tr').count() >= 10);
  await page.click('#d-prov summary');
  assert.match(await page.textContent('#prov'), /get_book_summary_by_currency/);
  await ctx.close();
});

test('reduced motion: no animated number, no running CSS animation, surface is built instantly', async () => {
  const { ctx, page } = await open({ reducedMotion: 'reduce' });
  await page.goto(srv.url);
  await page.waitForSelector('#status[data-kind="live"]');
  await page.waitForSelector('body[data-surface="ready"]', { timeout: 5000 });
  const r = await page.evaluate(() => {
    const el = document.getElementById('s-atm');
    const anims = document.getAnimations().filter(a => a.playState === 'running' && a.effect && a.effect.getTiming().iterations === Infinity);
    return { shown: parseFloat(el.textContent), final: Number(el.dataset.value), infinite: anims.map(a => a.animationName || a.constructor.name) };
  });
  assert.ok(Math.abs(r.shown - r.final) < 0.06, 'number set immediately');
  assert.deepEqual(r.infinite, [], 'no infinite animations');
  const eye = await page.evaluate(() => document.getElementById('surface').layout.scene.camera.eye);
  assert.deepEqual([eye.x, eye.y, eye.z], [1.4, -1.65, 0.9], 'camera starts at the final pose');
  await ctx.close();
});

for (const [w, h] of [[375, 812], [768, 1024], [1440, 900]]) {
  test(`layout at ${w}px: no horizontal overflow, headline result above the fold, tap targets >= 32px`, async () => {
    const { ctx, page } = await open({ viewport: { width: w, height: h } });
    await page.goto(srv.url);
    await ready(page);
    const m = await page.evaluate(() => {
      const de = document.documentElement;
      const hl = document.getElementById('headline').getBoundingClientRect();
      const small = [...document.querySelectorAll('button')].filter(b => b.offsetParent && b.getBoundingClientRect().height < 32).map(b => b.textContent.trim());
      const wide = [...document.querySelectorAll('main *, header *')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > de.clientWidth + 1) && !e.closest('.scroll,.chips,.plotwrap'); }).map(e => e.tagName + '.' + e.className);
      return { sw: de.scrollWidth, cw: de.clientWidth, headlineBottom: hl.bottom, vh: innerHeight, small, wide: wide.slice(0, 5) };
    });
    assert.ok(m.sw <= m.cw, `scrollWidth ${m.sw} > ${m.cw}`);
    assert.ok(m.headlineBottom < m.vh, `headline bottom ${m.headlineBottom} below fold ${m.vh}`);
    assert.deepEqual(m.small, []);
    assert.deepEqual(m.wide, []);
    await ctx.close();
  });
}
