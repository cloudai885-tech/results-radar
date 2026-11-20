// LONG-HISTORY CHECK of the one strategy that came close in edge-lab.mjs: Connors RSI(2) pullback on stock indices.
// Same rules, costs and financing as edge-lab.mjs. Data: 1-hour candles 2012-2026 (h1-download.mjs); the daily close is
// the close of the last hourly candle that starts before the cash close (US 16:00 NY, Japan 15:00 Tokyo exact; Germany
// uses the 17:00-18:00 candle, 30 min after the 17:30 close).
// 2012-01 .. 2023-10 was NEVER looked at when the strategy was chosen -> that is the real out-of-sample test.
//   node rsi2-check.mjs
import fs from 'node:fs';

const IDX = {
  us500: { file: 'usa500idxusd', tz: 'America/New_York', last: 15, cost: 0.6 },
  nas100: { file: 'usatechidxusd', tz: 'America/New_York', last: 15, cost: 2.0 },
  us30: { file: 'usa30idxusd', tz: 'America/New_York', last: 15, cost: 3.0 },
  ger40: { file: 'deuidxeur', tz: 'Europe/Berlin', last: 17, cost: 2.0 },
  jpn225: { file: 'jpnidxjpy', tz: 'Asia/Tokyo', last: 14, cost: 12 },
};
const SWAP = 0.07, UNSEEN_END = '2023-11-01', CLEAN = '2018-03-01'; // before 2018 the hourly data has big gaps (2013 missing)
const out = []; const P = (...a) => { const l = a.join(' '); console.log(l); out.push(l); };
const fmts = {};
const loc = (t, tz) => { const f = (fmts[tz] ??= new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short' })); const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, wd: p.weekday }; };
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const pc = (v, d = 2) => (Number.isFinite(v) ? (v * 100).toFixed(d) + '%' : '-');
const rngOf = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
function stats(tr) {
  const r = tr.map((x) => x.pct), n = r.length; if (!n) return { n: 0 };
  const avg = mean(r), sd = Math.sqrt(r.reduce((s, x) => s + (x - avg) ** 2, 0) / Math.max(1, n - 1));
  const gw = r.filter((x) => x > 0).reduce((s, x) => s + x, 0), gl = -r.filter((x) => x < 0).reduce((s, x) => s + x, 0);
  let cum = 0, peak = 0, dd = 0; for (const x of r) { cum += x; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); }
  return { n, win: r.filter((x) => x > 0).length / n, avg, t: sd > 0 ? avg / (sd / Math.sqrt(n)) : 0, pf: gl > 0 ? gw / gl : Infinity, total: cum, dd, worst: Math.min(...r), days: mean(tr.map((x) => x.hold)) };
}
const line = (lab, s, extra = '') => P(`  ${lab.padEnd(30)} ${s.n ? `${String(s.n).padStart(4)} tr | won ${pc(s.win, 0).padStart(4)} | avg ${pc(s.avg).padStart(7)} | t ${s.t.toFixed(2).padStart(5)} | PF ${s.pf.toFixed(2).padStart(5)} | total ${pc(s.total, 0).padStart(5)} | maxDD ${pc(s.dd, 1).padStart(6)} | worst ${pc(s.worst, 1).padStart(6)} | held ${s.days.toFixed(1)} d` : 'no trades'}${extra}`);

// ---------- daily closes ----------
const D = {};
for (const [k, I] of Object.entries(IDX)) {
  const p = new URL(`./data/${I.file}-h1.json`, import.meta.url);
  if (!fs.existsSync(p)) { P(`${k}: no h1 data`); continue; }
  const raw = JSON.parse(fs.readFileSync(p, 'utf8')), days = [];
  for (const r of raw) { const l = loc(r[0], I.tz); if (l.hour === I.last && l.wd !== 'Sat' && l.wd !== 'Sun') days.push({ date: l.date, c: r[4], t: r[0] }); }
  D[k] = days;
  P(`${k}: ${days.length} daily closes ${days[0]?.date} .. ${days.at(-1)?.date}`);
}

// ---------- the rule (parameters can vary for the robustness table; base = Connors: 200 / RSI<10 / exit close > SMA5) ----------
function run(k, o = {}) {
  const { trendN = 200, rsiBelow = 10, exitN = 5, exitRsi = null, maxHold = null, stopPct = null } = o;
  const d = D[k], c = IDX[k].cost, n = d.length, rsi = new Float64Array(n);
  { let g = 0, l = 0; for (let i = 1; i < n; i++) { const ch = d[i].c - d[i - 1].c; g = i === 1 ? Math.max(ch, 0) : (g + Math.max(ch, 0)) / 2; l = i === 1 ? Math.max(-ch, 0) : (l + Math.max(-ch, 0)) / 2; rsi[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
  const pre = new Float64Array(n + 1); for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + d[i].c;
  const sma = (i, m) => (pre[i + 1] - pre[i + 1 - m]) / m;
  const tr = [], holds = [];
  for (let i = Math.max(trendN, 10); i < n; i++) {
    if (!((trendN === 0 || d[i].c > sma(i, trendN)) && rsi[i] < rsiBelow)) continue;
    let j = i + 1;
    for (; j < n; j++) {
      if (stopPct && d[j].c <= d[i].c * (1 - stopPct)) break;
      if (maxHold && j - i >= maxHold) break;
      if (exitRsi ? rsi[j] > exitRsi : d[j].c > sma(j, exitN)) break;
    }
    if (j >= n) break;
    const nights = Math.max(1, Math.round((d[j].t - d[i].t) / 86400000));
    tr.push({ date: d[i].date, exitDate: d[j].date, k, pct: (d[j].c - d[i].c - c) / d[i].c - (SWAP / 365) * nights, hold: j - i });
    holds.push(j - i); i = j;
  }
  return { tr, holds };
}
function placebo(k, holds, runs = 50) {
  const d = D[k], c = IDX[k].cost, rng = rngOf(3), pl = [];
  for (let r = 0; r < runs; r++) for (const h of holds) { const a = 200 + Math.floor(rng() * (d.length - 200 - h - 1)); const nights = Math.max(1, Math.round((d[a + h].t - d[a].t) / 86400000)); pl.push({ date: d[a].date, pct: (d[a + h].c - d[a].c - c) / d[a].c - (SWAP / 365) * nights, hold: h }); }
  return pl;
}
const keys = Object.keys(D);
const unseen = (x) => x.date >= CLEAN && x.date < UNSEEN_END, seen = (x) => x.date >= UNSEEN_END, gappy = (x) => x.date < CLEAN;

P('\n=== 1. BASE RULES, each index (UNSEEN 2018-03..2023-10, clean data | seen in edge-lab 2023-11..2026-11 | 2014-2017 has data gaps) ===');
const pool = [], poolPl = [];
for (const k of keys) {
  const { tr, holds } = run(k); const pl = placebo(k, holds);
  pool.push(...tr); poolPl.push(...pl);
  P(` ${k.toUpperCase()}`);
  line('UNSEEN 2018-2023', stats(tr.filter(unseen)), ` | random entries same holds: ${pc(stats(pl.filter(unseen)).avg)}`);
  line('seen 2023-2026', stats(tr.filter(seen)), ` | random: ${pc(stats(pl.filter(seen)).avg)}`);
  line('(2014-2017, gaps in data)', stats(tr.filter(gappy)), ` | random: ${pc(stats(pl.filter(gappy)).avg)}`);
}
P('\n=== 2. ALL 5 INDICES TOGETHER (note: dips often happen on the same days, so trades are not independent) ===');
line('UNSEEN 2018-2023', stats(pool.filter(unseen)), ` | random: ${pc(stats(poolPl.filter(unseen)).avg)}`);
line('seen 2023-2026', stats(pool.filter(seen)), ` | random: ${pc(stats(poolPl.filter(seen)).avg)}`);
line('(2014-2017, gaps in data)', stats(pool.filter(gappy)), ` | random: ${pc(stats(poolPl.filter(gappy)).avg)}`);
P(' by year (all 5 indices):');
const years = [...new Set(pool.filter((x) => x.date >= CLEAN).map((x) => x.date.slice(0, 4)))].sort();
for (const y of years) line(y, stats(pool.filter((x) => x.date.startsWith(y))), ` | random: ${pc(stats(poolPl.filter((x) => x.date.startsWith(y))).avg)}`);
const yearsUp = years.filter((y) => stats(pool.filter((x) => x.date.startsWith(y))).avg > 0).length;
P(`  profitable years: ${yearsUp} of ${years.length}`);

P('\n=== 3. WORST 10 TRADES 2018-2026 (no stop-loss in the original rule) ===');
for (const x of [...pool.filter((x) => x.date >= CLEAN)].sort((a, b) => a.pct - b.pct).slice(0, 10)) P(`  ${x.k.padEnd(7)} ${x.date} -> ${x.exitDate} (${x.hold} d) ${pc(x.pct)}`);

P('\n=== 4. NEARBY SETTINGS (does it depend on one exact number?), all 5 indices, UNSEEN 2018-2023 | seen 2023-2026 ===');
const V = [
  ['BASE 200 / RSI<10 / exit >SMA5', {}],
  ['RSI < 5', { rsiBelow: 5 }], ['RSI < 15', { rsiBelow: 15 }], ['RSI < 20', { rsiBelow: 20 }], ['RSI < 25', { rsiBelow: 25 }],
  ['exit when RSI(2) > 70', { exitRsi: 70 }], ['exit >SMA3', { exitN: 3 }], ['exit >SMA10', { exitN: 10 }],
  ['trend filter 100 days', { trendN: 100 }], ['NO trend filter', { trendN: 0 }],
  ['+ max hold 10 days', { maxHold: 10 }], ['+ stop 5% (on close)', { stopPct: 0.05 }], ['+ stop 3% (on close)', { stopPct: 0.03 }],
];
for (const [lab, o] of V) {
  const all = keys.flatMap((k) => run(k, o).tr);
  const a = stats(all.filter(unseen)), b = stats(all.filter(seen));
  P(`  ${lab.padEnd(32)} UNSEEN ${String(a.n).padStart(4)} tr avg ${pc(a.avg).padStart(6)} won ${pc(a.win, 0)} t ${a.t.toFixed(2).padStart(5)} worst ${pc(a.worst, 1).padStart(6)} | seen ${String(b.n).padStart(3)} tr avg ${pc(b.avg).padStart(6)} won ${pc(b.win, 0)} t ${b.t.toFixed(2)}`);
}
fs.writeFileSync(new URL('./results/rsi2-check-report.txt', import.meta.url), out.join('\n'));
fs.writeFileSync(new URL('./results/rsi2-trades.csv', import.meta.url), 'index,entry_date,exit_date,days,net_pct\n' + pool.map((x) => `${x.k},${x.date},${x.exitDate},${x.hold},${(x.pct * 100).toFixed(3)}`).join('\n'));
