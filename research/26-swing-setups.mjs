// Step 26: swing trades (hold days to weeks), the user's priority after intraday found nothing (steps 20, 23, 25).
// Classic setups only (no big pattern search, which finds luck): each signal is seen at a day's close and bought at the
// NEXT day's open. Exits use daily prices: stop on the low (a gap below the stop fills at the open), else the exit rule.
// Market health filter: share of liquid stocks closing above their 50-day average ("breadth"); "healthy" = 50%+.
// TRAIN = Oct 2024 - Oct 2025, TEST = Nov 2025 - Nov 2026 (never used to choose). Costs 0.4% a round trip (delivery).
//   node --max-old-space-size=8000 research/26-swing-setups.mjs
import fs from 'node:fs';
import { targetQuarter } from '../src/score.mjs';

const DIR = new URL('../data/research/', import.meta.url);
const read = (f) => JSON.parse(fs.readFileSync(new URL(f, DIR), 'utf8'));
const mk = read('market.json'), funda = read('fundamentals.json'), events = read('events-results.json');
const COST = 0.004, START = '2024-10-01', SPLIT = '2025-11-01';
const NOT_STOCK = /ETF|BEES|IETF|ADD$|^LIQUID|^GILT|^MON100|^MAFANG|^HNGSNG|^NIFTY|^SENSEX|^GOLD|^SILVER/;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const pct = (v, d = 2) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : '   -  ');
const D = mk.days;

// ---- per-stock arrays with indicators ----
const S = {};
for (const [s, rows] of Object.entries(mk.stocks)) {
  if (NOT_STOCK.test(s) || rows.length < 260) continue;
  const n = rows.length, c = rows.map((r) => r[5]);
  const sma = (k, w) => { if (k < w - 1) return NaN; let t = 0; for (let j = k - w + 1; j <= k; j++) t += c[j]; return t / w; };
  const ind = rows.map((r, k) => ({
    day: r[0], prev: r[1], o: r[2], h: r[3], l: r[4], c: r[5], cr: r[6], dl: r[7],
    sma10: sma(k, 10), sma20: sma(k, 20), sma50: sma(k, 50), sma200: sma(k, 200),
  }));
  for (let k = 0; k < n; k++) {
    const x = ind[k], past = rows.slice(Math.max(0, k - 20), k);
    x.cr20 = past.length ? past.reduce((a, r) => a + r[6], 0) / past.length : NaN;
    x.dl20 = past.length ? past.reduce((a, r) => a + (r[7] ?? 0), 0) / past.length : NaN;
    x.hi250 = k >= 250 ? Math.max(...rows.slice(k - 250, k).map((r) => r[3])) : NaN;
    x.hi20 = k >= 20 ? Math.max(...rows.slice(k - 20, k).map((r) => r[3])) : NaN;
    x.lo20 = k >= 20 ? Math.min(...rows.slice(k - 20, k).map((r) => r[4])) : NaN;
    x.r5 = k >= 5 ? c[k] / c[k - 5] - 1 : NaN;
    x.r60 = k >= 60 ? c[k] / c[k - 60] - 1 : NaN;
    let dn = 0; for (let j = k; j > 0 && c[j] < c[j - 1]; j--) dn++; x.downDays = dn;
  }
  S[s] = ind;
}
// ---- market breadth per day ----
const above = D.map(() => [0, 0]);
for (const ind of Object.values(S)) for (const x of ind) if (x.cr20 >= 5 && Number.isFinite(x.sma50)) { above[x.day][1]++; if (x.c > x.sma50) above[x.day][0]++; }
const breadth = above.map(([a, n]) => (n > 200 ? a / n : NaN));
// ---- results that beat last quarter and last year, by the day the market first saw them ----
const resultDay = new Map();
for (const e of events) {
  const [d, t = '00:00'] = e.time.split(' ');
  let i = D.findIndex((x) => x > d || (x === d && t < '15:30'));
  if (i < 0) continue;
  if (D[i] === d && t >= '09:15' && t < '15:30') { /* filed in market hours: that day */ }
  const q = funda[e.symbol]?.q; if (!q) continue;
  const T = targetQuarter(D[i]), pat = (o) => q[o]?.pat;
  if (!(pat(T) != null && pat(T - 1) > 0 && pat(T - 4) > 0)) continue;
  if (pat(T) > pat(T - 1) && pat(T) > pat(T - 4)) resultDay.set(`${e.symbol}|${i}`, true);
}

