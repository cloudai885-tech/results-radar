// Mahin's strategy lab - a stand-alone backtester, separate from the Results Radar app (it only READS the price data
// the research already downloaded; nothing here touches the app, its database or the morning jobs).
//
//   node mahins-strategy/backtest.mjs mahins-strategy/strategies/example-bounce-back.mjs
//
// A strategy is one small file (see strategies/TEMPLATE.mjs). For every stock on every day the lab shows the strategy
// what a trader could know BEFORE the market opens (all past days + today's opening price) and asks: trade or not?
// Then it plays the trade forward with the strategy's exit rules, adds charges, and prints a full report.
// Data: NSE daily bars Jan 2024 - Nov 2026 (~3,300 stocks); hourly bars ~2 years (~1,300 stocks) for intraday exits.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { etfList, fetchCached, mapPool } from '../src/sources.mjs';

const file = process.argv[2];
if (!file) { console.log('Usage: node mahins-strategy/backtest.mjs <strategy file>\nExample: node mahins-strategy/backtest.mjs mahins-strategy/strategies/example-bounce-back.mjs'); process.exit(1); }
const S = { side: 'buy', entryType: 'open', maxPerDay: 3, costs: 0.004, from: '2024-03-01', to: '2099-01-01', testFrom: '2025-10-01', rank: (v) => v.turnoverCr, ...(await import(pathToFileURL(path.resolve(file)).href)).default };
S.universe = { minTurnoverCr: 1, minPrice: 5, skipT2T: true, skipETF: true, skipResultsDay: false, ...(S.universe ?? {}) };
S.exit = { stop: null, target: null, trail: null, holdDays: 0, exitWhen: null, ...(S.exit ?? {}) };
S.maxOpen ??= S.exit.holdDays > 0 ? 5 : S.maxPerDay;
if (S.side === 'short' && S.exit.holdDays > 0) { console.log('Note: in the Indian cash market a short must be closed the same day. holdDays set to 0 (intraday).'); S.exit.holdDays = 0; }

const DATA = new URL('../data/research/', import.meta.url);
const read = (f) => JSON.parse(fs.readFileSync(new URL(f, DATA), 'utf8'));
if (!fs.existsSync(new URL('market.json', DATA))) { console.log('Price data not found (data/research/market.json). It is created by the research downloads on the main PC.'); process.exit(1); }
const mk = read('market.json');
const events = fs.existsSync(new URL('events-results.json', DATA)) ? read('events-results.json') : [];
let hourly = null;
const needHourly = S.exit.holdDays === 0 || S.entryType !== 'open';
if (needHourly && fs.existsSync(new URL('hourly.json', DATA))) hourly = read('hourly.json');
const ETFS = S.universe.skipETF ? await etfList().catch(() => new Set()) : new Set();
const NOT_STOCK = /ETF|BEES|IETF|ADD$|^LIQUID|^GILT|^MON100|^MAFANG|^HNGSNG|^NIFTY|^SENSEX|^GOLD|^SILVER|CASE$|^MOM|^MID150/;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (v, d = 2) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : '-');

