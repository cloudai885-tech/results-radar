// Step 13: the FEW gainers that have a clear reason (a result that beats, an order, an approval...),
// traded the way the user trades: buy when the reason is known, then SELL WHEN SELLERS COME IN STRONG
// (trailing stop from the best price, or a heavy red 5-min bar), not at 3:20 pm.
// Uses the 5-min bars (intraday.json, ~Aug 19 - Nov 16 2026) and news.json (step 11).
//   node research/13-news-trail.mjs   -> data/research/news-trail-report.txt
// Split in time: LEARN = before Oct 10, CHECK = Oct 10 onward. A rule counts only if it is positive in both.
import fs from 'node:fs';
import { typeOf } from './news-types.mjs';

const DIR = new URL('../data/research/', import.meta.url);
const read = (f) => JSON.parse(fs.readFileSync(new URL(f, DIR), 'utf8'));
const intra = read('intraday.json');
const funda = read('fundamentals.json');
const news = read('news.json').items;
const { days, stocks } = read('market.json');
const CUT = '2026-10-10';
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (v, d = 2) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : '-');
const out = [];
const log = (s = '') => { out.push(s); console.log(s); };
const toMin = (hhmm) => Math.floor(hhmm / 100) * 60 + (hhmm % 100);

// ---- daily facts: previous close and liquidity (Rs cr/day, 20-day median before the day) ----
const dayIdx = new Map(days.map((d, i) => [d, i]));
const daily = {};
for (const [sym, rows] of Object.entries(stocks)) { const m = new Map(); for (const r of rows) m.set(r[0], r); daily[sym] = m; }
const liqOf = (sym, i) => { const m = daily[sym]; if (!m) return 0; const a = []; for (let j = i - 1; j >= 0 && a.length < 20; j--) if (m.has(j)) a.push(m.get(j)[6]); return median(a); };

// ---- result quality from Screener quarters (key = year*4 + quarter index; 8106 = Sep 2026) ----
const qKeyFor = (iso) => { const y = +iso.slice(0, 4), mo = +iso.slice(5, 7); const endMonth = mo <= 2 ? 12 : mo <= 5 ? 3 : mo <= 8 ? 6 : mo <= 11 ? 9 : 12; const yy = mo <= 2 ? y - 1 : y; return yy * 4 + (endMonth / 3 - 1); };
function quality(sym, iso) {
  const q = funda[sym]?.q; if (!q) return null;
  const k = qKeyFor(iso), c = q[k], p = q[k - 1], y = q[k - 4];
  if (!c || !p || !y) return null;
  return { beatBoth: c.pat > p.pat && c.pat > y.pat && p.pat > 0 && c.pat > 0, salesUp: c.sales > y.sales,
    big: p.pat > 0 && y.pat > 0 && c.pat >= 1.2 * Math.max(p.pat, y.pat), weak: c.pat < p.pat && c.pat < y.pat };
}

// ---- candidates: the first meaningful news per stock-day ----
const days5 = [...new Set(Object.values(intra).flatMap((o) => Object.keys(o)))].sort();
const tradeDays = days5.filter((d) => dayIdx.has(d));
// the very next market day after a date (from the full daily calendar), kept only if we have 5-min bars for it
const nextTrade = (iso) => { const d = days.find((x) => x > iso); return d && tradeDays.includes(d) ? d : null; };
const cand = new Map(); // `${sym}|${day}` -> { when: 'pre'|'day', type, hm, text }
for (const n of news) {
  const t = typeOf(n.desc, n.text);
  if (['routine', 'meeting', 'management', 'rating', 'board-meet', 'other', 'press', 'legal', 'fundraise'].includes(t)) continue;
  const d = n.time.slice(0, 10), hm = n.time.slice(11, 16);
  let day, when = 'pre';
  if (tradeDays.includes(d) && hm < '09:08') day = d;
  else if (tradeDays.includes(d) && hm <= '15:00') { day = d; when = 'day'; }
  else day = nextTrade(d);
  if (!day) continue;
  const k = `${n.symbol}|${day}`, old = cand.get(k);
  const rank = (x) => (x.type === 'result' ? 0 : 1) * 10 + (x.when === 'pre' ? 0 : 1);
  const now = { sym: n.symbol, day, when, type: t, hm, text: n.text };
  if (!old || rank(now) < rank(old) || (rank(now) === rank(old) && now.hm < old.hm && when === 'day')) cand.set(k, now);
}

