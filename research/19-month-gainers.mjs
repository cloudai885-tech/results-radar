// Step 19: the user's question - "50-70 stocks go up every day, is +5% open really the only thing that works?"
// One month (the days with blind news grades, Oct 21 - Nov 16 2026), every liquid stock, 5-minute candles.
//  A. The daily gainers (close +5% or more): how much of the gain was ALREADY in the opening price, how much came after 9:15?
//  B. Strong overnight news, every opening level: buy at 9:15 / after the first 5-min candle if green / 9:30 rule,
//     sell when it falls X% from its best. Also stocks with NO news that open up (price-only).
//   node research/19-month-gainers.mjs
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fetchCached, mapPool } from '../src/sources.mjs';

const R = fileURLToPath(new URL('../data/research/', import.meta.url));
const G = path.join(R, 'grades');
const mk = JSON.parse(fs.readFileSync(path.join(R, 'market.json'), 'utf8'));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (v, d = 1) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : '-');
const COST = 0.004;

// blind grades (the model never saw prices): id -> {day, symbol}, grade, strength
const map = new Map(fs.readFileSync(path.join(G, 'all-map.txt'), 'utf8').trim().split('\n').map((l) => { const [id, d, s] = l.split('|'); return [id, { d, s }]; }));
const grade = new Map();
for (const f of fs.readdirSync(G).filter((f) => /^g\d+\.txt$/.test(f))) for (const t of fs.readFileSync(path.join(G, f), 'utf8').split(/\s+/)) { const [id, g] = t.split(':'); if (g !== undefined) grade.set(id, Number(g)); }
const strength = new Map(fs.readFileSync(path.join(G, 'strength.txt'), 'utf8').split(/\s+/).filter(Boolean).map((t) => t.split(':')).map(([a, b]) => [a, Number(b)]));
const newsOf = new Map(); // "day|symbol" -> best grade / strength
for (const [id, { d, s }] of map) {
  const g = grade.get(id); if (g === undefined) continue;
  const k = `${d}|${s}`, o = newsOf.get(k);
  if (!o || g > o.g || (g === o.g && (strength.get(id) ?? 0) > o.str)) newsOf.set(k, { g, str: strength.get(id) ?? 0 });
}
const DAYS = [...new Set([...map.values()].map((x) => x.d))].filter((d) => mk.days.includes(d)).sort();

// daily rows: [dayIndex, prevClose, open, high, low, close, turnoverCr, ...]
const day = new Map(); // "day|symbol" -> {prev, o, h, l, c, cr}
const liq = new Map();
for (const [s, rows] of Object.entries(mk.stocks)) {
  for (const r of rows) day.set(`${mk.days[r[0]]}|${s}`, { prev: r[1], o: r[2], h: r[3], l: r[4], c: r[5], cr: r[6] });
  const a = rows.filter((r) => mk.days[r[0]] < DAYS[0]).slice(-20).map((r) => r[6]);
  if (a.length >= 10) liq.set(s, med(a));
}
const liquid = (s) => (liq.get(s) ?? 0) >= 5;
const nLiquid = [...liq.values()].filter((v) => v >= 5).length;