// ---- setups (signal at day k's close) ----
const liquid = (x) => x.cr20 >= 5;
const SETUPS = {
  'Pullback in uptrend (above 200 & 50 avg, up 10%+ in 3m, down 5%+ in 5 days)': (x) => liquid(x) && x.c > x.sma200 && x.c > x.sma50 && x.r60 >= 0.1 && x.r5 <= -0.05,
  'Pullback: 3+ red days in a strong uptrend (up 20%+ in 3m, above 50 avg)': (x) => liquid(x) && x.c > x.sma50 && x.r60 >= 0.2 && x.downDays >= 3,
  '52-week high breakout, 2x volume, strong close': (x) => liquid(x) && x.c >= x.hi250 && x.cr >= 2 * x.cr20 && x.c > x.o && (x.c - x.l) >= 0.75 * (x.h - x.l),
  'Tight base breakout (20-day range < 12%), 2x volume, above 50 avg': (x) => liquid(x) && x.hi20 / x.lo20 - 1 < 0.12 && x.c > x.hi20 && x.cr >= 2 * x.cr20 && x.c > x.sma50,
  'Delivery jump (1.5x normal) + up 3%+ + 2x volume, strong close': (x) => liquid(x) && x.dl >= 1.5 * x.dl20 && x.c / x.prev - 1 >= 0.03 && x.cr >= 2 * x.cr20 && (x.c - x.l) >= 0.7 * (x.h - x.l),
  'Big stock oversold (Rs 50cr+/day, down 12%+ in 5 days)': (x) => x.cr20 >= 50 && x.r5 <= -0.12,
};
const RESULT_SETUP = 'Results beat both + up 4%+ that day + strong close (post-results drift)';
const EXITS = {
  '5 days, stop -6%': { days: 5, stop: 0.06 },
  '10 days, stop -8%': { days: 10, stop: 0.08 },
  '20 days, stop -8%': { days: 20, stop: 0.08 },
  'close above 10-day avg (max 10 days), stop -8%': { days: 10, stop: 0.08, rule: (x) => x.c > x.sma10 },
  'trend: close below 20-day avg (max 40 days), stop -8%': { days: 40, stop: 0.08, rule: (x) => x.c < x.sma20 },
};
function trade(ind, k, ex) {
  const e = ind[k + 1];
  if (!e || e.day !== ind[k].day + 1) return null; // next market day must exist
  const buy = e.o, stop = buy * (1 - ex.stop);
  for (let j = k + 1; j < ind.length && j <= k + ex.days; j++) {
    const x = ind[j];
    if (x.l <= stop) return { ret: Math.min(x.o, stop) / buy - 1 - COST, held: j - k, exitDay: x.day };
    if (j > k + 1 && ex.rule?.(x)) return { ret: x.c / buy - 1 - COST, held: j - k, exitDay: x.day };
    if (j === k + ex.days) return { ret: x.c / buy - 1 - COST, held: j - k, exitDay: x.day };
  }
  return null; // not finished yet
}

