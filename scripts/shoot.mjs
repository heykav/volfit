// Full-page screenshots with real WebGL. Usage: node scripts/shoot.mjs <url> <outPrefix>
import { chromium } from 'playwright-core';
const [url, prefix] = process.argv.slice(2);
const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
for (const [name, w, h, dpr] of [['desktop', 1440, 900, 1], ['mobile', 375, 812, 2]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${prefix}-${name}.png`, fullPage: true });
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, h: document.documentElement.scrollHeight }));
  console.log(name, JSON.stringify(m));
  await ctx.close();
}
await browser.close();
