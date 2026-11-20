// Step 37: the user's idea - take every trade our strategies would have made (Jan 2024 - Nov 2026), split winners and
// losers, and look for what each group has in common, so the rules can be refined.
// Trades: Bounce-back (fell 3%+ yesterday, opens -2..-5%, Rs 1 cr+, companies, no results day) and Gap & Go (results
// overnight, profit up QoQ and YoY, opens +5..+20%, Rs 5 cr+). Top 3 most traded a day per strategy.
// Exits: Bounce-back +7% / -3%, Gap & Go its ATR levels (1.25x / 2x), else sold 3:20 pm. Hourly bars where we have them
// (rescaled to NSE's close, stop first if both in one bar), daily bars otherwise (stop first). Costs 0.4%.
// Every "fact" is known before 9:15. A pattern only counts if it holds in 2024, 2025 AND 2026 separately - with ~20 facts
// some buckets look good by luck, the three-year check is the guard.
//   node --max-old-space-size=12000 research/37-win-loss-patterns.mjs
import fs from 'node:fs';
import { etfList } from '../src/sources.mjs';
import { targetQuarter } from '../src/score.mjs';

const DIR = new URL('../data/research/', import.meta.url);
const read = (f) => JSON.parse(fs.readFileSync(new URL(f, DIR), 'utf8'));
const mk = read('market.json'), hourly = read('hourly.json'), events = read('events-results.json'), funda = read('fundamentals.json');
const ETFS = await etfList();
const NOT_STOCK = /ETF|BEES|IETF|ADD$|^LIQUID|^GILT|^MON100|^MAFANG|^HNGSNG|^NIFTY|^SENSEX|^GOLD|^SILVER|CASE$|^MOM|^MID150/;
const COST = 0.004;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (v, d = 2) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : '   -   ');

// per day: symbol -> row index in that stock's rows
const byDay = mk.days.map(() => new Map());
for (const [s, rows] of Object.entries(mk.stocks)) rows.forEach((r, k) => byDay[r[0]].set(s, k));
// market facts per day: median opening gap, median yesterday move, how many stocks fell 3%+ yesterday
const mGap = [], mYday = [], fallers = [];
for (let i = 1; i < mk.days.length; i++) {
  const g = [], y = []; let f = 0;
  for (const [s, k] of byDay[i]) {
    const R = mk.stocks[s], r = R[k]; if (!(r[1] > 0) || (r[6] ?? 0) < 2) continue;
    g.push(r[2] / r[1] - 1);
    const p = R[k - 1]; if (p && p[0] === i - 1 && p[1] > 0) { y.push(p[5] / p[1] - 1); if (p[5] / p[1] - 1 <= -0.03) f++; }
  }
  mGap[i] = g.length > 200 ? median(g) : null; mYday[i] = y.length > 200 ? median(y) : null; fallers[i] = f;
}
// results filed between the previous close and 9:00
const resultsOn = mk.days.map(() => new Set());
for (const e of events) {
  const [d, t = '00:00'] = e.time.split(' ');
  const i = mk.days.findIndex((x) => x > d || (x === d && t < '09:00'));
  if (i < 1 || (mk.days[i] === d && t >= '09:00')) continue;
  const pd = mk.days[i - 1]; if (d < pd || (d === pd && t < '15:30')) continue;
  resultsOn[i].add(e.symbol);
}

function facts(s, R, k, i) {
  const r = R[k], y = R[k - 1], cr = median(R.slice(k - 20, k).map((x) => x[6]));
  const past14 = R.slice(k - 14, k);
  const atr = mean(past14.map((x, j) => { const pc = j ? past14[j - 1][5] : x[1]; return Math.max(x[3], pc) - Math.min(x[4], pc); })) / y[5];
  const ret = (n) => (k - 1 - n >= 0 ? y[5] / R[k - 1 - n][5] - 1 : null);
  let big5 = 0; for (let j = k - 6; j < k - 1; j++) if (j >= 1 && R[j][5] / R[j][1] - 1 <= -0.045) big5++;
  let up5 = 0; for (let j = k - 6; j < k - 1; j++) if (j >= 1 && R[j][5] / R[j][1] - 1 >= 0.045) up5++;
  const hi250 = Math.max(...R.slice(Math.max(0, k - 250), k).map((x) => x[3]));
  const ma50 = mean(R.slice(Math.max(0, k - 50), k).map((x) => x[5]));
  const vol20 = mean(R.slice(k - 21, k - 1).map((x) => x[6]));
  const rng = y[3] - y[4];
  return {
    gap: r[2] / r[1] - 1, yRet: y[5] / y[1] - 1, cr, atr, big5, up5,
    ret5: ret(5), ret20: ret(20), ret60: ret(60),
    fromHigh: y[5] / hi250 - 1, vsMa50: y[5] / ma50 - 1,
    price: r[1], volSpike: vol20 > 0 ? y[6] / vol20 : null,
    closeLoc: rng > 0 ? (y[5] - y[4]) / rng : 0.5, // 0 = closed at the day's low, 1 = at the high
    yLowerCkt: rng > 0 && y[5] === y[4] && y[5] / y[1] - 1 <= -0.045,
    deliv: y[7] ?? null,
    mGap: mGap[i], mYday: mYday[i], fallers: fallers[i],
    dow: new Date(mk.days[i] + 'T00:00:00Z').getUTCDay(),
  };
}
function outcome(s, R, k, d, stopP, tgtP) {
  const r = R[k], px = r[2], stop = px * (1 - stopP), tgt = tgtP ? px * (1 + tgtP) : null;
  const b = hourly[s]?.[d];
  const last = b?.filter((x) => x[0] < 1530).at(-1);
  if (last) {
    const sc = r[5] / last[4];
    const B = b.filter((x) => x[0] < 1520).map(([t, o, h, l, c]) => [t, o * sc, h * sc, l * sc, c * sc]);
    for (const [j, x] of B.entries()) {
      if (x[3] <= stop) return { r: (j ? Math.min(stop, x[1]) : stop) / px - 1 - COST, how: 'stop' };
      if (tgt && x[2] >= tgt) return { r: tgtP - COST, how: 'target' };
    }
    return { r: B.at(-1)[4] / px - 1 - COST, how: 'close' };
  }
  if (r[4] <= stop) return { r: -stopP - COST, how: 'stop' };
  if (tgt && r[3] >= tgt) return { r: tgtP - COST, how: 'target' };
  return { r: r[5] / px - 1 - COST, how: 'close' };
}

