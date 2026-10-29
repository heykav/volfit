// Saves a labelled snapshot of the live Deribit option books for the offline fallback.
// Usage: node scripts/snapshot.mjs
import { writeFileSync } from 'node:fs';
import { API } from '../docs/lib/deribit.js';

for (const cur of ['BTC', 'ETH']) {
  const url = `${API}?currency=${cur}&kind=option`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${cur}: HTTP ${res.status}`);
  const j = await res.json();
  const fetchedAtMs = Math.round((j.usOut || j.usIn) / 1000);
  const result = j.result.map(r => ({
    instrument_name: r.instrument_name, bid_price: r.bid_price, ask_price: r.ask_price,
    mark_iv: r.mark_iv, underlying_price: r.underlying_price, open_interest: r.open_interest, volume: r.volume,
  }));
  const meta = { source: 'Deribit public API', url, currency: cur, fetched_at_utc: new Date(fetchedAtMs).toISOString(), fetchedAtMs, instruments: result.length };
  writeFileSync(new URL(`../docs/data/${cur.toLowerCase()}.json`, import.meta.url), JSON.stringify({ meta, result }));
  console.log(cur, meta.fetched_at_utc, result.length);
}
