// Pattern study: which kinds of results make a stock rise when you buy the morning AFTER the result?
// Step 1 builds one row per past result (Nifty 500) with every pattern we can measure.
// Step 2 tests each pattern alone and in pairs/triples, on older results (train) and newer ones (test).
// A pattern only counts if it made money in BOTH periods.
//   node study.mjs            collect + analyse
//   node study.mjs analyse    analyse saved rows only
import fs from 'node:fs';
import { nifty500, pastResultDates, dailyBars, fundamentals, mapPool } from './src/sources.mjs';
import { targetQuarter, indexBefore } from './src/score.mjs';

const OUT = new URL('./data/study-events.json', import.meta.url);
const SPLIT = '2025-08-01'; // results before this date = train, after = test
const COST = { intraday: 0.001, swing: 0.0035 };
const STOP = 0.03;

const growth = (now, base) => (now == null || base == null ? null : base > 0 ? (now - base) / base : null); // null when the base is a loss
const up = (g) => (g == null ? null : g > 0);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (v, d = 2) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%`;

async function collect() {
  const universe = await nifty500();
  const nifty = await dailyBars('^NSEI', '5y', 24 * 30);
  const today = process.env.STUDY_TO ?? '12-11-2026'; // matches the saved NSE lists, so no slow re-download
  console.log(`Collecting ${universe.length} stocks (uses the cache, new downloads are slow)...`);
  const all = await mapPool(universe, 4, async ({ symbol, company }) => {
    const [dates, bars, f] = await Promise.all([pastResultDates(symbol, '01-01-2022', today), dailyBars(`${symbol}.NS`, '5y', 24 * 30), fundamentals(symbol, 24 * 30)]);
    if (!bars?.length || !f || !dates.length) return [];
    const q = (o) => f.quarters.get(o) ?? {};
    const h = (o) => f.holdings.get(o) ?? {};
    const rows = [];
    for (const date of dates) {
      const T = targetQuarter(date);
      if (q(T).pat == null || q(T - 1).pat == null || q(T - 4).pat == null || q(T).sales == null) continue;
      const b = indexBefore(bars, date); // last session before the meeting day
      const d = indexBefore(bars, date + 'z'); // meeting day (or last session before it)
      const e = d + 1; // first session after the meeting: we buy at its open
      if (b < 260 || e + 2 >= bars.length || bars[b].date < shift(date, -7)) continue;
      const traded = median(bars.slice(b - 20, b).map((x) => x.close * x.volume));
      if (traded < 5e7) continue;
      const ni = indexBefore(nifty, bars[b].date + 'z');
      const entry = bars[e].open;
      const stopPx = entry * (1 - STOP);
      const intraday = (bars[e].low <= stopPx ? -STOP : bars[e].close / entry - 1) - COST.intraday;
      const swing3 = bars[e + 2].close / entry - 1 - COST.swing;
      const hi250 = Math.max(...bars.slice(b - 250, b + 1).map((x) => x.high));
      const vol5 = mean(bars.slice(b - 4, b + 1).map((x) => x.volume)), vol50 = mean(bars.slice(b - 50, b - 4).map((x) => x.volume));
      const patY = growth(q(T).pat, q(T - 4).pat), patYprev = growth(q(T - 1).pat, q(T - 5).pat);
      rows.push({
        symbol, company, date, sector: f.classification.sector ?? 'Unknown',
        // the result itself
        revQ: growth(q(T).sales, q(T - 1).sales), revY: growth(q(T).sales, q(T - 4).sales),
        patQ: growth(q(T).pat, q(T - 1).pat), patY,
        lossLastQtr: q(T - 1).pat <= 0, lossNow: q(T).pat <= 0,
        lastQtrFell: q(T - 2).pat != null ? q(T - 1).pat < q(T - 2).pat : null, // profit had dropped in the previous quarter
        marginQ: q(T).opm != null && q(T - 1).opm != null ? q(T).opm - q(T - 1).opm : null,
        marginY: q(T).opm != null && q(T - 4).opm != null ? q(T).opm - q(T - 4).opm : null,
        otherIncomeHeavy: q(T).otherIncome != null && q(T).pbt > 0 ? q(T).otherIncome / q(T).pbt > 0.3 : null, // profit leans on other income
        accelerating: patY != null && patYprev != null ? patY > patYprev : null, // growth faster than last quarter's growth
        recordProfit: [1, 2, 3, 4, 5, 6, 7].every((k) => q(T - k).pat == null || q(T).pat > q(T - k).pat),
        // before the result: what people expected
        runUp20: bars[b].close / bars[b - 20].close - 1,
        runUp20vsNifty: bars[b].close / bars[b - 20].close - nifty[ni].close / nifty[ni - 20].close,
        fromHigh: bars[b].close / hi250 - 1,
        volumeBuild: vol50 ? vol5 / vol50 : null, // people waiting for the result
        niftyTrend: nifty[ni].close / nifty[ni - 20].close - 1,
        fiiChange: h(T).fii != null && h(T - 1).fii != null ? h(T).fii - h(T - 1).fii : null,
        diiChange: h(T).dii != null && h(T - 1).dii != null ? h(T).dii - h(T - 1).dii : null,
        // what happened
        dayMove: bars[d].close / bars[b].close - 1, // meeting day (result often lands during it)
        gap: entry / bars[d].close - 1, // next morning opening jump
        reaction2d: bars[e].close / bars[b].close - 1,
        intraday, swing3,
      });
    }
    return rows;
  }, (done, total) => { if (done % 50 === 0) console.log(`  ${done}/${total}`); });
  const rows = all.flat().filter(Boolean);
  // Industry mood: average 2-day reaction of same-sector results in the 10 days before (peers already out).
  const bySector = new Map();
  for (const r of rows) (bySector.get(r.sector) ?? bySector.set(r.sector, []).get(r.sector)).push(r);
  for (const r of rows) {
    const peers = bySector.get(r.sector).filter((p) => p.date < r.date && p.date >= shift(r.date, -10));
    r.peerMood = peers.length >= 3 ? mean(peers.map((p) => p.reaction2d)) : null;
  }
  fs.writeFileSync(OUT, JSON.stringify(rows));
  console.log(`Saved ${rows.length} results.`);
  return rows;
}
const shift = (iso, d) => new Date(Date.parse(iso) + d * 864e5).toISOString().slice(0, 10);

// Every yes/no pattern we test. Each returns true, false or null (unknown).
const PATTERNS = {
  'Revenue up vs last qtr': (r) => up(r.revQ),
  'Revenue down vs last qtr': (r) => (r.revQ == null ? null : r.revQ <= 0),
  'Revenue up vs last year': (r) => up(r.revY),
  'Revenue up 15%+ vs last year': (r) => (r.revY == null ? null : r.revY >= 0.15),
  'Profit up vs last qtr': (r) => (r.lossLastQtr ? null : up(r.patQ)),
  'Profit down vs last qtr': (r) => (r.lossLastQtr ? null : r.patQ <= 0),
  'Profit up vs last year': (r) => up(r.patY),
  'Profit up 25%+ vs last year': (r) => (r.patY == null ? null : r.patY >= 0.25),
  'Profit up both (qtr + year)': (r) => (r.patQ == null || r.patY == null ? null : r.patQ > 0 && r.patY > 0),
  'Revenue AND profit up both ways': (r) => (r.patQ == null || r.patY == null || r.revQ == null || r.revY == null ? null : r.patQ > 0 && r.patY > 0 && r.revQ > 0 && r.revY > 0),
  'Last qtr was a loss': (r) => r.lossLastQtr,
  'Loss this qtr': (r) => r.lossNow,
  'Profit had fallen last qtr (recovery)': (r) => r.lastQtrFell,
  'Margin up vs last qtr': (r) => (r.marginQ == null ? null : r.marginQ > 0),
  'Margin up 2pts+ vs last year': (r) => (r.marginY == null ? null : r.marginY >= 2),
  'Profit leans on other income': (r) => r.otherIncomeHeavy,
  'Growth accelerating': (r) => r.accelerating,
  'Record profit (best in 2 yrs)': (r) => r.recordProfit,
  'Ran up 10%+ before result': (r) => r.runUp20 >= 0.1,
  'Fell before result': (r) => r.runUp20 < 0,
  'Within 5% of 52-week high': (r) => r.fromHigh >= -0.05,
  '20%+ below 52-week high': (r) => r.fromHigh <= -0.2,
  'Volume building (people waiting)': (r) => (r.volumeBuild == null ? null : r.volumeBuild >= 1.5),
  'Market (Nifty) rising': (r) => r.niftyTrend > 0,
  'FIIs buying': (r) => (r.fiiChange == null ? null : r.fiiChange > 0.25),
  'FIIs selling': (r) => (r.fiiChange == null ? null : r.fiiChange < -0.25),
  'DIIs buying': (r) => (r.diiChange == null ? null : r.diiChange > 0.25),
  'Industry mood good (peers rose)': (r) => (r.peerMood == null ? null : r.peerMood > 0.01),
  'Industry mood bad (peers fell)': (r) => (r.peerMood == null ? null : r.peerMood < -0.01),
  'Rose on result day': (r) => r.dayMove > 0.02,
  'Fell on result day': (r) => r.dayMove < -0.02,
  'Opens 0-3% up': (r) => r.gap >= 0 && r.gap < 0.03,
  'Opens 3-5% up': (r) => r.gap >= 0.03 && r.gap < 0.05,
  'Opens 5-20% up': (r) => r.gap >= 0.05 && r.gap < 0.2,
  'Opens down': (r) => r.gap < 0,
};

function stats(list, key) {
  const v = list.map((r) => r[key]);
  return { n: v.length, avg: mean(v), win: mean(v.map((x) => (x > 0 ? 1 : 0))) };
}

function analyse(rows) {
  const train = rows.filter((r) => r.date < SPLIT), test = rows.filter((r) => r.date >= SPLIT);
  console.log(`\n${rows.length} results: train ${train.length} (before ${SPLIT}), test ${test.length} (after).`);
  const lines = [];
  const log = (s = '') => { console.log(s); lines.push(s); };
  for (const key of ['intraday', 'swing3']) {
    const base = [stats(train, key), stats(test, key)];
    log(`\n=== ${key === 'intraday' ? 'Buy next-morning open, sell same day 3:20 pm (3% stop)' : 'Buy next-morning open, hold 3 sessions'} ===`);
    log(`Everything: train ${pct(base[0].avg)} win ${pct(base[0].win, 0)} | test ${pct(base[1].avg)} win ${pct(base[1].win, 0)}`);
    const names = Object.keys(PATTERNS);
    const results = [];
    const tryCombo = (combo) => {
      const pass = (r) => combo.every((n) => PATTERNS[n](r) === true);
      const a = stats(train.filter(pass), key), b = stats(test.filter(pass), key);
      if (a.n < 40 || b.n < 20) return;
      results.push({ combo, a, b, score: Math.min(a.avg, b.avg) });
    };
    names.forEach((x) => tryCombo([x]));
    log('\nSingle patterns (sorted by the weaker of train/test):');
    for (const r of [...results].sort((x, y) => y.score - x.score)) log(row(r));
    const singles = results.length;
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
      tryCombo([names[i], names[j]]);
      for (let k = j + 1; k < names.length; k++) tryCombo([names[i], names[j], names[k]]);
    }
    const combos = results.slice(singles).filter((r) => r.a.avg > 0 && r.b.avg > 0).sort((x, y) => y.score - x.score);
    log(`\nBest combinations (profit in BOTH periods; ${results.length - singles} tried, ${combos.length} positive in both):`);
    for (const r of combos.slice(0, 25)) log(row(r));
    log('\nWorst combinations (avoid):');
    for (const r of results.slice(singles).sort((x, y) => Math.max(x.a.avg, x.b.avg) - Math.max(y.a.avg, y.b.avg)).slice(0, 10)) log(row(r));
  }
  // What people liked: 2-day reaction for every revenue/profit, quarter/year combination.
  log('\n=== What the crowd liked (2-day move around the result, all periods) ===');
  const tag = (g, w) => (g == null ? null : `${w} ${g > 0 ? 'up' : 'down'}`);
  const groups = new Map();
  for (const r of rows) {
    const t = [tag(r.revQ, 'Rev qtr'), tag(r.revY, 'Rev yr'), tag(r.lossLastQtr ? null : r.patQ, 'Profit qtr'), tag(r.patY, 'Profit yr')];
    if (t.includes(null)) continue;
    const k = t.join(', ');
    (groups.get(k) ?? groups.set(k, []).get(k)).push(r);
  }
  for (const [k, list] of [...groups].sort((x, y) => mean(y[1].map((r) => r.reaction2d)) - mean(x[1].map((r) => r.reaction2d))))
    log(`${k.padEnd(60)} n=${String(list.length).padStart(4)}  avg ${pct(mean(list.map((r) => r.reaction2d))).padStart(7)}  rose ${pct(mean(list.map((r) => (r.reaction2d > 0 ? 1 : 0))), 0)}`);
  fs.writeFileSync(new URL('./data/study-report.txt', import.meta.url), lines.join('\n'));
}
const row = (r) => `${r.combo.join(' + ').padEnd(95)} train n=${String(r.a.n).padStart(4)} ${pct(r.a.avg).padStart(7)} win ${pct(r.a.win, 0).padStart(4)} | test n=${String(r.b.n).padStart(4)} ${pct(r.b.avg).padStart(7)} win ${pct(r.b.win, 0).padStart(4)}`;

const rows = process.argv[2] === 'analyse' && fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : await collect();
analyse(rows);
