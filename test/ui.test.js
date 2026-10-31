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
const ready = page => page.waitForSelector('body[data-state="ready"][data-surface="ready"]', { timeout: 30000 });

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

test('animation: hero numbers count up through intermediate values and the surface builds from flat', async () => {
  const { ctx, page } = await open({}, { delayMs: 300 });
  await page.addInitScript(() => {
    window.__s = { shown: [], zmax: [], dt: [], pts: [] };
    let last = performance.now();
    const tick = now => {
      window.__s.dt.push(now - last); last = now;
      const a = document.getElementById('s-atm');
      if (a) window.__s.shown.push(parseFloat(a.textContent));
      const sf = document.getElementById('surface');
      const z = sf && sf.data && sf.data[0] ? sf.data[0].z.flat().filter(v => v !== null) : [];
      window.__s.zmax.push(z.length ? Math.max(...z) : null);
      window.__s.pts.push(sf && sf.data && sf.data[1] ? sf.data[1].x.length : 0);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.goto(srv.url);
  await ready(page);
  await page.waitForTimeout(300);
  const s = await page.evaluate(() => ({ ...window.__s, final: Number(document.getElementById('s-atm').dataset.value) }));
  assert.ok(Math.abs(s.shown.at(-1) - s.final) < 0.06, 'count-up ends on the true value');
  assert.ok(s.shown.some(v => v > 0.5 && Math.abs(v - s.final) > 1), 'count-up passes through intermediate values');
  const zs = s.zmax.filter(v => v !== null);
  assert.ok(zs.length > 5 && zs.at(-1) - Math.min(...zs) > 5, 'sheet rises during the build');
  const pts = s.pts.filter(n => n > 0);
  assert.ok(pts.length > 5 && Math.min(...pts) < pts.at(-1) * 0.8, 'quotes appear progressively, not all at once');
  const sorted = [...s.dt].sort((a, b) => a - b);
  console.log(`# frame time over load and build (software GL, headless): median ${sorted[sorted.length >> 1].toFixed(1)} ms, p95 ${sorted[Math.floor(sorted.length * 0.95)].toFixed(1)} ms`);
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
