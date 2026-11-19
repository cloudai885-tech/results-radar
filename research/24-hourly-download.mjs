// Step 24: hourly prices (Yahoo keeps ~2.9 years) for every liquid stock in research/symbols.txt, so intraday ideas
// can be tested on years instead of the 60 days of 5-minute data. Bars start 9:15, 10:15, ..., 15:15 (last one 15 min).
// Output: data/research/hourly.json = { SYMBOL: { 'YYYY-MM-DD': [[hhmm, open, high, low, close, volume], ...] } }
//   node research/24-hourly-download.mjs
import fs from 'node:fs';
import { fetchCached, mapPool } from '../src/sources.mjs';

const OUT = new URL('../data/research/hourly.json', import.meta.url);
const symbols = fs.readFileSync(new URL('./symbols.txt', import.meta.url), 'utf8').split(/\s+/).filter(Boolean);
const all = {};
let ok = 0, failed = 0;
await mapPool(symbols, 4, async (symbol) => {
  const body = await fetchCached(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}.NS?range=730d&interval=1h`, { ttlHours: 24, attempts: 3 }).catch(() => null);
  const r = body ? JSON.parse(body).chart?.result?.[0] : null;
  if (!r?.timestamp) { failed++; return; }
  const q = r.indicators.quote[0], days = {};
  r.timestamp.forEach((t, i) => {
    if (q.open[i] == null || q.close[i] == null) return;
    const ist = new Date((t + 19800) * 1000).toISOString();
    const hhmm = Number(ist.slice(11, 13) + ist.slice(14, 16));
    if (hhmm < 915 || hhmm > 1515) return;
    (days[ist.slice(0, 10)] ??= []).push([hhmm, q.open[i], q.high[i], q.low[i], q.close[i], q.volume[i] ?? 0]);
  });
  all[symbol] = days;
  ok++;
}, (done) => { if (done % 200 === 0) console.log(`  ${done}/${symbols.length}`); });
fs.writeFileSync(OUT, JSON.stringify(all));
console.log(`Saved ${ok} stocks (${failed} failed) to data/research/hourly.json`);