const trades = [];
for (let i = 1; i < mk.days.length; i++) {
  const d = mk.days[i]; if (mGap[i] == null) continue;
  const bb = [], gg = [];
  for (const [s, k] of byDay[i]) {
    if (k < 61 || ETFS.has(s) || NOT_STOCK.test(s)) continue;
    const R = mk.stocks[s], r = R[k], y = R[k - 1];
    if (!(r[1] > 0) || y[0] !== i - 1) continue;
    const gap = r[2] / r[1] - 1, yRet = y[5] / y[1] - 1;
    const cr = median(R.slice(k - 20, k).map((x) => x[6]));
    if (!resultsOn[i].has(s) && yRet <= -0.03 && gap <= -0.02 && gap > -0.0495 && cr >= 1) bb.push({ s, R, k, cr });
    if (resultsOn[i].has(s) && gap >= 0.05 && gap < 0.2 && cr >= 5) {
      const q = funda[s]?.q; if (!q) continue;
      const T = targetQuarter(d), pat = (o) => q[o]?.pat;
      if (!(pat(T) != null && pat(T - 1) > 0 && pat(T - 4) != null)) continue;
      const qoq = pat(T) / pat(T - 1) - 1, yoy = pat(T - 4) > 0 ? pat(T) / pat(T - 4) - 1 : (pat(T) > pat(T - 4) ? 1 : -1);
      if (qoq > 0 && yoy > 0) gg.push({ s, R, k, cr, qoq, yoy });
    }
  }
  for (const c of bb.sort((a, b) => b.cr - a.cr).slice(0, 3)) {
    const f = facts(c.s, c.R, c.k, i);
    trades.push({ kind: 'Bounce-back', d, s: c.s, ...f, ...outcome(c.s, c.R, c.k, d, 0.03, 0.07) });
  }
  for (const c of gg.sort((a, b) => b.cr - a.cr).slice(0, 3)) {
    const f = facts(c.s, c.R, c.k, i);
    const st = Math.min(0.08, Math.max(0.02, 1.25 * f.atr)), tg = Math.min(0.15, Math.max(0.04, 2 * f.atr));
    trades.push({ kind: 'Gap & Go', d, s: c.s, ...f, qoq: c.qoq, yoy: c.yoy, ...outcome(c.s, c.R, c.k, d, st, tg) });
  }
}

