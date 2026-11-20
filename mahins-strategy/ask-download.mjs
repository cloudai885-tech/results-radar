// Downloads 1-HOUR ASK candles 2018-2026 (Dukascopy) to check patterns with real buy prices: data/<pair>-h1ask.json
import fs from 'node:fs';
import { getHistoricalRates } from 'dukascopy-node';
for (const ins of (process.argv[2] ?? 'eurusd,gbpusd,usdjpy').split(',')) {
  const all = [];
  for (let y = 2018; y <= 2026; y++) {
    let rows = null;
    for (let a = 1; a <= 4 && !rows; a++) {
      try { rows = await getHistoricalRates({ instrument: ins, dates: { from: new Date(Date.UTC(y, 0, 1)), to: new Date(Math.min(Date.UTC(y + 1, 0, 1), Date.UTC(2026, 10, 20))) }, timeframe: 'h1', priceType: 'ask', format: 'array', batchSize: 10, pauseBetweenBatchesMs: 300 }); }
      catch (e) { console.log(`${ins} ${y} attempt ${a}: ${e.message}`); await new Promise((r) => setTimeout(r, 5000 * a)); }
    }
    if (rows) for (const r of rows) all.push([r[0], r[1], r[2], r[3], r[4]]);
  }
  fs.writeFileSync(new URL(`./data/${ins}-h1ask.json`, import.meta.url), JSON.stringify(all));
  console.log(`${ins}: saved ${all.length} ask bars`);
}