// ---------- market facts per day ----------
const byDay = mk.days.map(() => new Map());
for (const [s, rows] of Object.entries(mk.stocks)) rows.forEach((r, k) => byDay[r[0]].set(s, k));
const mGap = [], mYday = [];
for (let i = 1; i < mk.days.length; i++) {
  const g = [], y = [];
  for (const [s, k] of byDay[i]) { const R = mk.stocks[s], r = R[k]; if (!(r[1] > 0) || (r[6] ?? 0) < 2) continue; g.push(r[2] / r[1] - 1); const p = R[k - 1]; if (p && p[1] > 0) y.push(p[5] / p[1] - 1); }
  mGap[i] = g.length > 200 ? median(g) : null; mYday[i] = y.length > 200 ? median(y) : null;
}
const resultsOn = mk.days.map(() => new Set());
for (const e of events) {
  const [d, t = '00:00'] = e.time.split(' ');
  const i = mk.days.findIndex((x) => x > d || (x === d && t < '09:00'));
  if (i < 1 || (mk.days[i] === d && t >= '09:00')) continue;
  const pd = mk.days[i - 1]; if (d < pd || (d === pd && t < '15:30')) continue;
  resultsOn[i].add(e.symbol);
}
const I0 = Math.max(1, mk.days.findIndex((d) => d >= S.from)), I1 = (() => { const j = mk.days.findIndex((d) => d > S.to); return j < 0 ? mk.days.length : j; })();
const series = new Map(); // NSE series (EQ/BE...) from the previous day's file: BE = T2T, delivery only
if (S.universe.skipT2T || S.side === 'short') {
  await mapPool([...Array(I1 - I0).keys()].map((x) => x + I0), 6, async (i) => {
    const [Y, M, D] = mk.days[i - 1].split('-');
    const csv = await fetchCached(`https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${D}${M}${Y}.csv`, { ttlHours: 1e7, attempts: 1 }).catch(() => null);
    if (!csv?.startsWith('SYMBOL')) return;
    const m = new Map(); for (const line of csv.split(String.fromCharCode(10)).slice(1)) { const p = line.split(','); if (p[0]) m.set(p[0].trim(), p[1]?.trim()); }
    series.set(i, m);
  });
}

