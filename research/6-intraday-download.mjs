// Step 6: 5-minute prices (Yahoo keeps the last ~60 days) for every liquid stock in research/symbols.txt.
// Output: data/research/intraday.json = { SYMBOL: { 'YYYY-MM-DD': [[hhmm, open, high, low, close, volume], ...] } }
// Run it again every few weeks: new days are merged in, so the history grows past 60 days.
import fs from 'node:fs';
import { fetchCached, mapPool } from '../src/sources.mjs';

const OUT = new URL('../data/research/intraday.json', import.meta.url);
const symbols = fs.readFileSync(new URL('./symbols.txt', import.meta.url), 'utf8').split(/\s+/).filter(Boolean);
const all = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
let ok = 0, failed = 0;
await mapPool(symbols, 2, async (symbol) => {
  const body = await fetchCached(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}.NS?range=60d&interval=5m`, { ttlHours: 6, attempts: 3 }).catch(() => null);
  const r = body ? JSON.parse(body).chart?.result?.[0] : null;
  if (!r?.timestamp) { failed++; return; }
  const q = r.indicators.quote[0];
  const days = all[symbol] ?? {};
  r.timestamp.forEach((t, i) => {
    if (q.open[i] == null || q.close[i] == null) return;
    const ist = new Date((t + 19800) * 1000).toISOString();
    const day = ist.slice(0, 10), hhmm = Number(ist.slice(11, 13) + ist.slice(14, 16));
    if (hhmm < 915 || hhmm > 1525) return;
    const list = (days[day] ??= []);
    const bar = [hhmm, +q.open[i].toFixed(2), +q.high[i].toFixed(2), +q.low[i].toFixed(2), +q.close[i].toFixed(2), q.volume[i] ?? 0];
    const at = list.findIndex((b) => b[0] === hhmm);
    if (at >= 0) list[at] = bar; else list.push(bar);
  });
  for (const d of Object.keys(days)) days[d].sort((a, b) => a[0] - b[0]);
  all[symbol] = days;
  ok++;
}, (done, total) => { if (done % 100 === 0) console.log(`  ${done}/${total}`); });
fs.writeFileSync(OUT, JSON.stringify(all));
const dayCount = new Set(Object.values(all).flatMap((d) => Object.keys(d))).size;
console.log(`Saved ${ok} stocks (${failed} failed), ${dayCount} trading days.`);
