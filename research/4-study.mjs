// Step 4: the big study. One row per (stock, morning) where something happened overnight, or the stock gapped 3%+ with no news.
// Every row gets: overnight news type + result numbers + what people expected before + market mood + the opening jump,
// and what happened after buying at the open. Then patterns (alone, pairs, triples) are searched on TRAIN,
// confirmed on VALID, and only the survivors make a daily 0-5 pick list, judged on TEST (never looked at before).
//   node research/4-study.mjs
import fs from 'node:fs';
import { targetQuarter } from '../src/score.mjs';

const DIR = new URL('../data/research/', import.meta.url);
const read = (f) => (fs.existsSync(new URL(f, DIR)) ? JSON.parse(fs.readFileSync(new URL(f, DIR), 'utf8')) : null);
const { days, stocks } = read('market.json');
const funda = read('fundamentals.json') ?? {};
// Full announcement history if we have it; otherwise Nifty 500 result dates only (then "no news" is only known for those 500).
const fullEvents = read('events.json');
const events = fullEvents ?? read('events-results.json') ?? [];
const newsKnownFor = fullEvents ? null : new Set(events.map((e) => e.symbol));
const resultTimeKnown = !!fullEvents;
const PERIODS = { train: ['2024-01-01', '2025-06-30'], valid: ['2025-07-01', '2026-03-31'], test: ['2026-04-01', '2099-12-31'] };
const periodOf = (iso) => Object.keys(PERIODS).find((k) => iso >= PERIODS[k][0] && iso <= PERIODS[k][1]);
const MIN_TURNOVER_CR = 2;

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const pct = (v, d = 2) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%`;
const growth = (now, base) => (now == null || base == null || !(base > 0) ? null : (now - base) / base);

// ---- market mood per day: how the whole liquid market opened, and its 20-day trend ----
const dayStats = days.map(() => ({ gaps: [], rets: [] }));
const series = {}; // symbol -> array indexed by day (row or undefined)
for (const [sym, rows] of Object.entries(stocks)) {
  const arr = new Array(days.length);
  for (const r of rows) arr[r[0]] = { prev: r[1], open: r[2], high: r[3], low: r[4], close: r[5], cr: r[6], deliv: r[7] };
  series[sym] = arr;
  for (const r of rows) if (r[6] >= MIN_TURNOVER_CR) { dayStats[r[0]].gaps.push(r[2] / r[1] - 1); dayStats[r[0]].rets.push(Math.max(-0.2, Math.min(0.2, r[5] / r[1] - 1))); }
}
const marketGap = dayStats.map((d) => median(d.gaps) ?? 0);
const breadth = dayStats.map((d) => mean(d.gaps.map((g) => (g > 0 ? 1 : 0))));
const mktIndex = []; dayStats.forEach((d, i) => mktIndex.push((mktIndex[i - 1] ?? 1) * (1 + (median(d.rets) ?? 0))));
const mktTrend20 = days.map((_, i) => (i >= 20 ? mktIndex[i - 1] / mktIndex[i - 21] - 1 : 0)); // up to the evening before

// ---- overnight events: filed after 15:30 on the previous session or before 9:15 on the day ----
const dayIndex = new Map(days.map((d, i) => [d, i]));
const sessionFor = (time) => {
  const [date, hm] = time.split(' ');
  if (dayIndex.has(date) && hm < '09:15') return dayIndex.get(date);
  if (dayIndex.has(date) && hm < '15:30') return null; // filed during market hours: not a morning trade
  let i = days.findIndex((d) => d > date);
  return i < 0 ? null : i;
};
const overnight = new Map(); // `${sym}|${dayIdx}` -> { cats:Set, firstTime, texts:[] }
for (const e of events) {
  const i = sessionFor(e.time);
  if (i == null) continue;
  const k = `${e.symbol}|${i}`;
  const o = overnight.get(k) ?? { cats: new Set(), time: e.time, texts: [], resultTime: null };
  o.cats.add(e.cat);
  if (e.cat === 'result' && !o.resultTime) o.resultTime = e.time;
  o.texts.push(e.text);
  overnight.set(k, o);
}
console.log(`${days.length} days, ${Object.keys(stocks).length} stocks, ${events.length} announcements, ${overnight.size} overnight stock-mornings, ${Object.keys(funda).length} with numbers.`);

// ---- build rows ----
const COST = (cr) => 0.0012 + (cr >= 20 ? 0.0005 : cr >= 5 ? 0.0015 : 0.003); // charges + slippage, round trip
const STOP = 0.03, TARGET = 0.07;
const rows = [];
const NOT_STOCK = /ETF|BEES|IETF|ADD$|^LIQUID|^GILT|^MON100|^MAFANG|^HNGSNG|^NIFTY|^SENSEX|^GOLD(CASE|SHARE|1|IETF)|^SILVER(1|IETF)/; // funds, not companies
for (const [sym, arr] of Object.entries(series)) {
  if (NOT_STOCK.test(sym)) continue;
  for (let i = 260; i < days.length; i++) {
    const t = arr[i];
    if (!t) continue;
    const gap = t.open / t.prev - 1;
    const o = overnight.get(`${sym}|${i}`);
    if (!o && Math.abs(gap) < 0.03) continue;
    const hist = [];
    for (let j = i - 1; j >= 0 && hist.length < 250; j--) if (arr[j]) hist.push(arr[j]);
    if (hist.length < 200) continue;
    const liq = median(hist.slice(0, 20).map((x) => x.cr));
    if (liq < MIN_TURNOVER_CR) continue;
    // a price jump with no matching previous close = split/bonus adjustment: skip
    if (Math.abs(t.prev / hist[0].close - 1) > 0.02) continue;
    const runUp20 = hist[0].close / hist[19].close - 1;
    const high250 = Math.max(...hist.map((x) => x.high));
    const vol5 = mean(hist.slice(0, 5).map((x) => x.cr)), vol50 = mean(hist.slice(5, 55).map((x) => x.cr));
    const deliv5 = mean(hist.slice(0, 5).map((x) => x.deliv ?? 0)), deliv50 = mean(hist.slice(5, 55).map((x) => x.deliv ?? 0));
    // outcomes, buying at the open
    const cost = COST(liq);
    const stopPx = t.open * (1 - STOP), targetPx = t.open * (1 + TARGET);
    const intraday = (t.low <= stopPx ? -STOP : t.close / t.open - 1) - cost;
    const intradayT = (t.low <= stopPx ? -STOP : t.high >= targetPx ? TARGET : t.close / t.open - 1) - cost;
    let hold3 = null;
    const n1 = arr[i + 1], n2 = arr[i + 2];
    if (n1 && n2 && i + 2 < days.length) {
      let exit = n2.close;
      if (t.low <= stopPx) exit = stopPx;
      else if (n1.open <= stopPx) exit = n1.open; else if (n1.low <= stopPx) exit = stopPx;
      else if (n2.open <= stopPx) exit = n2.open; else if (n2.low <= stopPx) exit = stopPx;
      hold3 = exit / t.open - 1 - cost;
    }
    const f = funda[sym];
    const r = {
      sym, day: days[i], di: i, period: periodOf(days[i]), gap, liq, cost,
      cats: o ? [...o.cats] : [], noNews: newsKnownFor && !newsKnownFor.has(sym) ? null : !o, filedHour: o && resultTimeKnown ? Number(o.time.slice(11, 13)) : null,
      prevDay: hist[0].close / hist[1].close - 1, // the session before (results filed during market hours already moved it)
      sector: f?.sector ?? 'Unknown', mcap: f?.mcap ?? null, pe: f?.pe ?? null,
      runUp20, fromHigh: hist[0].close / high250 - 1, volBuild: vol50 ? vol5 / vol50 : null,
      deliv: hist[0].deliv, delivBuild: deliv50 ? deliv5 - deliv50 : null,
      mktGap: marketGap[i], breadth: breadth[i], mktTrend: mktTrend20[i],
      intraday, intradayT, hold3, maxUp: t.high / t.open - 1,
    };
    if (o?.resultTime && f) {
      const T = targetQuarter(o.resultTime.slice(0, 10));
      const q = (k) => f.q[k] ?? {};
      if (q(T).pat != null && q(T - 1).pat != null && q(T - 4).pat != null) {
        Object.assign(r, {
          hasNumbers: true,
          revQ: growth(q(T).sales, q(T - 1).sales), revY: growth(q(T).sales, q(T - 4).sales),
          patQ: growth(q(T).pat, q(T - 1).pat), patY: growth(q(T).pat, q(T - 4).pat),
          patYprev: growth(q(T - 1).pat, q(T - 5).pat),
          lossLastQtr: !(q(T - 1).pat > 0), lossNow: !(q(T).pat > 0),
          lastQtrFell: q(T - 2).pat != null ? q(T - 1).pat < q(T - 2).pat : null,
          marginQ: q(T).opm != null && q(T - 1).opm != null ? q(T).opm - q(T - 1).opm : null,
          marginY: q(T).opm != null && q(T - 4).opm != null ? q(T).opm - q(T - 4).opm : null,
          oiHeavy: q(T).oi != null && q(T).pbt > 0 ? q(T).oi / q(T).pbt > 0.3 : null,
          record: [1, 2, 3, 4, 5, 6, 7].every((k) => q(T - k).pat == null || q(T).pat > q(T - k).pat),
          fiiChg: f.h[T]?.fii != null && f.h[T - 1]?.fii != null ? f.h[T].fii - f.h[T - 1].fii : null,
          diiChg: f.h[T]?.dii != null && f.h[T - 1]?.dii != null ? f.h[T].dii - f.h[T - 1].dii : null,
        });
      }
    }
    rows.push(r);
  }
}
// industry mood: average opening move of same-sector stocks with results in the 5 sessions before
const bySector = new Map(); // sector -> dayIdx -> [moves]
for (const r of rows) if (r.cats.includes('result') && r.sector !== 'Unknown') {
  const m = bySector.get(r.sector) ?? bySector.set(r.sector, new Map()).get(r.sector);
  (m.get(r.di) ?? m.set(r.di, []).get(r.di)).push(r.gap + r.intraday);
}
for (const r of rows) {
  const m = bySector.get(r.sector);
  const peers = [];
  if (m) for (let d = r.di - 5; d < r.di; d++) peers.push(...(m.get(d) ?? []));
  r.peerMood = peers.length >= 3 ? mean(peers) : null;
}
fs.writeFileSync(new URL('rows.json', DIR), JSON.stringify(rows));
console.log(`${rows.length} rows (${rows.filter((r) => !r.noNews).length} with overnight news). Periods:`, Object.fromEntries(Object.keys(PERIODS).map((k) => [k, rows.filter((r) => r.period === k).length])));

// ---- conditions ----
const C = {};
const add = (name, fn) => (C[name] = fn);
for (const [lo, hi] of [[-1, -0.03], [-0.03, 0], [0, 0.02], [0.02, 0.05], [0.05, 0.1], [0.1, 0.2]]) add(`opens ${pct(lo, 0)}..${pct(hi, 0)}`, (r) => r.gap >= lo && r.gap < hi);
for (const c of ['result', 'order', 'approval', 'buyback', 'bonus-split', 'dividend', 'acquisition', 'fundraise', 'rating', 'management', 'legal', 'meeting', 'other']) add(`news: ${c}`, (r) => r.cats.includes(c));
add('no news', (r) => r.noNews);
add('rose 3%+ the day before', (r) => r.prevDay >= 0.03);
add('fell 3%+ the day before', (r) => r.prevDay <= -0.03);
add('filed evening (15:30-20:00)', (r) => r.filedHour != null && r.filedHour >= 15 && r.filedHour < 20);
add('filed late night/morning', (r) => r.filedHour != null && (r.filedHour >= 20 || r.filedHour < 9));
add('profit up qtr+yr', (r) => r.hasNumbers ? r.patQ > 0 && r.patY > 0 && !r.lossLastQtr : null);
add('rev+profit up qtr+yr', (r) => r.hasNumbers ? r.patQ > 0 && r.patY > 0 && r.revQ > 0 && r.revY > 0 && !r.lossLastQtr : null);
add('profit up 25%+ yr', (r) => (r.hasNumbers && r.patY != null ? r.patY >= 0.25 : null));
add('profit down qtr+yr', (r) => (r.hasNumbers && r.patQ != null && r.patY != null ? r.patQ <= 0 && r.patY <= 0 : null));
add('rev up, profit down', (r) => (r.hasNumbers && r.revY != null && r.patY != null ? r.revY > 0 && r.patY <= 0 : null));
add('last qtr loss', (r) => (r.hasNumbers ? r.lossLastQtr : null));
add('record profit', (r) => (r.hasNumbers ? r.record && !r.lossNow : null));
add('margin up qtr', (r) => (r.marginQ != null ? r.marginQ > 0 : null));
add('margin up 2pt yr', (r) => (r.marginY != null ? r.marginY >= 2 : null));
add('growth accelerating', (r) => (r.patY != null && r.patYprev != null ? r.patY > r.patYprev : null));
add('profit leans on other income', (r) => r.oiHeavy ?? null);
add('FII buying', (r) => (r.fiiChg != null ? r.fiiChg > 0.25 : null));
add('FII selling', (r) => (r.fiiChg != null ? r.fiiChg < -0.25 : null));
add('DII buying', (r) => (r.diiChg != null ? r.diiChg > 0.25 : null));
add('ran up 10%+ (20d)', (r) => r.runUp20 >= 0.1);
add('fell 10%+ (20d)', (r) => r.runUp20 <= -0.1);
add('near 52w high', (r) => r.fromHigh >= -0.05);
add('30%+ below 52w high', (r) => r.fromHigh <= -0.3);
add('volume building 1.5x', (r) => (r.volBuild != null ? r.volBuild >= 1.5 : null));
add('quiet before (vol < 0.8x)', (r) => (r.volBuild != null ? r.volBuild < 0.8 : null));
add('delivery rising', (r) => (r.delivBuild != null ? r.delivBuild > 5 : null));
add('delivery 50%+', (r) => (r.deliv != null ? r.deliv >= 50 : null));
add('large (mcap 20k cr+)', (r) => (r.mcap != null ? r.mcap >= 20000 : null));
add('mid (5k-20k cr)', (r) => (r.mcap != null ? r.mcap >= 5000 && r.mcap < 20000 : null));
add('small (< 5k cr)', (r) => (r.mcap != null ? r.mcap < 5000 : null));
add('liquid 20cr+/day', (r) => r.liq >= 20);
add('market opening up', (r) => r.mktGap > 0.002);
add('market opening down', (r) => r.mktGap < -0.002);
add('market trend up (20d)', (r) => r.mktTrend > 0.02);
add('market trend down (20d)', (r) => r.mktTrend < -0.02);
add('industry mood good', (r) => (r.peerMood != null ? r.peerMood > 0.01 : null));
add('industry mood bad', (r) => (r.peerMood != null ? r.peerMood < -0.01 : null));
add('high PE (60+)', (r) => (r.pe != null ? r.pe >= 60 : null));
add('low PE (< 20)', (r) => (r.pe != null ? r.pe > 0 && r.pe < 20 : null));
const names = Object.keys(C);
const masks = Object.fromEntries(names.map((n) => [n, Uint8Array.from(rows, (r) => (C[n](r) === true ? 1 : 0))]));
const idxBy = Object.fromEntries(Object.keys(PERIODS).map((p) => [p, rows.map((r, i) => (r.period === p ? i : -1)).filter((i) => i >= 0)]));

// ---- search ----
const MIN_N = { train: 40, valid: 25 };
// Stats judged by DAY: a crash day where 300 stocks bounce counts once, not 300 times.
function statsFor(list, key) {
  const byDay = new Map();
  for (const i of list) { const r = rows[i]; if (r[key] == null) continue; (byDay.get(r.di) ?? byDay.set(r.di, []).get(r.di)).push(r[key]); }
  const all = [...byDay.values()].flat(), d = [...byDay.values()].map(mean);
  return { n: all.length, days: d.length, avg: mean(d), tradeAvg: mean(all), win: mean(all.map((x) => (x > 0 ? 1 : 0))), t: d.length > 1 ? (mean(d) / (sd(d) || 1)) * Math.sqrt(d.length) : 0 };
}
function evalCombo(combo, key, period) {
  const ms = combo.map((n) => masks[n]);
  return statsFor(idxBy[period].filter((i) => ms.every((m) => m[i])), key);
}
const report = [];
const log = (s = '') => { console.log(s); report.push(s); };
const fmt = (s) => `n=${String(s.n).padStart(4)} on ${String(s.days).padStart(3)} days, per-day avg ${pct(s.avg).padStart(7)} win ${pct(s.win, 0).padStart(4)}`;
const chosen = {};
for (const key of ['intraday', 'intradayT', 'hold3']) {
  log(`\n=== ${key === 'intraday' ? 'Buy at open, sell 3:20 pm (3% stop)' : key === 'intradayT' ? 'Buy at open, +7% target / 3% stop, else 3:20 pm' : 'Buy at open, hold 3 sessions (3% stop)'} ===`);
  for (const p of Object.keys(PERIODS)) log(`Everything ${p}: ${fmt(evalCombo([], key, p))}`);
  const found = [];
  const base = idxBy.train.filter((i) => rows[i][key] != null);
  const statsOf = (list) => statsFor(list, key);
  const consider = (combo, list) => {
    const a = statsOf(list);
    if (a.days < 20 || a.avg <= 0.003 || a.t < 2) return;
    const b = evalCombo(combo, key, 'valid');
    if (b.n < MIN_N.valid || b.days < 12 || b.avg <= 0.002) return;
    found.push({ combo, a, b });
  };
  const pre = names.filter((n) => base.filter((i) => masks[n][i]).length >= MIN_N.train);
  let tried = 0;
  for (let i = 0; i < pre.length; i++) {
    const li = base.filter((x) => masks[pre[i]][x]);
    consider([pre[i]], li); tried++;
    for (let j = i + 1; j < pre.length; j++) {
      const lij = li.filter((x) => masks[pre[j]][x]);
      if (lij.length < MIN_N.train) continue;
      consider([pre[i], pre[j]], lij); tried++;
      for (let k = j + 1; k < pre.length; k++) {
        const lijk = lij.filter((x) => masks[pre[k]][x]);
        if (lijk.length >= MIN_N.train) { consider([pre[i], pre[j], pre[k]], lijk); tried++; }
      }
    }
  }
  log(`${tried} patterns tried.`);
  found.sort((x, y) => Math.min(y.a.avg, y.b.avg) - Math.min(x.a.avg, x.b.avg));
  log(`${found.length} patterns made money in train (t>2) AND valid:`);
  for (const f of found.slice(0, 30)) log(`  ${f.combo.join(' + ').padEnd(90)} train ${fmt(f.a)} | valid ${fmt(f.b)}`);
  chosen[key] = found.slice(0, 15);
}
// ---- daily pick list, judged on TEST only ----
log('\n=== Daily 0-5 pick list on the TEST period (never used for choosing) ===');
for (const key of Object.keys(chosen)) {
  const rules = chosen[key];
  if (!rules.length) { log(`${key}: no rule survived, so no picks (that is a valid answer).`); continue; }
  const byDay = new Map();
  for (const i of idxBy.test) {
    const r = rows[i];
    if (r[key] == null) continue;
    const hits = rules.filter((f) => f.combo.every((n) => masks[n][i]));
    if (!hits.length) continue;
    const conf = Math.max(...hits.map((f) => Math.min(f.a.avg, f.b.avg)));
    (byDay.get(r.day) ?? byDay.set(r.day, []).get(r.day)).push({ r, conf, hits: hits.length });
  }
  const daily = [];
  const testDays = days.filter((d) => periodOf(d) === 'test').length;
  for (const [day, list] of byDay) {
    // Like a fund manager: best first, at most one stock per sector, at most 5.
    const picks = [], sectors = new Set();
    for (const p of list.sort((x, y) => y.conf - x.conf || y.hits - x.hits)) {
      if (p.r.sector !== 'Unknown' && sectors.has(p.r.sector)) continue;
      sectors.add(p.r.sector); picks.push(p);
      if (picks.length === 5) break;
    }
    daily.push({ day, n: picks.length, ret: mean(picks.map((p) => p.r[key])), names: picks.map((p) => p.r.sym) });
  }
  daily.sort((a, b) => (a.day < b.day ? -1 : 1));
  let eq = 1, peak = 1, dd = 0;
  for (const d of daily) { eq *= 1 + d.ret; peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1); }
  const trades = daily.flatMap((d) => Array(d.n).fill(d.ret));
  log(`${key}: picks on ${daily.length}/${testDays} test days, ${trades.length} trades, avg per trade ${pct(mean(trades))}, winning days ${pct(mean(daily.map((d) => (d.ret > 0 ? 1 : 0))), 0)}, total ${pct(eq - 1, 1)}, worst drop ${pct(dd, 1)}`);
  for (const d of daily.slice(-8)) log(`    ${d.day}: ${d.names.join(', ')} -> ${pct(d.ret)}`);
}
fs.writeFileSync(new URL('report.txt', DIR), report.join('\n'));
fs.writeFileSync(new URL('rules.json', DIR), JSON.stringify(chosen, null, 1));
