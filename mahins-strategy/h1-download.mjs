// Downloads 1-HOUR BID candles 2012-01 .. 2026-11 (Dukascopy) for the long-history check of the RSI(2) strategy.
// Saved as [utc_ms, open, high, low, close] in data/<instrument>-h1.json (not in git).
//   node h1-download.mjs usa500idxusd,usatechidxusd
import fs from 'node:fs';
import { getHistoricalRates } from 'dukascopy-node';

const LIST = (process.argv[2] ?? 'usa500idxusd,usatechidxusd,usa30idxusd,deuidxeur,jpnidxjpy').split(',');
for (const ins of LIST) {
  const all = [];
  for (let y = 2012; y <= 2026; y++) {
    const from = new Date(Date.UTC(y, 0, 1)), to = new Date(Math.min(Date.UTC(y + 1, 0, 1), Date.UTC(2026, 10, 20)));
    let rows = null;
    for (let a = 1; a <= 4 && !rows; a++) {
      try { rows = await getHistoricalRates({ instrument: ins, dates: { from, to }, timeframe: 'h1', priceType: 'bid', format: 'array', batchSize: 10, pauseBetweenBatchesMs: 300 }); }
      catch (e) { console.log(`  ${ins} ${y} attempt ${a} failed: ${e.message}`); await new Promise((r) => setTimeout(r, 5000 * a)); }
    }
    if (!rows) { console.log(`  ${ins} ${y} SKIPPED`); continue; }
    for (const r of rows) all.push([r[0], r[1], r[2], r[3], r[4]]);
    console.log(`${ins} ${y}: ${rows.length} bars`);
  }
  fs.writeFileSync(new URL(`./data/${ins}-h1.json`, import.meta.url), JSON.stringify(all));
  console.log(`${ins}: saved ${all.length} bars`);
}
