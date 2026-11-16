// Step 5: anatomy of the daily movers. For EVERY liquid stock on EVERY day, what was visible before 9:15,
// and did it become a mover (open -> close +5% or more, the part you can still catch if you buy at the open)?
// Part 1: which signs make a mover more likely (lift vs the normal rate)?
// Part 2: a simple learned score (logistic regression on TRAIN), top-3 per day judged on VALID and TEST.
//   node research/5-movers.mjs
import fs from 'node:fs';

const DIR = new URL('../data/research/', import.meta.url);
const { days, stocks } = JSON.parse(fs.readFileSync(new URL('market.json', DIR), 'utf8'));
const funda = fs.existsSync(new URL('fundamentals.json', DIR)) ? JSON.parse(fs.readFileSync(new URL('fundamentals.json', DIR), 'utf8')) : {};
const evFile = ['events.json', 'events-results.json'].map((f) => new URL(f, DIR)).find((u) => fs.existsSync(u));
const events = evFile ? JSON.parse(fs.readFileSync(evFile, 'utf8')) : [];
const PERIODS = { train: ['2025-01-01', '2025-06-30'], valid: ['2025-07-01', '2026-03-31'], test: ['2026-04-01', '2099-12-31'] };
const periodOf = (iso) => Object.keys(PERIODS).find((k) => iso >= PERIODS[k][0] && iso <= PERIODS[k][1]);
const NOT_STOCK = /ETF|BEES|IETF|ADD$|^LIQUID|^GILT|^MON100|^MAFANG|^HNGSNG|^NIFTY|^SENSEX|^GOLD(CASE|SHARE|1|IETF)|^SILVER(1|IETF)/;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (v, d = 2) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%`;

// results known by the morning (date-only list: known the next session)
const dayIndex = new Map(days.map((d, i) => [d, i]));
const resultMorning = new Set();
for (const e of events) if (e.cat === 'result') { const d = e.time.slice(0, 10); const i = days.findIndex((x) => x > d); if (i >= 0) resultMorning.add(`${e.symbol}|${i}`); }

// per-day market and sector moves (yesterday's sector strength is known before the open)
const series = {};
for (const [sym, rows] of Object.entries(stocks)) {
  if (NOT_STOCK.test(sym)) continue;
  const arr = new Array(days.length);
  for (const r of rows) arr[r[0]] = { prev: r[1], open: r[2], high: r[3], low: r[4], close: r[5], cr: r[6], deliv: r[7] };
  series[sym] = arr;
}
const sectorOf = (s) => funda[s]?.sector ?? 'Unknown';
const secDay = new Map(); // `${sector}|${i}` -> [returns]
const mktDay = days.map(() => ({ gaps: [], rets: [] }));
for (const [sym, arr] of Object.entries(series)) arr.forEach((t, i) => {
  if (!t || t.cr < 2) return;
  const ret = Math.max(-0.2, Math.min(0.2, t.close / t.prev - 1));
  mktDay[i].gaps.push(t.open / t.prev - 1); mktDay[i].rets.push(ret);
  const k = `${sectorOf(sym)}|${i}`; (secDay.get(k) ?? secDay.set(k, []).get(k)).push(ret);
});
const mktGap = mktDay.map((d) => median(d.gaps)), mktRet = mktDay.map((d) => median(d.rets));

// ---- features (all known by 9:08 am) ----
const F = []; // names, filled on first row
const rows = [];
for (const [sym, arr] of Object.entries(series)) {
  const sector = sectorOf(sym);
  for (let i = 260; i < days.length; i++) {
    const t = arr[i], y = arr[i - 1];
    if (!t || !y) continue;
    const hist = [];
    for (let j = i - 1; j >= 0 && hist.length < 250; j--) if (arr[j]) hist.push(arr[j]);
    if (hist.length < 200) continue;
    const liq = median(hist.slice(0, 20).map((x) => x.cr));
    if (liq < 2) continue;
    if (Math.abs(t.prev / y.close - 1) > 0.02) continue; // split/bonus day
    const c = (k) => hist[k].close;
    const yRet = y.close / y.prev - 1;
    const yRange = y.high - y.low;
    const hi20 = Math.max(...hist.slice(1, 21).map((x) => x.high)), hi250 = Math.max(...hist.map((x) => x.high));
    const range10 = Math.max(...hist.slice(0, 10).map((x) => x.high)) / Math.min(...hist.slice(0, 10).map((x) => x.low)) - 1;
    const range60 = Math.max(...hist.slice(0, 60).map((x) => x.high)) / Math.min(...hist.slice(0, 60).map((x) => x.low)) - 1;
    const vol20 = mean(hist.slice(1, 21).map((x) => x.cr));
    const deliv20 = mean(hist.slice(1, 21).map((x) => x.deliv ?? 0));
    let upDays = 0; for (let k = 0; k < 10 && c(k) > hist[k].prev; k++) upDays++;
    const sec = secDay.get(`${sector}|${i - 1}`) ?? [];
    const gap = t.open / t.prev - 1;
    const f = {
      gap, gapUp2: gap >= 0.02 ? 1 : 0, gapDn2: gap <= -0.02 ? 1 : 0, gapFlat: Math.abs(gap) < 0.01 ? 1 : 0,
      yRet, yUp4: yRet >= 0.04 ? 1 : 0, yDn4: yRet <= -0.04 ? 1 : 0,
      yCloseAtHigh: yRange > 0 ? (y.close - y.low) / yRange : 0.5, // 1 = closed at the day's high (strong buyers)
      yUpperCircuit: yRet >= 0.045 && y.close >= y.high * 0.999 ? 1 : 0,
      yVolSpike: vol20 ? y.cr / vol20 : 1, yDelivUp: (y.deliv ?? 0) - deliv20,
      breakout20: y.close > hi20 ? 1 : 0, near52wHigh: c(0) / hi250 >= 0.95 ? 1 : 0, far52wHigh: c(0) / hi250 <= 0.6 ? 1 : 0,
      tightBase: range60 > 0 ? range10 / range60 : 1, // small = price squeezed in a tight range lately
      mom5: c(0) / c(5) - 1, mom20: c(0) / c(20) - 1, upDays,
      lowPrice: t.prev < 100 ? 1 : 0, smallLiq: liq < 5 ? 1 : 0, bigLiq: liq >= 50 ? 1 : 0,
      secYday: median(sec), secBreadth: sec.length ? mean(sec.map((x) => (x > 0.02 ? 1 : 0))) : 0,
      mktGap: mktGap[i], mktYday: mktRet[i - 1], result: resultMorning.has(`${sym}|${i}`) ? 1 : 0,
    };
    if (!F.length) F.push(...Object.keys(f));
    const cost = 0.0012 + (liq >= 20 ? 0.0005 : liq >= 5 ? 0.0015 : 0.003);
    const stop = t.open * 0.97, tgt = t.open * 1.07;
    rows.push({
      sym, di: i, day: days[i], period: periodOf(days[i]), sector, x: F.map((k) => f[k]), f,
      mover: t.close / t.open - 1 >= 0.05 ? 1 : 0, fullMover: t.close / t.prev - 1 >= 0.05 ? 1 : 0,
      trade: (t.low <= stop ? -0.03 : t.high >= tgt ? 0.07 : t.close / t.open - 1) - cost,
    });
  }
}
console.log(`${rows.length} stock-days. Movers (close 5%+ above prev close): ${pct(mean(rows.map((r) => r.fullMover)))} of stock-days; catchable movers (close 5%+ above OPEN): ${pct(mean(rows.map((r) => r.mover)))}.`);
const perDay = new Map(); for (const r of rows) perDay.set(r.di, (perDay.get(r.di) ?? 0) + r.fullMover);
console.log(`Average movers per day: ${mean([...perDay.values()]).toFixed(1)}, of which catchable after the open: ${mean([...rows.reduce((m, r) => m.set(r.di, (m.get(r.di) ?? 0) + r.mover), new Map()).values()]).toFixed(1)}`);
const fm = rows.filter((r) => r.fullMover);
console.log(`Of all movers: ${pct(mean(fm.map((r) => (r.f.gap >= 0.02 ? 1 : 0))), 0)} had already gapped up 2%+ at the open, ${pct(mean(fm.map((r) => (Math.abs(r.f.gap) < 0.01 ? 1 : 0))), 0)} opened flat and moved during the day.`);

// ---- part 1: lift of each sign (train + valid) ----
const base = rows.filter((r) => r.period !== 'test');
const baseRate = mean(base.map((r) => r.mover));
const signs = {
  'opens 2%+ up': (f) => f.gapUp2, 'opens 2%+ down': (f) => f.gapDn2, 'opens flat (<1%)': (f) => f.gapFlat,
  'rose 4%+ yesterday': (f) => f.yUp4, 'fell 4%+ yesterday': (f) => f.yDn4, 'closed at day high yesterday (top 10%)': (f) => f.yCloseAtHigh >= 0.9,
  'closed at day low yesterday': (f) => f.yCloseAtHigh <= 0.1, 'upper circuit yesterday': (f) => f.yUpperCircuit,
  'volume 3x+ yesterday': (f) => f.yVolSpike >= 3, 'volume 5x+ yesterday': (f) => f.yVolSpike >= 5, 'delivery jumped 15pts+ yesterday': (f) => f.yDelivUp >= 15,
  '20-day breakout yesterday': (f) => f.breakout20, 'near 52w high': (f) => f.near52wHigh, '40%+ below 52w high': (f) => f.far52wHigh,
  'tight base (10d range < 25% of 60d)': (f) => f.tightBase < 0.25, 'up 15%+ in 5 days': (f) => f.mom5 >= 0.15, 'down 15%+ in 5 days': (f) => f.mom5 <= -0.15,
  'up 3+ days in a row': (f) => f.upDays >= 3, 'price under Rs 100': (f) => f.lowPrice, 'small (Rs 2-5 cr/day)': (f) => f.smallLiq, 'big (Rs 50 cr+/day)': (f) => f.bigLiq,
  'sector rose 2%+ yesterday': (f) => f.secYday >= 0.02, 'sector broad rally yesterday (30%+ up 2%)': (f) => f.secBreadth >= 0.3,
  'market opening up': (f) => f.mktGap > 0.002, 'market opening down': (f) => f.mktGap < -0.002, 'result overnight (Nifty 500)': (f) => f.result,
};
const lines = [];
const log = (s = '') => { console.log(s); lines.push(s); };
log(`\nNormal chance a stock closes 5%+ above its open: ${pct(baseRate)}. Lift = how many times more likely.`);
log('Sign'.padEnd(46) + 'n'.padStart(8) + '  chance   lift   avg trade (buy open, +7%/-3%)  train | valid | test');
const tr = (l, p) => mean(l.filter((r) => r.period === p).map((r) => r.trade));
for (const [name, fn] of Object.entries(signs).map(([n, fn]) => [n, fn]).sort((a, b) => mean(base.filter((r) => b[1](r.f)).map((r) => r.mover)) - mean(base.filter((r) => a[1](r.f)).map((r) => r.mover)))) {
  const l = base.filter((r) => fn(r.f)), all = rows.filter((r) => fn(r.f));
  log(`${name.padEnd(46)}${String(l.length).padStart(8)}  ${pct(mean(l.map((r) => r.mover)), 1).padStart(6)}  ${(mean(l.map((r) => r.mover)) / baseRate).toFixed(1).padStart(4)}x   ${pct(tr(all, 'train')).padStart(7)} | ${pct(tr(all, 'valid')).padStart(7)} | ${pct(tr(all, 'test')).padStart(7)}`);
}

// ---- part 2: learned score ----
const train = rows.filter((r) => r.period === 'train');
const mu = F.map((_, j) => mean(train.map((r) => r.x[j]))), sg = F.map((_, j) => Math.sqrt(mean(train.map((r) => (r.x[j] - mu[j]) ** 2))) || 1);
const z = (x) => x.map((v, j) => Math.max(-5, Math.min(5, (v - mu[j]) / sg[j])));
for (const r of rows) r.z = z(r.x);
// two models: chance of a catchable mover, and expected trade profit
function fitLogistic(data, label) {
  let w = new Array(F.length).fill(0), b = 0;
  const lr = 0.05, l2 = 1e-3;
  for (let ep = 0; ep < 60; ep++) {
    const g = new Array(F.length).fill(0); let gb = 0;
    for (const r of data) { const p = 1 / (1 + Math.exp(-(b + r.z.reduce((s, v, j) => s + v * w[j], 0)))); const e = p - r[label]; gb += e; r.z.forEach((v, j) => (g[j] += e * v)); }
    w = w.map((wj, j) => wj - lr * (g[j] / data.length + l2 * wj)); b -= lr * gb / data.length;
  }
  return (r) => b + r.z.reduce((s, v, j) => s + v * w[j], 0);
}
function fitLinear(data, label) {
  let w = new Array(F.length).fill(0), b = 0;
  for (let ep = 0; ep < 60; ep++) {
    const g = new Array(F.length).fill(0); let gb = 0;
    for (const r of data) { const e = b + r.z.reduce((s, v, j) => s + v * w[j], 0) - r[label]; gb += e; r.z.forEach((v, j) => (g[j] += e * v)); }
    w = w.map((wj, j) => wj - 0.05 * (g[j] / data.length + 1e-3 * wj)); b -= 0.05 * gb / data.length;
  }
  return { score: (r) => b + r.z.reduce((s, v, j) => s + v * w[j], 0), w };
}
const moverScore = fitLogistic(train, 'mover');
const profit = fitLinear(train, 'trade');
log('\nWhat the profit model learned (strongest signs, + = helps, - = hurts):');
log(F.map((n, j) => [n, profit.w[j]]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 12).map(([n, w]) => `${n} ${w >= 0 ? '+' : ''}${(w * 1e4).toFixed(1)}`).join(', '));
for (const [label, score] of [['mover chance', moverScore], ['expected profit', profit.score]]) {
  for (const p of ['valid', 'test']) {
    const byDay = new Map();
    for (const r of rows.filter((x) => x.period === p)) (byDay.get(r.di) ?? byDay.set(r.di, []).get(r.di)).push(r);
    const daily = [];
    let hits = 0, n = 0;
    for (const [, l] of [...byDay].sort((a, b) => a[0] - b[0])) {
      const picks = [], sec = new Set();
      for (const r of l.sort((a, b) => score(b) - score(a))) { if (r.sector !== 'Unknown' && sec.has(r.sector)) continue; sec.add(r.sector); picks.push(r); if (picks.length === 3) break; }
      daily.push(mean(picks.map((r) => r.trade))); hits += picks.filter((r) => r.mover).length; n += picks.length;
    }
    let eq = 1, pk = 1, dd = 0; for (const d of daily) { eq *= 1 + d; pk = Math.max(pk, eq); dd = Math.min(dd, eq / pk - 1); }
    log(`Top 3 a day by ${label}, ${p}: ${pct(hits / n, 1)} became movers (normal ${pct(baseRate, 1)}), avg day ${pct(mean(daily))}, win days ${pct(mean(daily.map((d) => (d > 0 ? 1 : 0))), 0)}, total ${pct(eq - 1, 1)}, worst drop ${pct(dd, 1)}`);
  }
}
fs.writeFileSync(new URL('movers-report.txt', DIR), lines.join('\n'));