// ---- trade simulation on 5-min bars ----
// Stops are checked against the best price BEFORE the bar (the order inside a bar is unknown, so assume the worst).
function simulate(bars, entryIdx, entryPx, exit) {
  let peak = entryPx, volSum = 0, nb = 0;
  for (let j = entryIdx; j < bars.length; j++) {
    const [t, o, h, l, c, v] = bars[j];
    if (t > 1515) break;
    const stopPx = Math.max(entryPx * (1 - exit.stop), exit.trail ? peak * (1 - exit.trail) : 0);
    if (l <= stopPx) return Math.min(o, stopPx) / entryPx - 1; // gap through the stop fills at the open
    if (exit.target && h >= entryPx * (1 + exit.target)) return exit.target;
    if (exit.seller && nb >= 2 && c < o && v >= exit.seller * (volSum / nb) && c < bars[j - 1][3] && c > entryPx * 1.005) return c / entryPx - 1;
    peak = Math.max(peak, h); volSum += v; nb++;
    if (t === 1515) return c / entryPx - 1;
  }
  return bars.filter((b) => b[0] <= 1515).at(-1)[4] / entryPx - 1;
}
const EXITS = [
  { name: 'hold to 3:20, 3% stop', stop: 0.03 },
  { name: 'trail 1%', stop: 0.03, trail: 0.01 }, { name: 'trail 1.5%', stop: 0.03, trail: 0.015 },
  { name: 'trail 2%', stop: 0.03, trail: 0.02 }, { name: 'trail 3%', stop: 0.03, trail: 0.03 },
  { name: 'heavy red bar (2x vol)', stop: 0.03, seller: 2 }, { name: 'red bar 2x OR trail 2%', stop: 0.03, trail: 0.02, seller: 2 },
  { name: 'target 3%, 2% stop', stop: 0.02, target: 0.03 }, { name: 'target 5%, 3% stop', stop: 0.03, target: 0.05 },
];

const trades = [];
for (const c of cand.values()) {
  const bars = intra[c.sym]?.[c.day];
  const i = dayIdx.get(c.day);
  if (!bars || bars.length < 60 || bars[0][0] !== 915 || !daily[c.sym]?.has(i)) continue;
  const liq = liqOf(c.sym, i);
  if (!(liq >= 2)) continue;
  const prev = daily[c.sym].get(i)[1];
  const cost = 0.0012 + 0.001 + (liq >= 20 ? 0.0005 : liq >= 5 ? 0.0015 : 0.003);
  const qual = c.type === 'result' ? quality(c.sym, c.day) : null;
  const base = { ...c, liq, cost, qual, period: c.day < CUT ? 'learn' : 'check', gap: bars[0][1] / prev - 1 };
  const entries = [];
  if (c.when === 'pre') {
    entries.push({ entry: 'open 9:15', idx: 0, px: bars[0][1] });
    // confirmation: at 9:30 the price is above both the open and yesterday's close
    const k = bars.findIndex((b) => b[0] === 925);
    if (k > 0 && bars[k][4] > bars[0][1] && bars[k][4] > prev) entries.push({ entry: '9:30 if holding up', idx: k + 1, px: bars[k][4] });
  } else {
    const f = toMin(+c.hm.replace(':', ''));
    const k = bars.findIndex((b) => toMin(b[0]) >= f + 5); // first bar that starts 5+ min after the filing
    if (k > 0 && bars[k][0] <= 1440) entries.push({ entry: '5-10 min after filing', idx: k + 1, px: bars[k][4] });
  }
  for (const e of entries) {
    if (e.idx >= bars.length) continue;
    const fromPrev = e.px / prev - 1;
    const res = {};
    for (const x of EXITS) res[x.name] = simulate(bars, e.idx, e.px, x) - cost;
    trades.push({ ...base, ...e, fromPrev, res, closeUp5: bars.filter((b) => b[0] <= 1525).at(-1)[4] / prev - 1 >= 0.05 });
  }
}

log(`CLEAR-REASON STOCKS, SOLD WHEN SELLERS COME IN  (5-min bars ${tradeDays[0]}..${tradeDays.at(-1)}; learn < ${CUT} <= check)`);
log(`Stock-days with a strong news type (result/order/approval/deal/corporate/capacity), Rs 2 cr+/day: ${new Set(trades.map((t) => t.sym + t.day)).size}`);
log('Costs per trade 0.3-0.55% (charges + slippage + spread by liquidity). Numbers are per trade after costs.\n');