// FOCUS=1: the 52-week-high breakout in a healthy market. (1) Does it survive small changes? (2) A real portfolio:
// N slots of equal money, a signal is bought only if a slot is free (most traded stock first), marked to market daily.
if (process.env.FOCUS) {
  const PERF = [['24H2', (d) => d < '2025'], ['25H1', (d) => d >= '2025' && d < '2025-07'], ['25H2', (d) => d >= '2025-07' && d < '2026'], ['26H1', (d) => d >= '2026' && d < '2026-07'], ['26H2', (d) => d >= '2026-07']];
  const sig = (x, v) => liquid(x) && x.c >= x.hi250 * (v.near ?? 1) && x.cr >= v.vol * x.cr20 && x.c > x.o && (!v.strong || (x.c - x.l) >= 0.75 * (x.h - x.l)) && breadth[x.day] >= v.br;
  const collect = (v, ex) => { const tr = []; for (const [s, ind] of Object.entries(S)) for (let k = 1; k < ind.length - 1; k++) { const x = ind[k]; if (D[x.day] < START || !sig(x, v)) continue; const t = trade(ind, k, ex); if (t) tr.push({ s, k, d: D[x.day], entryDay: x.day + 1, cr: x.cr20, ...t }); } return tr; };
  const m = (l) => mean(l.map((t) => t.ret));
  const TREND = EXITS['trend: close below 20-day avg (max 40 days), stop -8%'];
  console.log('ROBUSTNESS (trend exit): volume x, market health, strong close, how close to the 52-week high');
  for (const vol of [1.5, 2, 3]) for (const br of [0.4, 0.5, 0.6]) for (const strong of [true, false]) for (const near of [1, 0.98]) {
    const tr = collect({ vol, br, strong, near }, TREND);
    const a = tr.filter((t) => t.d < SPLIT), b = tr.filter((t) => t.d >= SPLIT);
    console.log(`  vol ${vol}x health ${br * 100}% ${strong ? 'strong close' : 'any close   '} ${near === 1 ? 'at high ' : 'within 2%'} | TRAIN ${String(a.length).padStart(4)} ${pct(m(a))} | TEST ${String(b.length).padStart(4)} ${pct(m(b))} won ${pct(b.filter((t) => t.ret > 0).length / b.length, 0)} | ${PERF.map(([l, f]) => `${l} ${pct(m(tr.filter((t) => f(t.d))), 1)}`).join(' ')}`);
  }
  // portfolio
  const base = { vol: 2, br: Number(process.env.BR ?? 0.5), strong: process.env.ANYCLOSE ? false : true, near: 1 };
  for (const [exName, ex] of [['trend exit', TREND], ['20 days', EXITS['20 days, stop -8%']], ['10 days', EXITS['10 days, stop -8%']]]) for (const slots of [3, 4, 5]) {
    const tr = collect(base, ex).sort((a, b) => a.entryDay - b.entryDay || b.cr - a.cr);
    const byEntry = new Map(); for (const t of tr) (byEntry.get(t.entryDay) ?? byEntry.set(t.entryDay, []).get(t.entryDay)).push(t);
    let cash = 1, open = []; const curve = []; const taken = [];
    const first = D.findIndex((d) => d >= START);
    for (let day = first; day < D.length; day++) {
      // exits first (at that day's price), then entries at the open
      for (const p of open.filter((p) => p.t.exitDay === day)) cash += p.money * (1 + p.t.ret);
      open = open.filter((p) => p.t.exitDay !== day);
      const value = () => cash + open.reduce((s2, p) => { const x = S[p.t.s].find((y) => y.day === day) ?? null; return s2 + p.money * (x ? x.c / p.buy : 1); }, 0);
      for (const t of byEntry.get(day) ?? []) {
        if (open.length >= slots || open.some((p) => p.t.s === t.s)) continue;
        const money = value() / slots; if (money > cash) continue;
        cash -= money; const buy = S[t.s][t.k + 1].o; open.push({ t, money, buy }); taken.push(t);
      }
      curve.push({ d: D[day], v: value() });
    }
    let peak = 0, dd = 0; for (const c of curve) { peak = Math.max(peak, c.v); dd = Math.min(dd, c.v / peak - 1); }
    const at = (d) => curve.find((c) => c.d >= d)?.v ?? curve.at(-1).v;
    const testRet = curve.at(-1).v / at(SPLIT) - 1, trainRet = at(SPLIT) - 1;
    const yrs = (Date.parse(curve.at(-1).d) - Date.parse(curve[0].d)) / 365.25 / 864e5;
    console.log(`PORTFOLIO ${exName.padEnd(10)} ${slots} slots | ${taken.length} trades, won ${pct(taken.filter((t) => t.ret > 0).length / taken.length, 0)} | TRAIN period ${pct(trainRet, 1)} | TEST period (12 m) ${pct(testRet, 1)} | whole ${pct(curve.at(-1).v - 1, 1)} (${pct(Math.pow(curve.at(-1).v, 1 / yrs) - 1, 1)}/yr) | worst drop ${pct(dd, 1)} | ${PERF.map(([l, f]) => { const c = curve.filter((x) => f(x.d)); return c.length ? `${l} ${pct(c.at(-1).v / c[0].v - 1, 1)}` : ''; }).join(' ')}`);
  }
  process.exit(0);
}

