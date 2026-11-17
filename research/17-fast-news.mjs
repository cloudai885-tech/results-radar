// Step 17: the user's live strategy. News comes out DURING market hours -> read it at once -> buy within ~2 minutes
// -> sell when the momentum stops. Tested on 1-minute candles (Yahoo keeps ~7 days of them).
//   node research/17-fast-news.mjs export <out.txt>     list of in-hours news (no prices) for blind grading
//   node research/17-fast-news.mjs test <grades.txt>    simulate with the grades ("id:grade:strength")
import fs from 'node:fs';
import { fetchCached } from '../src/sources.mjs';
import { typeOf } from './news-types.mjs';

const DIR = new URL('../data/research/', import.meta.url);
const read = (f) => JSON.parse(fs.readFileSync(new URL(f, DIR), 'utf8'));
const { days, stocks } = read('market.json');
const news = read('news.json').items;
const DAYS = ['2026-11-11', '2026-11-12', '2026-11-13', '2026-11-16', '2026-11-17'];
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const pct = (v, d = 1) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : '-');
const COST = 0.004;

// liquidity from the last 20 sessions in market.json
const liq = new Map();
for (const [s, rows] of Object.entries(stocks)) { const a = rows.slice(-20).map((r) => r[6]); if (a.length >= 10) liq.set(s, median(a)); }

// in-hours filings, first material one per stock-day
const items = [];
const seen = new Set();
for (const n of news.sort((a, b) => a.time.localeCompare(b.time))) {
  const d = n.time.slice(0, 10), hm = n.time.slice(11, 16);
  if (!DAYS.includes(d) || hm < '09:16' || hm > '15:00' || !(liq.get(n.symbol) >= 3)) continue;
  const t = typeOf(n.desc, n.text);
  if (['routine', 'meeting', 'management', 'board-meet', 'rating'].includes(t)) continue;
  const k = `${n.symbol}|${d}`;
  if (seen.has(k)) continue;
  seen.add(k);
  items.push({ id: items.length, d, hm, symbol: n.symbol, type: t, text: (n.text || n.desc).replace(/^.*?has (informed|submitted)( to)? the Exchange,? (about|regarding|that)? ?/i, '').replace(/\s+/g, ' ').slice(0, 220) });
}

if (process.argv[2] === 'export') {
  fs.writeFileSync(process.argv[3], items.map((x) => `${x.id}|${x.symbol}|${x.type}|${x.text}`).join('\n'));
  console.log(`${items.length} in-hours news items written (no prices).`);
  process.exit(0);
}