const GROUPS = [
  ['RESULT before open, beat last qtr AND last yr', (t) => t.when === 'pre' && t.type === 'result' && t.qual?.beatBoth],
  ['  ... and profit 20%+ above both', (t) => t.when === 'pre' && t.type === 'result' && t.qual?.big],
  ['  ... beat both, opens 0..+3%', (t) => t.when === 'pre' && t.type === 'result' && t.qual?.beatBoth && t.gap >= 0 && t.gap < 0.03],
  ['  ... beat both, opens +3..+10%', (t) => t.when === 'pre' && t.type === 'result' && t.qual?.beatBoth && t.gap >= 0.03 && t.gap < 0.10],
  ['  ... beat both, opens down', (t) => t.when === 'pre' && t.type === 'result' && t.qual?.beatBoth && t.gap < 0],
  ['RESULT before open, weak (below both)', (t) => t.when === 'pre' && t.type === 'result' && t.qual?.weak],
  ['ORDER/approval/deal/capacity before open', (t) => t.when === 'pre' && t.type !== 'result'],
  ['  ... opens 0..+3%', (t) => t.when === 'pre' && t.type !== 'result' && t.gap >= 0 && t.gap < 0.03],
  ['RESULT during the day, beat both', (t) => t.when === 'day' && t.type === 'result' && t.qual?.beatBoth],
  ['  ... profit 20%+ above both', (t) => t.when === 'day' && t.type === 'result' && t.qual?.big],
  ['ORDER/approval/deal during the day', (t) => t.when === 'day' && t.type !== 'result'],
];
const survivors = [];
for (const [g, f] of GROUPS) {
  const rs = trades.filter(f);
  const entries = [...new Set(rs.map((t) => t.entry))];
  for (const en of entries) {
    const r2 = rs.filter((t) => t.entry === en);
    const L = r2.filter((t) => t.period === 'learn'), C = r2.filter((t) => t.period === 'check');
    log(`${g}  |  entry: ${en}  |  learn n=${L.length}, check n=${C.length}, became 5% gainers: ${pct(r2.filter((t) => t.closeUp5).length / r2.length, 0)}`);
    for (const x of EXITS) {
      const a = L.map((t) => t.res[x.name]), b = C.map((t) => t.res[x.name]);
      const ok = a.length >= 10 && b.length >= 10 && mean(a) > 0 && mean(b) > 0;
      if (ok) survivors.push({ g, en, x: x.name, L: mean(a), C: mean(b), nL: a.length, nC: b.length, wC: b.filter((v) => v > 0).length / b.length });
      log(`    ${x.name.padEnd(26)} learn ${pct(mean(a)).padStart(7)} win ${pct(a.filter((v) => v > 0).length / a.length, 0).padStart(4)}  | check ${pct(mean(b)).padStart(7)} win ${pct(b.filter((v) => v > 0).length / b.length, 0).padStart(4)} ${ok ? ' <== positive in both' : ''}`);
    }
  }
  log();
}
log(`==== Positive in BOTH halves (n >= 10 each): ${survivors.length} of ${GROUPS.length * EXITS.length * 2}-ish tested ====`);
for (const s of survivors.sort((a, b) => Math.min(b.L, b.C) - Math.min(a.L, a.C))) log(`  ${s.g.trim()} | ${s.en} | ${s.x}: learn ${pct(s.L)} (n=${s.nL}), check ${pct(s.C)} (n=${s.nC}, win ${pct(s.wC, 0)})`);
log('\nWarning: with ~100 combinations tested, a few will look positive by luck. Trust only those with a clear reason AND decent n.');

// Examples: recent beat-both results before open, what happened
log('\n==== Last 25 "result beat both, before open" stocks ====');
for (const t of trades.filter((t) => t.when === 'pre' && t.type === 'result' && t.qual?.beatBoth && t.entry === 'open 9:15').slice(-25))
  log(`  ${t.day} ${t.sym.padEnd(12)} gap ${pct(t.gap, 1).padStart(6)} | hold ${pct(t.res['hold to 3:20, 3% stop'], 1).padStart(6)} | trail 2% ${pct(t.res['trail 2%'], 1).padStart(6)} | red bar ${pct(t.res['heavy red bar (2x vol)'], 1).padStart(6)} | closed 5%+ up: ${t.closeUp5 ? 'yes' : 'no'}`);
fs.writeFileSync(new URL('news-trail-report.txt', DIR), out.join('\n'));