const out = [];
const P = (...a) => { const l = a.join(' '); console.log(l); out.push(l); };
const PER =[['24H2', (d) => d < '2025'], ['25H1', (d) => d >= '2025' && d < '2025-07'], ['25H2', (d) => d >= '2025-07' && d < '2026'], ['26H1', (d) => d >= '2026' && d < '2026-07'], ['26H2', (d) => d >= '2026-07']];
P(`Swing setups, ${START}..${D.at(-1)}, entry next day's open, ${COST * 100}% costs. TRAIN < ${SPLIT} <= TEST.`);
P(`Market health (share of liquid stocks above their 50-day avg): TRAIN avg ${pct(mean(breadth.filter((b, i) => D[i] >= START && D[i] < SPLIT && Number.isFinite(b))), 0)}, TEST avg ${pct(mean(breadth.filter((b, i) => D[i] >= SPLIT && Number.isFinite(b))), 0)}`);
const summary = [];
for (const name of [...Object.keys(SETUPS), RESULT_SETUP]) {
  P(`\n=== ${name} ===`);
  for (const [exName, ex] of Object.entries(EXITS)) {
    for (const healthy of [false, true]) {
      const tr = [];
      for (const [s, ind] of Object.entries(S)) {
        for (let k = 1; k < ind.length - 1; k++) {
          const x = ind[k], d = D[x.day];
          if (d < START) continue;
          const sig = name === RESULT_SETUP
            ? resultDay.has(`${s}|${x.day}`) && liquid(x) && x.c / x.prev - 1 >= 0.04 && (x.c - x.l) >= 0.6 * (x.h - x.l)
            : SETUPS[name](x);
          if (!sig) continue;
          if (healthy && !(breadth[x.day] >= 0.5)) continue;
          const t = trade(ind, k, ex);
          if (t) tr.push({ s, d, ...t });
        }
      }
      const train = tr.filter((t) => t.d < SPLIT), test = tr.filter((t) => t.d >= SPLIT);
      const m = (l) => mean(l.map((t) => t.ret));
      const row = `${exName.padEnd(52)} ${healthy ? 'healthy mkt' : 'any market '} | n ${String(tr.length).padStart(5)} hold ${mean(tr.map((t) => t.held)).toFixed(1).padStart(4)}d | TRAIN ${String(train.length).padStart(5)} ${pct(m(train))} won ${pct(train.filter((t) => t.ret > 0).length / train.length, 0)} | TEST ${String(test.length).padStart(5)} ${pct(m(test))} won ${pct(test.filter((t) => t.ret > 0).length / test.length, 0)} | ${PER.map(([l, f]) => `${l} ${pct(m(tr.filter((t) => f(t.d))), 1)}`).join(' ')}`;
      P(row);
      summary.push({ name, exName, healthy, train: m(train), test: m(test), nTest: test.length, nTrain: train.length, halves: PER.map(([, f]) => m(tr.filter((t) => f(t.d)))), tr });
    }
  }
}
// shortlist: chosen on TRAIN (avg >= +1% per trade, 100+ trades); TEST shown to judge
P('\n=== SHORTLIST chosen on TRAIN (avg +1%+ a trade, 100+ trades), with TEST ===');
for (const x of summary.filter((x) => x.train >= 0.01 && x.nTrain >= 100).sort((a, b) => b.train - a.train))
  P(`${x.name.slice(0, 60).padEnd(60)} | ${x.exName.slice(0, 40).padEnd(40)} ${x.healthy ? 'healthy' : 'any    '} | TRAIN ${pct(x.train)} (${x.nTrain}) | TEST ${pct(x.test)} (${x.nTest}) | half-years positive ${x.halves.filter((h) => h > 0).length}/${x.halves.filter(Number.isFinite).length}`);
fs.writeFileSync(new URL('swing-setups-report.txt', DIR), out.join('\n'));