const P = (...a) => console.log(a.join(' '));
const yr = (t) => t.d.slice(0, 4);
// a fact, the buckets to split it into
const F = {
  'opening drop/gap': ['gap', [-1, -0.04, -0.03, -0.025, 0, 0.07, 0.1, 0.15, 1]],
  'yesterday move': ['yRet', [-1, -0.08, -0.05, -0.04, -0.03, 0, 0.03, 1]],
  'earlier big falls (5 days before yday)': ['big5', [-1, 0.5, 1.5, 9]],
  'earlier big rises (5 days before yday)': ['up5', [-1, 0.5, 1.5, 9]],
  'last 5 days move': ['ret5', [-1, -0.15, -0.08, -0.03, 0.03, 1]],
  'last month move': ['ret20', [-1, -0.2, -0.1, 0, 0.1, 9]],
  'last 3 months move': ['ret60', [-1, -0.3, -0.15, 0, 0.2, 9]],
  'below 1-year high': ['fromHigh', [-1, -0.5, -0.3, -0.15, -0.05, 1]],
  'vs 50-day average': ['vsMa50', [-1, -0.2, -0.1, 0, 0.1, 9]],
  'price Rs': ['price', [0, 50, 200, 1000, 1e9]],
  'traded Rs cr/day': ['cr', [0, 5, 20, 100, 1e9]],
  'daily range (ATR)': ['atr', [0, 0.025, 0.035, 0.05, 9]],
  'yesterday volume vs normal': ['volSpike', [0, 1, 2, 4, 1e9]],
  'yesterday closed (0=at low,1=at high)': ['closeLoc', [-1, 0.1, 0.3, 0.6, 2]],
  'yesterday locked lower circuit': ['yLowerCkt', null],
  'yesterday delivery %': ['deliv', [-1, 25, 40, 55, 101]],
  'market opening (median gap)': ['mGap', [-1, -0.008, -0.003, 0.003, 0.008, 1]],
  'market yesterday (median move)': ['mYday', [-1, -0.01, -0.003, 0.003, 0.01, 1]],
  'stocks that fell 3%+ yesterday': ['fallers', [-1, 50, 150, 400, 1e9]],
  'weekday': ['dow', null],
  'profit growth QoQ': ['qoq', [-1, 0.2, 0.5, 1, 1e9]],
};
const fmt = (v) => (Math.abs(v) >= 1000 ? `${v / 1000}k` : Math.abs(v) < 1 && v !== 0 ? `${+(v * 100).toFixed(1)}%` : `${v}`);
for (const kind of ['Bounce-back', 'Gap & Go']) {
  const T = trades.filter((t) => t.kind === kind);
  const base = { all: mean(T.map((t) => t.r)), y: Object.fromEntries(['2024', '2025', '2026'].map((y) => [y, mean(T.filter((t) => yr(t) === y).map((t) => t.r))])) };
  const W = T.filter((t) => t.r > 0), L = T.filter((t) => t.r <= 0);
  P(`\n================ ${kind}: ${T.length} trades | avg ${pct(base.all)} | won ${pct(W.length / T.length, 0)} | 2024 ${pct(base.y['2024'])} (${T.filter((t) => yr(t) === '2024').length}) | 2025 ${pct(base.y['2025'])} (${T.filter((t) => yr(t) === '2025').length}) | 2026 ${pct(base.y['2026'])} (${T.filter((t) => yr(t) === '2026').length})`);
  P(`  winners: ${W.length}, avg ${pct(mean(W.map((t) => t.r)))} | losers: ${L.length}, avg ${pct(mean(L.map((t) => t.r)))} | exits: target ${T.filter((t) => t.how === 'target').length}, stop ${T.filter((t) => t.how === 'stop').length}, 3:20 pm ${T.filter((t) => t.how === 'close').length}`);
  P('\n  WINNERS vs LOSERS (median of each fact):');
  for (const [name, [key]] of Object.entries(F)) {
    const w = W.map((t) => t[key]).filter((v) => v != null && typeof v === 'number'), l = L.map((t) => t[key]).filter((v) => v != null && typeof v === 'number');
    if (!w.length || !l.length) continue;
    P(`    ${name.padEnd(40)} winners ${fmt(+median(w).toFixed(4)).padStart(8)} | losers ${fmt(+median(l).toFixed(4)).padStart(8)}`);
  }
  P('\n  BY BUCKET (avg per trade, and per year; ++ = better than average in all 3 years, -- = worse in all 3):');
  const flagged = [];
  for (const [name, [key, cuts]] of Object.entries(F)) {
    const groups = cuts
      ? cuts.slice(0, -1).map((lo, j) => [`${fmt(lo)}..${fmt(cuts[j + 1])}`, (t) => t[key] != null && t[key] > lo && t[key] <= cuts[j + 1]])
      : [...new Set(T.map((t) => t[key]))].sort().map((v) => [String(v), (t) => t[key] === v]);
    const lines = [];
    for (const [lab, f] of groups) {
      const g = T.filter(f); if (g.length < 15) continue;
      const ys = ['2024', '2025', '2026'].map((y) => { const a = g.filter((t) => yr(t) === y); return a.length >= 5 ? mean(a.map((t) => t.r)) : null; });
      const better = ys.every((v, j) => v != null && v > base.y[['2024', '2025', '2026'][j]]), worse = ys.every((v, j) => v != null && v < base.y[['2024', '2025', '2026'][j]]);
      const avg = mean(g.map((t) => t.r));
      const tag = better ? '++' : worse ? '--' : '  ';
      lines.push(`      ${tag} ${lab.padEnd(16)} ${String(g.length).padStart(4)} tr | avg ${pct(avg)} | won ${pct(g.filter((t) => t.r > 0).length / g.length, 0).padStart(4)} | ${ys.map((v, j) => `${2024 + j} ${pct(v)}`).join(' | ')}`);
      if (better || worse) flagged.push({ tag, name, lab, n: g.length, avg, ys });
    }
    if (lines.length) { P(`    ${name}:`); lines.forEach((l) => P(l)); }
  }
  P(`\n  SUMMARY - patterns that held in all 3 years (${kind}):`);
  for (const x of flagged.sort((a, b) => b.avg - a.avg)) P(`    ${x.tag} ${x.name}: ${x.lab} -> ${x.n} trades, avg ${pct(x.avg)} (${x.ys.map((v) => pct(v)).join(' / ')})`);
}
fs.writeFileSync(new URL('win-loss-trades.json', DIR), JSON.stringify(trades.map(({ R, ...t }) => t)));