// ---------------- A. the daily gainers ----------------
const out = [];
const P = (...a) => { const l = a.join(' '); console.log(l); out.push(l); };
P(`ONE MONTH: ${DAYS[0]} .. ${DAYS.at(-1)} (${DAYS.length} trading days), ${nLiquid} liquid stocks (Rs 5 cr+/day). Costs ${pct(COST)} per trade.\n`);
P('A. THE DAILY GAINERS (closed +5% or more). Where did the gain happen?');
const gainers = [];
for (const d of DAYS) for (const s of Object.keys(mk.stocks)) {
  const x = day.get(`${d}|${s}`); if (!x || !liquid(s) || !x.prev) continue;
  if (x.c / x.prev - 1 >= 0.05) gainers.push({ d, s, ...x, gap: x.o / x.prev - 1, day: x.c / x.prev - 1, afterOpen: x.c / x.o - 1, news: newsOf.get(`${d}|${s}`) });
}
P(`  ${gainers.length} gainers in ${DAYS.length} days = ${(gainers.length / DAYS.length).toFixed(0)} a day.`);
const share = (g) => g.map((x) => Math.log(x.o / x.prev) / Math.log(x.c / x.prev));
P(`  Median day gain ${pct(med(gainers.map((x) => x.day)))}; median opening jump ${pct(med(gainers.map((x) => x.gap)))}; median gain AFTER the 9:15 open ${pct(med(gainers.map((x) => x.afterOpen)))}.`);
P(`  Part of the day's gain already in the opening price: median ${pct(med(share(gainers)), 0)}.`);
const kinds = [['strong good news overnight', (x) => x.news?.g === 2], ['other news (mild/neutral/bad)', (x) => x.news && x.news.g !== 2], ['no news found', (x) => !x.news]];
for (const [l, f] of kinds) { const g = gainers.filter(f); P(`    ${l.padEnd(32)} ${String(g.length).padStart(4)} (${pct(g.length / gainers.length, 0)})  opened ${pct(med(g.map((x) => x.gap)))}, after open ${pct(med(g.map((x) => x.afterOpen)))}`); }
// the other side: how many stocks with strong news did NOT become gainers?
const strongAll = [...newsOf].filter(([k, v]) => v.g === 2 && liquid(k.split('|')[1]) && day.has(k)).map(([k]) => ({ k, ...day.get(k) }));
P(`  Of ${strongAll.length} stocks with strong good overnight news: ${strongAll.filter((x) => x.c / x.prev - 1 >= 0.05).length} closed +5% or more, ${strongAll.filter((x) => x.c < x.prev).length} closed DOWN.`);