// ---------- what the strategy sees: past bars + today's open (never today's high/low/close) ----------
class View {
  constructor(sym, R, k, i) { this.symbol = sym; this.R = R; this.k = k; this.i = i; }
  get date() { return mk.days[this.i]; }
  get open() { return this.R[this.k][2]; }
  get prevClose() { return this.R[this.k][1]; }
  get gap() { return this.open / this.prevClose - 1; }
  get daysOfData() { return this.k; }
  /** n = 1 is yesterday, 2 the day before ... -> { date, open, high, low, close, change, turnoverCr, delivery } */
  bar(n = 1) { const r = this.R[this.k - n]; if (!r) return null; return { date: mk.days[r[0]], open: r[2], high: r[3], low: r[4], close: r[5], change: r[5] / r[1] - 1, turnoverCr: r[6] ?? 0, delivery: r[7] ?? null }; }
  get yesterday() { return this.bar(1); }
  /** move over the last n days, up to yesterday's close */
  change(n) { const a = this.R[this.k - 1], b = this.R[this.k - 1 - n]; return a && b ? a[5] / b[5] - 1 : null; }
  closes(n) { return this.R.slice(Math.max(0, this.k - n), this.k).map((r) => r[5]); }
  sma(n) { const c = this.closes(n); return c.length === n ? mean(c) : null; }
  ema(n) { const c = this.closes(n * 4); if (c.length < n) return null; const a = 2 / (n + 1); let e = c[0]; for (const x of c.slice(1)) e = a * x + (1 - a) * e; return e; }
  rsi(n = 14) { const c = this.closes(n * 5); if (c.length <= n) return null; let g = 0, l = 0; for (let j = 1; j <= n; j++) { const d = c[j] - c[j - 1]; if (d > 0) g += d; else l -= d; } g /= n; l /= n; for (let j = n + 1; j < c.length; j++) { const d = c[j] - c[j - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; } return l === 0 ? 100 : 100 - 100 / (1 + g / l); }
  /** average daily range of the last n days, as a share of yesterday's close (0.04 = 4%) */
  atr(n = 14) { const p = this.R.slice(this.k - n, this.k); if (p.length < n) return null; return mean(p.map((x, j) => { const pc = j ? p[j - 1][5] : x[1]; return Math.max(x[3], pc) - Math.min(x[4], pc); })) / this.R[this.k - 1][5]; }
  highest(n) { const p = this.R.slice(Math.max(0, this.k - n), this.k); return p.length ? Math.max(...p.map((r) => r[3])) : null; }
  lowest(n) { const p = this.R.slice(Math.max(0, this.k - n), this.k); return p.length ? Math.min(...p.map((r) => r[4])) : null; }
  /** typical money traded a day (Rs crore), median of the last 20 days */
  get turnoverCr() { return this._cr ??= median(this.R.slice(Math.max(0, this.k - 20), this.k).map((r) => r[6] ?? 0)); }
  /** yesterday's turnover vs its own average of the n days before (2 = double the usual) */
  volumeRatio(n = 20) { const a = mean(this.R.slice(Math.max(0, this.k - 1 - n), this.k - 1).map((r) => r[6] ?? 0)); return a > 0 ? (this.R[this.k - 1][6] ?? 0) / a : null; }
  /** how many of the last n days (up to yesterday) closed at least `by` down (by = -0.045 -> fell 4.5%+) */
  daysDown(n, by) { let c = 0; for (let j = this.k - n; j < this.k; j++) { const r = this.R[j]; if (r && r[5] / r[1] - 1 <= by) c++; } return c; }
  daysUp(n, by) { let c = 0; for (let j = this.k - n; j < this.k; j++) { const r = this.R[j]; if (r && r[5] / r[1] - 1 >= by) c++; } return c; }
  get lowerCircuitYesterday() { const y = this.R[this.k - 1]; return y[3] > y[4] && y[5] === y[4] && y[5] / y[1] - 1 <= -0.045; }
  get upperCircuitYesterday() { const y = this.R[this.k - 1]; return y[3] > y[4] && y[5] === y[3] && y[5] / y[1] - 1 >= 0.045; }
  get marketGap() { return mGap[this.i]; }
  get marketYesterday() { return mYday[this.i]; }
  get resultsToday() { return resultsOn[this.i].has(this.symbol); }
  get series() { return series.get(this.i)?.get(this.symbol) ?? null; }
}

// ---------- playing a trade forward ----------
const hourBars = (sym, i, r) => {
  const b = hourly?.[sym]?.[mk.days[i]]; const last = b?.filter((x) => x[0] < 1530).at(-1); if (!last) return null;
  const sc = r[5] / last[4]; return b.filter((x) => x[0] < 1520).map(([t, o, h, l, c]) => ({ t, o: o * sc, h: h * sc, l: l * sc, c: c * sc }));
};
// entry: at the open, or when the price reaches a level during the day (stop = breakout, limit = pullback)
function fillPrice(r, level, sideBuy) {
  const [, , o, h, l] = r;
  if (S.entryType === 'open' || level == null) return { px: o, at: 'open' };
  const rising = (S.entryType === 'stop') === sideBuy; // buy-stop / sell-limit fill when price RISES to the level
  if (rising) { if (o >= level) return { px: o, at: 'open' }; if (h >= level) return { px: level, at: 'level' }; return null; }
  if (o <= level) return { px: o, at: 'open' }; if (l <= level) return { px: level, at: 'level' }; return null;
}
function play(sym, R, k, fill) {
  const buy = S.side === 'buy', { stop, target, trail, holdDays, exitWhen } = S.exit;
  const px = fill.px, dir = buy ? 1 : -1;
  const ret = (p) => dir * (p / px - 1);
  let best = px;
  const stopAt = () => { let sp = stop != null ? px * (1 - dir * stop) : null; if (trail != null) { const t = best * (1 - dir * trail); sp = sp == null ? t : buy ? Math.max(sp, t) : Math.min(sp, t); } return sp; };
  const hitStop = (b, sp) => sp != null && (buy ? b.l <= sp : b.h >= sp);
  const hitTgt = (b) => target != null && (buy ? b.h >= px * (1 + target) : b.l <= px * (1 - target));
  const tgtPx = () => px * (1 + dir * target);
  // day 0 (entry day): hourly bars if we have them
  const r0 = R[k], H = hourBars(sym, r0[0], r0);
  if (H) {
    let j0 = 0; if (fill.at === 'level') { j0 = H.findIndex((b) => (buy === (S.entryType === 'stop') ? b.h >= px : b.l <= px)); if (j0 < 0) j0 = 0; }
    for (let j = j0; j < H.length; j++) {
      const b = H[j], sp = stopAt();
      if (hitStop(b, sp)) return { r: ret(j > j0 ? (buy ? Math.min(sp, b.o) : Math.max(sp, b.o)) : sp), how: trail != null && sp !== (stop != null ? px * (1 - dir * stop) : null) ? 'trailing stop' : 'stop', days: 0 };
      if (!(fill.at === 'level' && j === j0) && hitTgt(b)) return { r: target, how: 'target', days: 0 };
      best = buy ? Math.max(best, b.h) : Math.min(best, b.l);
    }
    if (holdDays === 0) return { r: ret(H.at(-1).c), how: 'sold 3:20 pm', days: 0 };
  } else {
    const b = { o: r0[2], h: r0[3], l: r0[4], c: r0[5] }, sp = stopAt();
    if (hitStop(b, sp)) return { r: ret(sp), how: 'stop', days: 0 };
    if (hitTgt(b)) return { r: target, how: 'target', days: 0 };
    best = buy ? Math.max(best, b.h) : Math.min(best, b.l);
    if (holdDays === 0) return { r: ret(b.c), how: 'sold at close', days: 0 };
  }
  // later days (swing): daily bars, the stop counts first, a gap through the stop sells at the open
  for (let n = 1; n <= holdDays; n++) {
    const r = R[k + n]; if (!r) return { r: ret(R[k + n - 1][5]), how: 'data ended', days: n - 1 };
    const b = { o: r[2], h: r[3], l: r[4], c: r[5] }, sp = stopAt();
    if (hitStop(b, sp)) return { r: ret(buy ? Math.min(sp, b.o) : Math.max(sp, b.o)), how: trail != null ? 'trailing stop' : 'stop', days: n };
    if (hitTgt(b)) return { r: ret(buy ? Math.max(tgtPx(), b.o) : Math.min(tgtPx(), b.o)), how: 'target', days: n };
    best = buy ? Math.max(best, b.h) : Math.min(best, b.l);
    if (n === holdDays) return { r: ret(b.c), how: `held ${holdDays} days`, days: n };
    if (exitWhen && exitWhen(new View(sym, R, k + n + 1, r[0] + 1), { entry: px, days: n }) && R[k + n + 1]) return { r: ret(R[k + n + 1][2]), how: 'exit rule', days: n + 1 };
  }
  return { r: ret(R[k][5]), how: 'end', days: 0 };
}

// ---------- run ----------
const trades = [], open = []; // open: { sym, until (day index) }
for (let i = I0; i < I1; i++) {
  for (let j = open.length - 1; j >= 0; j--) if (open[j].until < i) open.splice(j, 1);
  if (mGap[i] == null) continue;
  const ser = series.get(i), cands = [];
  for (const [sym, k] of byDay[i]) {
    if (k < 30 || ETFS.has(sym) || NOT_STOCK.test(sym)) continue;
    const R = mk.stocks[sym], r = R[k], y = R[k - 1];
    if (y[0] !== i - 1 || !(r[1] > 0) || !(r[2] > 0) || r[1] < S.universe.minPrice) continue;
    if (S.universe.skipT2T && ser?.get(sym) === 'BE') continue;
    if (S.side === 'short' && ser && ser.get(sym) !== 'EQ') continue; // only EQ stocks can be shorted intraday
    const v = new View(sym, R, k, i);
    if (v.turnoverCr < S.universe.minTurnoverCr) continue;
    if (S.universe.skipResultsDay && v.resultsToday) continue;
    let ok = false; try { ok = S.entry(v); } catch { ok = false; }
    if (ok) cands.push(v);
  }
  cands.sort((a, b) => S.rank(b) - S.rank(a));
  let taken = 0;
  for (const v of cands) {
    if (taken >= S.maxPerDay || open.length >= S.maxOpen) break;
    if (open.some((o) => o.sym === v.symbol)) continue;
    const level = S.entryLevel ? S.entryLevel(v) : null;
    const fill = fillPrice(v.R[v.k], level, S.side === 'buy'); if (!fill) continue;
    const res = play(v.symbol, v.R, v.k, fill);
    trades.push({ date: v.date, symbol: v.symbol, side: S.side, entry: +fill.px.toFixed(2), ...res, r: res.r - S.costs, exitDate: mk.days[Math.min(mk.days.length - 1, i + res.days)] });
    open.push({ sym: v.symbol, until: i + res.days }); taken++;
  }
}

// ---------- report ----------
const out = [];
const P = (...a) => { const l = a.join(' '); console.log(l); out.push(l); };
const months = (I1 - I0) / 21;
const stats = (t) => {
  const w = t.filter((x) => x.r > 0), l = t.filter((x) => x.r <= 0);
  const gw = w.reduce((s, x) => s + x.r, 0), gl = -l.reduce((s, x) => s + x.r, 0);
  return { n: t.length, avg: mean(t.map((x) => x.r)), won: w.length / t.length, avgW: mean(w.map((x) => x.r)), avgL: mean(l.map((x) => x.r)), pf: gl > 0 ? gw / gl : Infinity };
};
const line = (lab, t) => { if (!t.length) return P(`  ${lab.padEnd(22)} no trades`); const s = stats(t); P(`  ${lab.padEnd(22)} ${String(s.n).padStart(5)} trades | avg ${pct(s.avg)} | won ${pct(s.won, 0)} | avg win ${pct(s.avgW)} / avg loss ${pct(s.avgL)} | profit factor ${s.pf.toFixed(2)}`); };
P(`STRATEGY: ${S.name ?? path.basename(file)}`);
P(`${S.side === 'buy' ? 'BUY' : 'SHORT'} | entry ${S.entryType === 'open' ? 'at the opening price' : S.entryType === 'stop' ? 'when price reaches the level (breakout)' : 'when price comes to the level (pullback)'} | stop ${S.exit.stop != null ? pct(S.exit.stop, 1) : 'none'} | target ${S.exit.target != null ? pct(S.exit.target, 1) : 'none'} | trailing ${S.exit.trail != null ? pct(S.exit.trail, 1) : 'none'} | ${S.exit.holdDays ? `hold up to ${S.exit.holdDays} days` : 'intraday (sold by 3:20 pm)'} | max ${S.maxPerDay} new a day, ${S.maxOpen} open at once | charges ${pct(S.costs, 2)} a trade`);
P(`Period ${mk.days[I0]} .. ${mk.days[I1 - 1]} (~${months.toFixed(0)} months) | stocks: Rs ${S.universe.minTurnoverCr} cr+/day, price Rs ${S.universe.minPrice}+${S.universe.skipT2T ? ', no T2T' : ''}${S.universe.skipETF ? ', no ETFs' : ''}${hourly ? ' | intraday exits on hourly bars where available' : ''}`);
if (!trades.length) { P('\nNo trades. The entry rule never matched - check the conditions.'); process.exit(0); }
P('\n== RESULT (after charges) ==');
line('ALL', trades);
P(`  ${(trades.length / months).toFixed(1)} trades a month | ${new Set(trades.map((t) => t.date)).size} trade days | average hold ${mean(trades.map((t) => t.days)).toFixed(1)} days`);
P(`  exits: ${Object.entries(trades.reduce((a, t) => ((a[t.how] = (a[t.how] ?? 0) + 1), a), {})).map(([k, v]) => `${k} ${v}`).join(', ')}`);
// money: capital split into maxOpen equal slots, each trade's result applied to its slot when it closes
let eq = 1, pk = 1, dd = 0; const byExit = [...trades].sort((a, b) => a.exitDate.localeCompare(b.exitDate));
const monthly = new Map();
for (const t of byExit) { eq *= 1 + t.r / S.maxOpen; pk = Math.max(pk, eq); dd = Math.min(dd, eq / pk - 1); const m = t.exitDate.slice(0, 7); monthly.set(m, (monthly.get(m) ?? 0) + t.r / S.maxOpen); }
const mv = [...monthly.values()];
P(`  money (capital split into ${S.maxOpen} equal parts, profits re-used): x${eq.toFixed(2)} | worst drop ${pct(dd, 1)} | green months ${mv.filter((v) => v > 0).length}/${mv.length} | average month ${pct(mean(mv), 1)}`);
let run = 0, maxRun = 0; for (const t of trades) { run = t.r <= 0 ? run + 1 : 0; maxRun = Math.max(maxRun, run); }
P(`  longest losing streak: ${maxRun} trades`);
P('\n== EACH YEAR / HALF-YEAR (does it work every time, or only once?) ==');
for (const y of [...new Set(trades.map((t) => t.date.slice(0, 4)))]) { line(y, trades.filter((t) => t.date.startsWith(y))); for (const [h, a, b] of [['  Jan-Jun', '01', '06'], ['  Jul-Dec', '07', '12']]) { const t = trades.filter((x) => x.date.startsWith(y) && x.date.slice(5, 7) >= a && x.date.slice(5, 7) <= b); if (t.length) line(`${y}${h}`, t); } }
P(`\n== UNSEEN-DATA CHECK: rules usually get tuned on old data; ${S.testFrom} onwards is the honest test ==`);
line(`before ${S.testFrom}`, trades.filter((t) => t.date < S.testFrom));
line(`from ${S.testFrom}`, trades.filter((t) => t.date >= S.testFrom));
P('\n== SAFETY CHECKS ==');
for (const slip of [0.0025, 0.005]) line(`fill ${slip * 100}% worse`, trades.map((t) => ({ ...t, r: t.r - slip })));
const sorted = [...trades].sort((a, b) => b.r - a.r);
line('without best 10 trades', sorted.slice(10));
const bySym = new Map(); for (const t of trades) bySym.set(t.symbol, (bySym.get(t.symbol) ?? 0) + t.r);
const topS = [...bySym].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s]) => s);
line('without top 5 stocks', trades.filter((t) => !topS.includes(t.symbol)));
P(`  ${bySym.size} different stocks; most profit from: ${topS.join(', ')}`);
P(`  best trades: ${sorted.slice(0, 5).map((t) => `${t.date} ${t.symbol} ${pct(t.r, 1)}`).join(', ')}`);
P(`  worst trades: ${sorted.slice(-5).reverse().map((t) => `${t.date} ${t.symbol} ${pct(t.r, 1)}`).join(', ')}`);
P('\n== LAST 15 TRADES ==');
for (const t of trades.slice(-15)) P(`  ${t.date} ${t.symbol.padEnd(12)} ${t.side} at Rs ${t.entry} -> ${t.how}${t.days ? ` (${t.days}d)` : ''} ${pct(t.r)}`);
const dir = new URL('./results/', import.meta.url); fs.mkdirSync(dir, { recursive: true });
const base = path.basename(file).replace(/\.m?js$/, '');
fs.writeFileSync(new URL(`${base}-report.txt`, dir), out.join('\n'));
fs.writeFileSync(new URL(`${base}-trades.csv`, dir), ['date,symbol,side,entry,exit_reason,days_held,exit_date,result_pct', ...trades.map((t) => `${t.date},${t.symbol},${t.side},${t.entry},${t.how},${t.days},${t.exitDate},${(t.r * 100).toFixed(2)}`)].join('\n'));
P(`\nSaved: mahins-strategy/results/${base}-report.txt and ${base}-trades.csv (opens in Excel)`);