// ---- test ----
const grades = new Map(fs.readFileSync(process.argv[3], 'utf8').split(/\s+/).filter(Boolean).map((t) => { const [id, g, s] = t.split(':'); return [Number(id), { g: Number(g), s: Number(s ?? 0) }]; }));
async function bars1(symbol, iso) {
  const p1 = Math.floor(Date.parse(iso + 'T03:45:00Z') / 1000), p2 = p1 + 6.25 * 3600;
  const body = await fetchCached(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol + '.NS')}?period1=${p1}&period2=${p2}&interval=1m`, { ttlHours: iso === DAYS.at(-1) ? 0.2 : 1e6, attempts: 3 }).catch(() => null);
  const r = body ? JSON.parse(body).chart?.result?.[0] : null;
  if (!r?.timestamp) return null;
  const q = r.indicators.quote[0];
  return { prev: r.meta?.chartPreviousClose, bars: r.timestamp.map((t, i) => { const d = new Date((t + 19800) * 1000); return { m: d.getUTCHours() * 60 + d.getUTCMinutes(), o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] ?? 0 }; }).filter((b) => b.c != null && b.o != null) };
}
const toMin = (hm) => +hm.slice(0, 2) * 60 + +hm.slice(3, 5);
// buy at the close of the minute that ends DELAY minutes after the filing; then trail from the best price
function trade(bars, fMin, delay, trail) {
  const i = bars.findIndex((b) => b.m >= fMin + delay - 1);
  if (i < 0 || bars[i].m > 15 * 60 + 10) return null;
  const px = bars[i].c;
  let peak = px;
  for (const b of bars.slice(i + 1)) {
    if (b.m > 15 * 60 + 20) break;
    const stop = Math.max(px * 0.98, peak * (1 - trail));
    if (b.l <= stop) return { px, ret: Math.min(b.o, stop) / px - 1 - COST, best: peak / px - 1 };
    peak = Math.max(peak, b.h);
  }
  const last = bars.filter((b) => b.m <= 15 * 60 + 20).at(-1);
  return { px, ret: last.c / px - 1 - COST, best: peak / px - 1 };
}
// results: the live bot would read the result PDF; here the real numbers (Screener, Sep 2026 quarter) stand in for that
const funda = read('fundamentals.json');
function resultGrade(sym) {
  const q = funda[sym]?.q; if (!q) return null;
  const c = q[8106], p = q[8105], y = q[8102]; if (!c || !p || !y) return null;
  if (c.pat > p.pat && c.pat > y.pat && p.pat > 0 && c.pat > 0) return { g: 2, s: c.pat >= 1.5 * Math.max(p.pat, y.pat) ? 9 : c.pat >= 1.2 * Math.max(p.pat, y.pat) ? 8 : 6 };
  return { g: c.pat < p.pat && c.pat < y.pat ? -1 : 1, s: 0 };
}
const rows = [];
for (const x of items) {
  const g = x.type === 'result' ? resultGrade(x.symbol) : grades.get(x.id);
  if (!g || g.g < 2) continue;
  const b = await bars1(x.symbol, x.d);
  if (!b || b.bars.length < 100) continue;
  const fMin = toMin(x.hm);
  const before = b.bars.filter((k) => k.m < fMin).at(-1);
  const r = { ...x, ...g, preMove: before && b.prev ? before.c / b.prev - 1 : NaN, dayHigh: Math.max(...b.bars.filter((k) => k.m >= fMin).map((k) => k.h)) };
  for (const delay of [1, 2, 5]) for (const trail of [0.01, 0.015, 0.02]) r[`d${delay}t${trail}`] = trade(b.bars, fMin, delay, trail);
  r.upAfter = r["d2t0.015"] ? r.dayHigh / r["d2t0.015"].px - 1 : NaN;
  rows.push(r);
}
console.log(`STRONG GOOD news during market hours, ${DAYS[0]}..${DAYS.at(-1)}: ${rows.length} with 1-minute candles. Costs ${pct(COST, 1)} per trade.\n`);
for (const delay of [1, 2, 5]) for (const trail of [0.01, 0.015, 0.02]) {
  const k = `d${delay}t${trail}`;
  const v = rows.map((r) => r[k]?.ret).filter(Number.isFinite);
  console.log(`buy ${delay} min after news, sell when it falls ${trail * 100}% from its best: ${v.length} trades, avg ${pct(mean(v), 2)}, won ${pct(v.filter((x) => x > 0).length / v.length, 0)}`);
}
console.log(`\nWent 2%+ above the 2-minute buy price at some point that day: ${pct(rows.filter((r) => r.upAfter >= 0.02).length / rows.length, 0)}`);
// pick the best 1-3 per day by strength (news known at that moment; earlier news first when tied)
for (const n of [1, 2, 3]) {
  const per = [];
  for (const d of DAYS) {
    const picks = rows.filter((r) => r.d === d && r["d2t0.015"]).sort((a, z) => z.s - a.s || a.hm.localeCompare(z.hm)).slice(0, n);
    if (picks.length) per.push({ d, v: mean(picks.map((p) => p["d2t0.015"].ret)), picks });
  }
  console.log(`\nBEST ${n} PER DAY (buy 2 min after, sell on 1.5% drop from best): total ${pct(per.reduce((s, x) => s + x.v, 0))} over ${per.length} days, ${per.filter((x) => x.v > 0).length} green`);
  for (const x of per) console.log(`  ${x.d} ${pct(x.v).padStart(6)}  ${x.picks.map((p) => `${p.symbol}@${p.hm}(str ${p.s}, ${pct(p["d2t0.015"].ret)})`).join('  ')}`);
}
console.log('\nEvery strong-news trade (2-min buy, 1.5% trail):');
for (const r of rows.sort((a, z) => (a.d + a.hm).localeCompare(z.d + z.hm))) console.log(`  ${r.d} ${r.hm} ${r.symbol.padEnd(11)} str ${r.s} | before news ${pct(r.preMove).padStart(6)} | trade ${pct(r["d2t0.015"]?.ret).padStart(6)} best ${pct(r["d2t0.015"]?.best).padStart(6)} | ${r.text.slice(0, 80)}`);