// ---------------- B. trades on 5-minute candles ----------------
const cands = new Map(); // symbol -> set of days
const addC = (d, s) => (cands.get(s) ?? cands.set(s, new Set()).get(s)).add(d);
for (const [k, v] of newsOf) { const [d, s] = k.split('|'); if (v.g === 2 && liquid(s)) addC(d, s); }
for (const d of DAYS) for (const s of Object.keys(mk.stocks)) { const x = day.get(`${d}|${s}`); if (x && liquid(s) && x.prev && x.o / x.prev - 1 >= 0.02) addC(d, s); }
console.log(`\nDownloading 5-minute candles for ${cands.size} stocks...`);
const bars = new Map(); // "day|symbol" -> bars
await mapPool([...cands.keys()], 4, async (s) => {
  const body = await fetchCached(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s + '.NS')}?range=60d&interval=5m`, { ttlHours: 12, attempts: 3 }).catch(() => null);
  const r = body ? JSON.parse(body).chart?.result?.[0] : null;
  if (!r?.timestamp) return;
  const q = r.indicators.quote[0];
  for (let i = 0; i < r.timestamp.length; i++) {
    if (q.close[i] == null || q.open[i] == null) continue;
    const t = new Date((r.timestamp[i] + 19800) * 1000), d = t.toISOString().slice(0, 10);
    if (!cands.get(s).has(d)) continue;
    const k = `${d}|${s}`;
    (bars.get(k) ?? bars.set(k, []).get(k)).push({ m: t.getUTCHours() * 60 + t.getUTCMinutes(), o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] });
  }
});
// buy at px from bar index i (at its close, or at its open if atOpen); sell on `trail` drop from best or 2% stop; else 3:20 pm
function ride(b, i, atOpen, trail) {
  const px = atOpen ? b[i].o : b[i].c;
  let peak = atOpen ? px : Math.max(px, b[i].c);
  for (let j = atOpen ? i : i + 1; j < b.length; j++) {
    const x = b[j]; if (x.m > 15 * 60 + 15) break;
    const stop = Math.max(px * 0.98, peak * (1 - trail));
    if (x.l <= stop) return Math.min(x.o, stop) / px - 1 - COST;
    peak = Math.max(peak, x.h);
  }
  const last = b.filter((x) => x.m <= 15 * 60 + 15).at(-1);
  return last.c / px - 1 - COST;
}
const ENTRIES = {
  'buy 9:15 open': (b) => ({ i: 0, atOpen: true }),
  'buy 9:20 if 1st candle green': (b) => (b[0].c > b[0].o ? { i: 0, atOpen: false } : null),
  'buy 9:30 if above open': (b, prev) => { const i = b.findIndex((x) => x.m === 9 * 60 + 25); return i > 0 && b[i].c > b[0].o && b[i].c > prev ? { i, atOpen: false } : null; },
};
const rows = [];
for (const [k, b] of bars) {
  const [d, s] = k.split('|'), x = day.get(k);
  if (!x?.prev || b.length < 60 || b[0].m !== 9 * 60 + 15) continue;
  const n = newsOf.get(k);
  rows.push({ d, s, b, prev: x.prev, gap: b[0].o / x.prev - 1, strong: n?.g === 2, anyNews: !!n, str: n?.str ?? 0, cr: liq.get(s) });
}
const test = (label, set) => {
  if (!set.length) return;
  P(`\n  ${label}  (${set.length} stock-days)`);
  for (const [el, ef] of Object.entries(ENTRIES)) {
    const cells = [0.01, 0.015, 0.02, 0.03].map((t) => { const v = set.map((r) => { const e = ef(r.b, r.prev); return e ? ride(r.b, e.i, e.atOpen, t) : null; }).filter((v) => v != null); return v.length ? `${(t * 100).toFixed(1)}%: ${pct(mean(v), 2).padStart(6)} won ${pct(v.filter((y) => y > 0).length / v.length, 0).padStart(4)}` : ''; });
    const nTr = set.filter((r) => ef(r.b, r.prev)).length;
    P(`    ${el.padEnd(30)} n=${String(nTr).padStart(3)} | sell on drop from best ${cells.join(' | ')}`);
  }
};
P('\nB. TRADES, 5-minute candles. Sell when it falls 1% / 1.5% / 2% / 3% from its best (or -2% stop, or 3:15 pm).');
P('\n STRONG GOOD OVERNIGHT NEWS, by opening jump:');
const buckets = [['opened DOWN', (g) => g < 0], ['opened 0..+2%', (g) => g >= 0 && g < 0.02], ['opened +2..+5%', (g) => g >= 0.02 && g < 0.05], ['opened +5..+10%', (g) => g >= 0.05 && g < 0.1], ['opened +10..+20%', (g) => g >= 0.1 && g <= 0.2]];
const strong = rows.filter((r) => r.strong);
test('ALL strong news', strong);
for (const [l, f] of buckets) test(l, strong.filter((r) => f(r.gap)));
test('strength 8-9 only', strong.filter((r) => r.str >= 8));
P('\n NO NEWS FOUND, price only (opened up):');
const none = rows.filter((r) => !r.anyNews);
for (const [l, f] of buckets.slice(2)) test(l, none.filter((r) => f(r.gap)));

// pick the best 1-3 per day
P('\n PICK BEST PER DAY (strong news, opened +2..+20%, buy 9:20 if 1st candle green, sell on 1.5% drop from best). Ranked by news strength, then size of jump:');
for (const n of [1, 2, 3]) {
  const per = DAYS.map((d) => {
    const p = strong.filter((r) => r.d === d && r.gap >= 0.02 && r.gap <= 0.2 && r.b[0].c > r.b[0].o).sort((a, z) => z.str - a.str || z.gap - a.gap).slice(0, n);
    return p.length ? { d, v: mean(p.map((r) => ride(r.b, 0, false, 0.015))), p } : null;
  }).filter(Boolean);
  P(`  best ${n}: ${per.length} days traded, total ${pct(per.reduce((s, x) => s + x.v, 0))}, avg/day ${pct(mean(per.map((x) => x.v)), 2)}, green days ${per.filter((x) => x.v > 0).length}/${per.length}`);
  if (n === 1) for (const x of per) P(`     ${x.d} ${x.p.map((r) => `${r.s} (str ${r.str}, opened ${pct(r.gap)}) ${pct(ride(r.b, 0, false, 0.015))}`).join('  ')}`);
}
fs.writeFileSync(path.join(R, 'month-gainers-report.txt'), out.join('\n'));
