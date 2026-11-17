// Step 20: 91% of the ~46 daily gainers have NO news, and their gain comes AFTER 9:15 (step 19).
// So: can we catch them during the day from price + volume alone (buyers suddenly flooding in)?
// Every liquid stock, last month, 5-minute candles. Signal = first 5-min candle (9:30..13:30) where
//   price is X% above yesterday's close AND above the open AND that candle's volume is K times the stock's normal 5-min volume.
// Buy at that candle's close, sell when it falls T% from its best (or -2% stop, or 3:15 pm).
//   node research/20-intraday-momentum.mjs
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fetchCached, mapPool } from '../src/sources.mjs';

const R = fileURLToPath(new URL('../data/research/', import.meta.url));
const mk = JSON.parse(fs.readFileSync(path.join(R, 'market.json'), 'utf8'));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (v, d = 1) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1 * d)}%` : '-');
const COST = 0.004;
const DAYS = mk.days.filter((d) => d >= '2026-10-21');
const FIRST_HALF = (d) => d < '2026-11-03';

const syms = Object.entries(mk.stocks).filter(([, rows]) => med(rows.filter((r) => mk.days[r[0]] < DAYS[0]).slice(-20).map((r) => r[6])) >= 5).map(([s]) => s);
const prevOf = new Map();
for (const s of syms) for (const r of mk.stocks[s]) prevOf.set(`${mk.days[r[0]]}|${s}`, r[1]);
console.log(`${syms.length} liquid stocks, ${DAYS.length} days (${DAYS[0]}..${DAYS.at(-1)}). Downloading 5-minute candles...`);

const data = new Map(); // symbol -> Map(day -> bars)
let done = 0;
await mapPool(syms, 4, async (s) => {
  const body = await fetchCached(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s + '.NS')}?range=1mo&interval=5m`, { ttlHours: 12, attempts: 2 }).catch(() => null);
  if (++done % 200 === 0) console.log(`  ${done}/${syms.length}`);
  const r = body ? JSON.parse(body).chart?.result?.[0] : null;
  if (!r?.timestamp) return;
  const q = r.indicators.quote[0], m = new Map();
  for (let i = 0; i < r.timestamp.length; i++) {
    if (q.close[i] == null || q.open[i] == null) continue;
    const t = new Date((r.timestamp[i] + 19800) * 1000), d = t.toISOString().slice(0, 10);
    (m.get(d) ?? m.set(d, []).get(d)).push({ m: t.getUTCHours() * 60 + t.getUTCMinutes(), o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] ?? 0 });
  }
  data.set(s, m);
});
console.log(`Got candles for ${data.size} stocks.`);

function ride(b, i, trail) {
  const px = b[i].c;
  let peak = px;
  for (let j = i + 1; j < b.length; j++) {
    const x = b[j]; if (x.m > 15 * 60 + 15) break;
    const stop = Math.max(px * 0.98, peak * (1 - trail));
    if (x.l <= stop) return Math.min(x.o, stop) / px - 1 - COST;
    peak = Math.max(peak, x.h);
  }
  return b.filter((x) => x.m <= 15 * 60 + 15).at(-1).c / px - 1 - COST;
}
// signals for one setting
function signals(X, K) {
  const out = [];
  for (const [s, m] of data) {
    const days = [...m.keys()].sort();
    for (const d of DAYS) {
      const b = m.get(d), prev = prevOf.get(`${d}|${s}`);
      if (!b || !prev || b.length < 60 || b[0].m !== 555) continue;
      // normal 5-min volume = median over the previous 5 days' candles
      const past = days.filter((x) => x < d).slice(-5).flatMap((x) => m.get(x).map((k) => k.v)).filter((v) => v > 0);
      if (past.length < 100) continue;
      const nv = med(past);
      for (let i = 3; i < b.length; i++) {
        const k = b[i]; if (k.m > 13 * 60 + 30) break;
        if (k.c / prev - 1 >= X && k.c > b[0].o && k.c > k.o && k.v >= K * nv) {
          out.push({ s, d, i, b, min: k.m, up: k.c / prev - 1, volx: k.v / nv, dayClose: b.at(-1).c / prev - 1 });
          break;
        }
      }
    }
  }
  return out;
}
const lines = [];
const P = (...a) => { const l = a.join(' '); console.log(l); lines.push(l); };
P(`\nINTRADAY MOMENTUM (no news needed): ${data.size} stocks, ${DAYS.length} days. Costs ${pct(COST)}.`);
P('Signal: first 5-min candle 9:30-13:30 that is green, above the open, X% above yesterday, with K x normal volume. Buy at its close.\n');
const best = [];
for (const X of [0.02, 0.03, 0.04, 0.05]) for (const K of [3, 5, 10]) {
  const sg = signals(X, K);
  if (sg.length < 10) continue;
  const cells = [0.01, 0.015, 0.02, 0.03].map((t) => { const v = sg.map((x) => ride(x.b, x.i, t)); return `${t * 100}%: ${pct(mean(v), 2).padStart(6)} won ${pct(v.filter((y) => y > 0).length / v.length, 0)}`; });
  const v15 = sg.map((x) => ride(x.b, x.i, 0.015));
  const h1 = sg.filter((x) => FIRST_HALF(x.d)).map((x) => ride(x.b, x.i, 0.015)), h2 = sg.filter((x) => !FIRST_HALF(x.d)).map((x) => ride(x.b, x.i, 0.015));
  P(`  +${X * 100}% & ${String(K).padStart(2)}x vol: ${String(sg.length).padStart(4)} signals (${(sg.length / DAYS.length).toFixed(0)}/day), closed +5%: ${pct(sg.filter((x) => x.dayClose >= 0.05).length / sg.length, 0)} | ${cells.join(' | ')} | halves ${pct(mean(h1), 2)} / ${pct(mean(h2), 2)}`);
  best.push({ X, K, sg, v: mean(v15) });
}
// pick best 1-3 per day: earliest signals first (the user buys the first strong push)
const top = best.sort((a, z) => z.v - a.v)[0];
P(`\nPICK FIRST 1-3 SIGNALS PER DAY with the best setting (+${top.X * 100}%, ${top.K}x volume), sell on 1.5% drop from best:`);
for (const n of [1, 2, 3]) {
  const per = DAYS.map((d) => { const p = top.sg.filter((x) => x.d === d).sort((a, z) => a.min - z.min || z.volx - a.volx).slice(0, n); return p.length ? { d, v: mean(p.map((x) => ride(x.b, x.i, 0.015))), p } : null; }).filter(Boolean);
  P(`  first ${n}: ${per.length} days, total ${pct(per.reduce((s, x) => s + x.v, 0))}, avg/day ${pct(mean(per.map((x) => x.v)), 2)}, green days ${per.filter((x) => x.v > 0).length}/${per.length}`);
  if (n === 1) for (const x of per) P(`     ${x.d} ${x.p.map((y) => `${y.s} at ${Math.floor(y.min / 60)}:${String(y.min % 60).padStart(2, '0')} (day ${pct(y.up)}, ${y.volx.toFixed(0)}x vol) -> ${pct(ride(y.b, y.i, 0.015))}, closed day ${pct(y.dayClose)}`).join('  ')}`);
}
fs.writeFileSync(path.join(R, 'momentum-report.txt'), lines.join('\n'));
