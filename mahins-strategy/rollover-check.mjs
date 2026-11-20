// Rechecks the time-of-day FX patterns from wide-search.mjs with REAL fills: buy at the ASK, sell at the BID
// (hourly Dukascopy bid + ask candles), plus commission + slippage. Patterns near 17:00 NY sit on the daily rollover,
// when spreads widen; with bid-only data that can look like a price move.
import fs from 'node:fs';
const NY = 'America/New_York';
const fmt = new Intl.DateTimeFormat('en-US', { timeZone: NY, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short' });
const ny = (t) => { const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value])); return { hour: Number(p.hour) % 24, wd: p.weekday }; };
const rollWd = (t) => ny(t + 7 * 3600000).wd;
const EXTRA = { eurusd: 0.00008, gbpusd: 0.00008, usdjpy: 0.008 }; // commission + slippage, spread is now real
const PATTERNS = [ // [pair, dir, startHourNY, hours, weekday of the trading day or null]
  ['usdjpy', 1, 17, 2, 'Mon'], ['usdjpy', 1, 17, 3, 'Mon'], ['usdjpy', 1, 18, 1, 'Mon'], ['usdjpy', 1, 17, 4, 'Mon'], ['usdjpy', 1, 17, 1, 'Mon'],
  ['gbpusd', 1, 17, 3, 'Mon'], ['gbpusd', 1, 17, 2, 'Mon'], ['gbpusd', -1, 16, 1, 'Fri'],
  ['eurusd', 1, 17, 2, 'Thu'], ['eurusd', 1, 17, 3, 'Thu'], ['eurusd', 1, 17, 2, null], ['gbpusd', 1, 17, 2, null],
];
const st = (r) => { const n = r.length, a = r.reduce((s, x) => s + x, 0) / n, sd = Math.sqrt(r.reduce((s, x) => s + (x - a) ** 2, 0) / (n - 1)); return `${String(n).padStart(4)} tr won ${(r.filter((x) => x > 0).length / n * 100).toFixed(0).padStart(3)}% avg ${(a * 100).toFixed(4).padStart(8)}% t ${(a / (sd / Math.sqrt(n))).toFixed(2).padStart(6)}`; };
const load = (f) => new Map(JSON.parse(fs.readFileSync(new URL(`./data/${f}.json`, import.meta.url), 'utf8')).filter((r) => r[0] >= Date.parse('2018-03-01')).map((r) => [r[0], r]));
const cache = {};
const lines = [];
for (const [pair, dir, sh, L, wd] of PATTERNS) {
  const bid = (cache[pair + 'b'] ??= load(`${pair}-h1`)), ask = (cache[pair + 'a'] ??= load(`${pair}-h1ask`));
  const bidOnly = [], real = [], spreads = [];
  for (const [t, b0] of bid) {
    const h = ny(t); if (h.hour !== sh) continue; if (wd && rollWd(t) !== wd) continue;
    const tEnd = t + (L - 1) * 3600000, b1 = bid.get(tEnd), a0 = ask.get(t), a1 = ask.get(tEnd); if (!b1 || !a0 || !a1) continue;
    bidOnly.push(dir * (b1[4] / b0[1] - 1));
    const entry = dir > 0 ? a0[1] : b0[1], exit = dir > 0 ? b1[4] : a1[4];
    real.push(dir * (exit / entry - 1) - EXTRA[pair] / entry);
    spreads.push(a0[1] - b0[1]);
  }
  const pip = pair === 'usdjpy' ? 0.01 : 0.0001; spreads.sort((a, b) => a - b);
  lines.push(`${pair} ${dir > 0 ? 'LONG ' : 'SHORT'} ${sh}:00 +${L}h ${(wd ?? 'every day').padEnd(9)} | bid only, no costs: ${st(bidOnly)} | REAL bid/ask + costs: ${st(real)} | spread at entry: median ${(spreads[spreads.length >> 1] / pip).toFixed(1)} pips`);
}
console.log(lines.join('\n'));
fs.writeFileSync(new URL('./results/rollover-check.txt', import.meta.url), lines.join('\n'));
