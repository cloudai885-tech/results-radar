// Step 18: the user's "first pull" idea. Strong good news overnight -> buy at the 9:15 open (pre-open order) ->
// sell as soon as the push stops. 1-minute candles (Yahoo keeps ~7 days). Uses the blind grades from step 16.
//   node research/18-open-pull.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fetchCached } from '../src/sources.mjs';

const G = new URL('../data/research/grades/', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const DAYS = ['2026-11-11', '2026-11-12', '2026-11-13', '2026-11-16', '2026-11-17'];
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const pct = (v, d = 1) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : '-');
const COST = 0.004;

const map = new Map(fs.readFileSync(path.join(G, 'all-map.txt'), 'utf8').trim().split('\n').map((l) => { const [id, d, s] = l.split('|'); return [id, { d, s }]; }));
const grade = new Map();
for (const f of fs.readdirSync(G).filter((f) => /^g\d+\.txt$/.test(f))) for (const t of fs.readFileSync(path.join(G, f), 'utf8').split(/\s+/)) { const [id, g] = t.split(':'); if (g !== undefined) grade.set(id, Number(g)); }
const strength = new Map(fs.readFileSync(path.join(G, 'strength.txt'), 'utf8').split(/\s+/).filter(Boolean).map((t) => t.split(':')).map(([a, b]) => [a, Number(b)]));

async function bars1(symbol, iso) {
  const p1 = Math.floor(Date.parse(iso + 'T03:45:00Z') / 1000), p2 = p1 + 6.25 * 3600;
  const body = await fetchCached(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol + '.NS')}?period1=${p1}&period2=${p2}&interval=1m`, { ttlHours: 1e6, attempts: 3 }).catch(() => null);
  const r = body ? JSON.parse(body).chart?.result?.[0] : null;
  if (!r?.timestamp) return null;
  const q = r.indicators.quote[0];
  return { prev: r.meta?.chartPreviousClose, bars: r.timestamp.map((t, i) => { const d = new Date((t + 19800) * 1000); return { m: d.getUTCHours() * 60 + d.getUTCMinutes(), o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] }; }).filter((b) => b.c != null && b.o != null) };
}
// buy at the first price of the day; sell when the price falls `trail` below the best price since the buy (or a hard stop)
function ride(bars, trail, stop = 0.02, maxMin = 15 * 60 + 20) {
  const px = bars[0].o;
  let peak = px;
  for (const b of bars) {
    if (b.m > maxMin) break;
    const s = Math.max(px * (1 - stop), peak * (1 - trail));
    if (b.l <= s) return { ret: Math.min(b.o, s) / px - 1 - COST, best: peak / px - 1, min: b.m };
    peak = Math.max(peak, b.h);
  }
  const last = bars.filter((b) => b.m <= maxMin).at(-1);
  return { ret: last.c / px - 1 - COST, best: peak / px - 1, min: last.m };
}

// previous close from NSE's own daily file (Yahoo's chartPreviousClose is unreliable for a date range)
const mk = JSON.parse(fs.readFileSync(new URL('../data/research/market.json', import.meta.url), 'utf8'));
const nsePrev = (s, d) => { const i = mk.days.indexOf(d); const r = mk.stocks[s]?.find((x) => x[0] === i); return r ? r[1] : null; };
const rows = [];
for (const [id, { d, s }] of map) {
  if (!DAYS.includes(d) || grade.get(id) !== 2) continue;
  const b = await bars1(s, d);
  const prev = nsePrev(s, d);
  if (!b || b.bars.length < 200 || b.bars[0].m > 9 * 60 + 16 || !prev) continue;
  rows.push({ d, s, str: strength.get(id) ?? 0, gap: b.bars[0].o / prev - 1, first5: b.bars.find((x) => x.m === 9 * 60 + 19)?.c / b.bars[0].o - 1, bars: b.bars });
}
console.log(`STRONG GOOD overnight news, bought at the 9:15 open, 1-minute candles: ${rows.length} stock-days (${DAYS[0]}..${DAYS.at(-1)}). Costs ${pct(COST)}.\n`);
const exits = [['sell on 0.5% drop from best', 0.005], ['sell on 1% drop from best', 0.01], ['sell on 1.5% drop from best', 0.015], ['sell on 2% drop from best', 0.02]];
const groups = [
  ['all strong news', () => true],
  ['opened 0..+2% (not priced in)', (r) => r.gap >= 0 && r.gap < 0.02],
  ['opened +2..+5%', (r) => r.gap >= 0.02 && r.gap < 0.05],
  ['opened +5% or more', (r) => r.gap >= 0.05],
  ['opened down', (r) => r.gap < 0],
  ['strength 8-9 only', (r) => r.str >= 8],
];
for (const [gl, gf] of groups) {
  const g = rows.filter(gf);
  if (!g.length) continue;
  console.log(`${gl} (n=${g.length}):`);
  for (const [el, t] of exits) { const v = g.map((r) => ride(r.bars, t).ret); console.log(`    ${el.padEnd(30)} avg ${pct(mean(v), 2).padStart(7)}  won ${pct(v.filter((x) => x > 0).length / v.length, 0)}`); }
}
console.log('\nBEST 1-3 PER DAY by news strength, buy 9:15 open, sell on 1% drop from best:');
for (const n of [1, 2, 3]) {
  const per = DAYS.map((d) => rows.filter((r) => r.d === d).sort((a, z) => z.str - a.str).slice(0, n)).filter((p) => p.length).map((p) => ({ d: p[0].d, v: mean(p.map((r) => ride(r.bars, 0.01).ret)), p }));
  console.log(`  best ${n}: total ${pct(per.reduce((s, x) => s + x.v, 0))} over ${per.length} days, ${per.filter((x) => x.v > 0).length} green`);
  for (const x of per) console.log(`     ${x.d} ${pct(x.v).padStart(6)}  ${x.p.map((r) => `${r.s}(gap ${pct(r.gap)}, ${pct(ride(r.bars, 0.01).ret)})`).join('  ')}`);
}
console.log('\nEvery stock: open gap, first 5 minutes, result with 1% trail, best price reached');
for (const r of rows.sort((a, z) => (a.d + a.s).localeCompare(z.d + z.s))) { const x = ride(r.bars, 0.01); console.log(`  ${r.d} ${r.s.padEnd(12)} str ${r.str} gap ${pct(r.gap).padStart(6)} first5min ${pct(r.first5).padStart(6)} | trade ${pct(x.ret).padStart(6)} best ${pct(x.best).padStart(6)} sold ${Math.floor(x.min / 60)}:${String(x.min % 60).padStart(2, '0')}`); }
