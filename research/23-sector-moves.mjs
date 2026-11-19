// Step 23: the user sees 50-70 stocks rise every day, often whole groups together (autos, PSU banks on Nov 19 2026).
// Steps 7 and 20 found no single-stock price/volume pattern that beats costs. Untested: the GROUP move.
// At a decision time T (10:00 / 10:30 / 11:00), rank industries by the average move since the open of their liquid stocks.
// When one industry is clearly strongest (and the market is not falling), buy stocks from it at T and hold:
//   stop -2% from the buy, else sell at 3:20 pm. Costs 0.4% per trade. Days split in time: first half / second half.
// Variants: the industry's leaders (already up most), its laggards (up least, still green), its biggest stocks.
//   node --max-old-space-size=6000 research/23-sector-moves.mjs
import fs from 'node:fs';

const DIR = new URL('../data/research/', import.meta.url);
const intra = JSON.parse(fs.readFileSync(new URL('intraday.json', DIR), 'utf8'));
const funda = JSON.parse(fs.readFileSync(new URL('fundamentals.json', DIR), 'utf8'));
const COST = Number(process.env.COST ?? 0.004), STOP = 0.02, EXIT = 1515;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (v, d = 2) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : '   -  ');

const days = [...new Set(Object.values(intra).flatMap((d) => Object.keys(d)))].sort()
  .filter((d) => Object.values(intra).filter((s) => (s[d]?.length ?? 0) >= 70).length > 500);
const half = (d) => (d < days[Math.floor(days.length / 2)] ? 'H1' : 'H2');
const grp = (s) => funda[s]?.industry;
const groupSize = new Map();
for (const s of Object.keys(intra)) if (grp(s)) groupSize.set(grp(s), (groupSize.get(grp(s)) ?? 0) + 1);
console.log(`${days.length} full days ${days[0]}..${days.at(-1)}; ${Object.keys(intra).length} stocks; ${[...groupSize.values()].filter((n) => n >= 5).length} industries with 5+ stocks`);

// value traded in rupees over the first part of the day, used for "biggest stocks"
function at(bars, T) { let last = null; for (const b of bars) { if (b[0] > T) break; last = b; } return last; }
function exitFrom(bars, T, buy) {
  for (const b of bars) {
    if (b[0] <= T) continue;
    if (b[3] <= buy * (1 - STOP)) return -STOP;
    if (b[0] >= EXIT) return b[4] / buy - 1;
  }
  return bars.at(-1)[4] / buy - 1;
}

const out = [];
const P = (...a) => { const l = a.join(' '); console.log(l); out.push(l); };
for (const T of [1000, 1030, 1100]) {
  const res = {}; // variant -> [{d, ret}]
  const add = (k, d, r) => (res[k] ??= []).push({ d, r: r - COST });
  for (const d of days) {
    const rows = [];
    for (const [s, byDay] of Object.entries(intra)) {
      const bars = byDay[d];
      if (!bars || bars.length < 60 || bars[0][0] !== 915) continue;
      const b = at(bars, T); if (!b) continue;
      const open = bars[0][1], px = b[4];
      const val = bars.filter((x) => x[0] <= T).reduce((s2, x) => s2 + x[4] * x[5], 0);
      rows.push({ s, g: grp(s), bars, open, px, ret: px / open - 1, val });
    }
    if (rows.length < 400) continue;
    const market = median(rows.map((r) => r.ret));
    const groups = new Map();
    for (const r of rows) if (r.g && groupSize.get(r.g) >= 5) (groups.get(r.g) ?? groups.set(r.g, []).get(r.g)).push(r);
    const ranked = [...groups].filter(([, m]) => m.length >= 5).map(([g, m]) => ({ g, m, avg: mean(m.map((r) => r.ret)), breadth: m.filter((r) => r.ret > 0).length / m.length }))
      .sort((a, b) => b.avg - a.avg);
    if (!ranked.length) continue;
    // baseline: buy every stock at T
    for (const r of rows) add('baseline: every stock', d, exitFrom(r.bars, T, r.px));
    const top = ranked[0], second = ranked[1];
    for (const [cond, ok] of [
      ['top group avg >= +1%', top.avg >= 0.01],
      ['top group >= +1%, 70%+ of it green, market >= 0', top.avg >= 0.01 && top.breadth >= 0.7 && market >= 0],
      ['top group >= +2%, 70%+ green, market >= 0', top.avg >= 0.02 && top.breadth >= 0.7 && market >= 0],
      ['top group >= +1% and 1%+ ahead of the 2nd group', top.avg >= 0.01 && top.avg - (second?.avg ?? 0) >= 0.01],
    ]) {
      if (!ok) continue;
      const byRet = [...top.m].sort((a, b) => b.ret - a.ret), byVal = [...top.m].sort((a, b) => b.val - a.val);
      const pick = (k, list) => { const r = mean(list.map((x) => exitFrom(x.bars, T, x.px))); add(`${cond} | ${k}`, d, r + COST - COST); };
      pick('3 leaders', byRet.slice(0, 3));
      pick('3 laggards (green)', byRet.filter((x) => x.ret > 0).slice(-3));
      pick('3 biggest', byVal.slice(0, 3));
      pick('whole group', top.m);
    }
    // the bottom group too (does weakness continue, or bounce?)
    const bot = ranked.at(-1);
    if (bot.avg <= -0.01 && market >= 0) add('weakest group <= -1%, market >= 0 | whole group (bounce?)', d, mean(bot.m.map((x) => exitFrom(x.bars, T, x.px))));
  }
  P(`\n=========== decision at ${String(T).replace(/(\d\d)$/, ':$1')} (stop -${STOP * 100}%, else 3:20 pm, after ${COST * 100}% costs) ===========`);
  for (const [k, list] of Object.entries(res)) {
    const h1 = list.filter((x) => half(x.d) === 'H1'), h2 = list.filter((x) => half(x.d) === 'H2');
    const nd = new Set(list.map((x) => x.d)).size;
    P(`${k.padEnd(78)} ${String(nd).padStart(3)} days | avg ${pct(mean(list.map((x) => x.r)))} won ${pct(list.filter((x) => x.r > 0).length / list.length, 0)} | H1 ${pct(mean(h1.map((x) => x.r)))} (${h1.length}) | H2 ${pct(mean(h2.map((x) => x.r)))} (${h2.length})`);
  }
}
fs.writeFileSync(new URL('sector-report.txt', DIR), out.join('\n'));
