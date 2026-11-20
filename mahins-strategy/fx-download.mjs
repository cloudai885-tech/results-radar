// Downloads 3 years of 1-minute BID candles (Dukascopy, free) for the strategy test, month by month.
// Saved as compact arrays [utc_ms, open, high, low, close] in mahins-strategy/data/<pair>-m1.json (not in git).
//   node fx-download.mjs            (from inside mahins-strategy)
import fs from 'node:fs';
import { getHistoricalRates } from 'dukascopy-node';

const FROM = new Date('2023-11-01T00:00:00Z'), TO = new Date('2026-11-20T00:00:00Z');
const PAIRS = (process.argv[2] ?? 'eurusd,xauusd').split(',');
fs.mkdirSync(new URL('./data/', import.meta.url), { recursive: true });
for (const pair of PAIRS) {
  const file = new URL(`./data/${pair}-m1.json`, import.meta.url);
  const all = [];
  for (let m = new Date(FROM); m < TO; m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))) {
    const end = new Date(Math.min(+TO, Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1)));
    let rows = null;
    for (let a = 1; a <= 4 && !rows; a++) {
      try { rows = await getHistoricalRates({ instrument: pair, dates: { from: m, to: end }, timeframe: 'm1', priceType: 'bid', format: 'array', batchSize: 10, pauseBetweenBatchesMs: 300 }); }
      catch (e) { console.log(`  ${pair} ${m.toISOString().slice(0, 7)} attempt ${a} failed: ${e.message}`); await new Promise((r) => setTimeout(r, 5000 * a)); }
    }
    if (!rows) { console.log(`  ${pair} ${m.toISOString().slice(0, 7)} SKIPPED`); continue; }
    for (const r of rows) all.push([r[0], r[1], r[2], r[3], r[4]]);
    console.log(`${pair} ${m.toISOString().slice(0, 7)}: ${rows.length} bars (total ${all.length})`);
  }
  fs.writeFileSync(file, JSON.stringify(all));
  console.log(`${pair}: saved ${all.length} bars`);
}
