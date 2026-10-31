// Shared helpers for the browser tests: a static server for docs/ and a Deribit mock built from the stored real snapshot.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const DOCS = fileURLToPath(new URL('../../docs/', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

export function serve() {
  const server = http.createServer((req, res) => {
    let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    if (p.endsWith('/')) p += 'index.html';
    const f = join(DOCS, p);
    if (!existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
    res.end(readFileSync(f));
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${server.address().port}/` })));
}

export const launch = () => chromium.launch({
  channel: 'chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

// Answers Deribit with the stored real BTC/ETH book so tests are deterministic. delayMs holds the response back.
export async function mockDeribit(page, { delayMs = 0, fail = false } = {}) {
  await page.route('https://www.deribit.com/**', async route => {
    if (fail) return route.abort();
    const cur = new URL(route.request().url()).searchParams.get('currency').toLowerCase();
    const snap = JSON.parse(readFileSync(join(DOCS, `data/${cur}.json`)));
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    await route.fulfill({
      status: 200, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ jsonrpc: '2.0', usOut: snap.meta.fetchedAtMs * 1000, result: snap.result }),
    });
  });
}
