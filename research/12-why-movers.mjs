// Step 12: WHY did the day's big gainers go up, and WHEN could we have known the reason?
// Joins every liquid stock-day (market.json) with every NSE announcement (news.json, step 11) and the
// 5-minute bars (intraday.json, last ~60 days).
//   node research/12-why-movers.mjs        -> data/research/why-movers-report.txt
// Part A: reasons behind the gainers (close 5%+ above yesterday), as a share of all gainers.
// Part B: news known BEFORE 9:08 by type: how often it makes a gainer, and does buying at the open pay?
// Part C: news filed DURING the day (5-min bars): how much of the move came before the filing (leak),
//         and does buying 5-10 minutes after the filing pay (sell 3:15 pm)?
// Part D: the gainers with no news at all: sector days, small caps, streaks.
import fs from 'node:fs';
import { typeOf, STRONG } from './news-types.mjs';

const DIR = new URL('../data/research/', import.meta.url);
const read = (f) => JSON.parse(fs.readFileSync(new URL(f, DIR), 'utf8'));
const { days, stocks } = read('market.json');
const funda = read('fundamentals.json');
const news = read('news.json').items;
const intraday = fs.existsSync(new URL('intraday.json', DIR)) ? read('intraday.json') : {};
// Only the last 6 months: the user's view is that crowd behaviour keeps changing (and the 2026 war made older data mixed).
// Still split in two, so a pattern found in the first part has to hold in the second.
const PERIODS = { learn: ['2026-05-18', '2026-08-31'], check: ['2026-09-01', '2099-12-31'] };
const periodOf = (iso) => Object.keys(PERIODS).find((k) => iso >= PERIODS[k][0] && iso <= PERIODS[k][1]);
const NOT_STOCK = /ETF|BEES|IETF|ADD$|^LIQUID|^GILT|^MON100|^MAFANG|^HNGSNG|^NIFTY|^SENSEX|^GOLD|^SILVER/;
const COST = 0.0015; // brokerage + taxes + slippage, round trip
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (v, d = 1) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : '   -  ');
const out = [];
const log = (s = '') => { out.push(s); console.log(s); };

// ---- index news by stock and trading day ----
// "pre" = filed after 15:30 on the previous trading day and before 9:08 today; "day" = 9:08 to 15:30 today.
const dayIdx = new Map(days.map((d, i) => [d, i]));
const nextTradingIdx = (iso) => { let lo = 0, hi = days.length; while (lo < hi) { const m = (lo + hi) >> 1; if (days[m] <= iso) lo = m + 1; else hi = m; } return lo; };
const newsBy = new Map(); // `${sym}|${i}` -> { pre: [], day: [] }
for (const n of news) {
  const t = typeOf(n.desc, n.text);
  if (t === 'routine') continue;
  const d = n.time.slice(0, 10), hm = n.time.slice(11, 16);
  let i, when = 'pre';
  if (dayIdx.has(d) && hm < '09:08') i = dayIdx.get(d);
  else if (dayIdx.has(d) && hm <= '15:30') { i = dayIdx.get(d); when = 'day'; }
  else i = nextTradingIdx(d); // after the close, or a holiday/weekend -> next trading day's morning
  if (i >= days.length) continue;
  const k = `${n.symbol}|${i}`;
  const e = newsBy.get(k) ?? newsBy.set(k, { pre: [], day: [] }).get(k);
  e[when].push({ type: t, hm, desc: n.desc, text: n.text });
}
const bestType = (list) => STRONG.find((t) => list.some((x) => x.type === t));

// ---- price series and stock-day rows ----
const series = {};
for (const [sym, rws] of Object.entries(stocks)) {
  if (NOT_STOCK.test(sym)) continue;
  const arr = new Array(days.length);
  for (const r of rws) arr[r[0]] = { prev: r[1], open: r[2], high: r[3], low: r[4], close: r[5], cr: r[6], deliv: r[7] };
  series[sym] = arr;
}
const industryOf = (s) => funda[s]?.industry ?? null;
const rows = [];
for (const [sym, arr] of Object.entries(series)) {
  for (let i = 25; i < days.length; i++) {
    const t = arr[i], y = arr[i - 1];
    if (!t || !y || !(t.prev > 0) || !(t.open > 0)) continue;
    if (Math.abs(t.prev / y.close - 1) > 0.02) continue; // split/bonus day
    const liqH = []; for (let j = i - 1; j >= 0 && liqH.length < 20; j--) if (arr[j]) liqH.push(arr[j].cr);
    const liq = median(liqH);
    if (!(liq >= 2)) continue;
    const ret = t.close / t.prev - 1;
    let streak = 0; for (let j = i - 1; j > i - 6 && arr[j]; j--) { if (arr[j].close / arr[j].prev - 1 > 0.02) streak++; else break; }
    let hi20 = 0; for (let j = i - 1; j > i - 21 && j >= 0; j--) if (arr[j]) hi20 = Math.max(hi20, arr[j].high);
    const nb = newsBy.get(`${sym}|${i}`) ?? { pre: [], day: [] };
    rows.push({ sym, i, d: days[i], p: periodOf(days[i]), liq, ret, gap: t.open / t.prev - 1, oc: t.close / t.open - 1,
      yRet: y.close / y.prev - 1, volX: t.cr / liq, streak, brk: t.close > hi20, ind: industryOf(sym),
      pre: bestType(nb.pre), day: bestType(nb.day), preList: nb.pre, dayList: nb.day });
  }
}
// sector day: average return of the stock's industry peers (without itself), when 5+ stocks trade
const indDay = new Map();
for (const r of rows) if (r.ind) { const k = `${r.ind}|${r.i}`; (indDay.get(k) ?? indDay.set(k, []).get(k)).push(r.ret); }
const mktDay = new Map();
for (const r of rows) (mktDay.get(r.i) ?? mktDay.set(r.i, []).get(r.i)).push(r.ret);
const mktMed = new Map([...mktDay].map(([i, a]) => [i, median(a)]));
const secOf = new Map();
for (const r of rows) {
  const peers = r.ind ? indDay.get(`${r.ind}|${r.i}`) : null;
  r.sector = peers && peers.length >= 5 ? (peers.reduce((s, x) => s + x, 0) - r.ret) / (peers.length - 1) : null;
  r.mkt = mktMed.get(r.i);
  secOf.set(`${r.sym}|${r.i}`, r.sector);
}
for (const r of rows) r.ySector = secOf.get(`${r.sym}|${r.i - 1}`) ?? null;
const inP = rows.filter((r) => r.p);
log(`WHY THE DAY'S GAINERS WENT UP  (built ${new Date().toISOString().slice(0, 10)})`);
log(`Stock-days: ${inP.length.toLocaleString()} (liquid Rs 2 cr+/day, ${PERIODS.learn[0]}..${days.at(-1)}). Announcements: ${news.length.toLocaleString()} (routine filings ignored).`);
log(`Periods: ${Object.entries(PERIODS).map(([k, [a, b]]) => `${k} ${a}..${b > '2090' ? days.at(-1) : b}`).join(' | ')}. Costs ${pct(COST, 2)} per trade.`);

// ---------- PART A ----------
const reasonOf = (r) => {
  if (r.pre === 'result') return '1 result (filed before open)';
  if (r.day === 'result') return '2 result (filed during day)';
  if (r.pre) return '3 other news before open';
  if (r.day) return '4 other news during day';
  if (r.sector != null && r.sector >= 0.02) return '5 no news, sector rally (peers avg +2%+)';
  if (r.mkt >= 0.015) return '6 no news, whole market up 1.5%+';
  if (r.streak >= 2) return '7 no news, already rising 2+ days';
  return '8 no news, no sector move (unexplained)';
};
const gainers = inP.filter((r) => r.ret >= 0.05);
const nDays = new Set(inP.map((r) => r.i)).size;
log('\n==== PART A: who are the gainers? ====');
log(`Gainers (close 5%+ above yesterday): ${gainers.length.toLocaleString()} over ${nDays} days = ${(gainers.length / nDays).toFixed(0)} a day.`);
log(`  Opened 2%+ up already: ${pct(gainers.filter((r) => r.gap >= 0.02).length / gainers.length, 0)};  rose 5%+ AFTER the open (open->close): ${pct(gainers.filter((r) => r.oc >= 0.05).length / gainers.length, 0)}`);
const groupA = {};
for (const r of gainers) (groupA[reasonOf(r)] ??= []).push(r);
log(`\n  reason                                          share  per day  avg gap  avg open->close  Rs cr/day (median)`);
for (const k of Object.keys(groupA).sort()) {
  const g = groupA[k];
  log(`  ${k.padEnd(46)} ${pct(g.length / gainers.length, 0).padStart(5)}  ${(g.length / nDays).toFixed(1).padStart(5)}   ${pct(mean(g.map((r) => r.gap))).padStart(6)}   ${pct(mean(g.map((r) => r.oc))).padStart(6)}           ${median(g.map((r) => r.liq)).toFixed(0).padStart(4)}`);
}
log('\n  News type behind gainers (share of ALL gainers):');
const typeCount = {};
for (const r of gainers) { const t = r.pre || r.day; if (t) typeCount[t] = (typeCount[t] ?? 0) + 1; }
log('  ' + Object.entries(typeCount).sort((a, b) => b[1] - a[1]).map(([t, c]) => `${t} ${pct(c / gainers.length, 0)}`).join(', '));
log('  By period:');
for (const p of Object.keys(PERIODS)) {
  const g = gainers.filter((r) => r.p === p);
  log(`    ${p.padEnd(5)} n=${String(g.length).padStart(5)}  any news ${pct(g.filter((r) => r.pre || r.day).length / g.length, 0)}  result ${pct(g.filter((r) => r.pre === 'result' || r.day === 'result').length / g.length, 0)}  sector rally ${pct(g.filter((r) => reasonOf(r).startsWith('5')).length / g.length, 0)}  unexplained ${pct(g.filter((r) => reasonOf(r).startsWith('8')).length / g.length, 0)}`);
}

// ---------- PART B ----------
log('\n==== PART B: news known before 9:08 - does it make a gainer, and does buying at the OPEN pay? ====');
log('  gain% = how often it closed 5%+ above yesterday. trade = buy at open, sell at close, after costs. w = trades won.');
const stat = (rs) => ({ n: rs.length, g: rs.filter((r) => r.ret >= 0.05).length / rs.length, oc: mean(rs.map((r) => r.oc - COST)), win: rs.filter((r) => r.oc - COST > 0).length / rs.length });
const showB = (label, f) => {
  const cells = Object.keys(PERIODS).map((p) => { const s = stat(inP.filter((r) => r.p === p && f(r))); return s.n < 15 ? `n=${String(s.n).padStart(5)}  (too few)       ` : `n=${String(s.n).padStart(5)} ${pct(s.g, 0).padStart(4)} ${pct(s.oc, 2).padStart(7)} w${pct(s.win, 0).padStart(4)}`; });
  log(`  ${label.padEnd(36)} ${cells.join(' | ')}`);
};
log(`  ${''.padEnd(36)} ${Object.keys(PERIODS).map((p) => `${p.padEnd(7)} gain%   trade  w`.padEnd(29)).join(' | ')}`);
showB('every stock-day', () => true);
showB('no news before open', (r) => !r.pre);
for (const t of STRONG) showB(`news before open: ${t}`, (r) => r.pre === t);
log('  Only when the stock opened 0..+3% (news not yet priced in):');
for (const t of ['result', 'order', 'approval', 'deal', 'capacity', 'corporate', 'press', 'other']) showB(`  ${t}, opens 0..+3%`, (r) => r.pre === t && r.gap >= 0 && r.gap < 0.03);
log('  Gap-up of +3..+10% on that news:');
for (const t of ['result', 'order', 'approval', 'deal', 'capacity', 'corporate']) showB(`  ${t}, opens +3..+10%`, (r) => r.pre === t && r.gap >= 0.03 && r.gap < 0.10);
log('  Sector follow-through (no news on this stock):');
showB('  peers avg +2% yesterday', (r) => !r.pre && r.ySector >= 0.02);
showB('  peers +2% yday, this one lagged', (r) => !r.pre && r.ySector >= 0.02 && r.yRet < 0.01);
showB('  peers +2% yday, lagged, opens <=0', (r) => !r.pre && r.ySector >= 0.02 && r.yRet < 0.01 && r.gap <= 0);

// ---------- PART C ----------
log('\n==== PART C: news filed DURING market hours (5-min bars, last ~60 days) ====');
const bars = (sym, d) => intraday[sym]?.[d];
const toMin = (hhmm) => Math.floor(hhmm / 100) * 60 + (hhmm % 100);
const C = [];
for (const r of inP) {
  if (!r.dayList.length) continue;
  const b = bars(r.sym, r.d);
  if (!b || b.length < 40) continue;
  const first = [...r.dayList].sort((a, z) => a.hm.localeCompare(z.hm))[0];
  const [hh, mm] = first.hm.split(':').map(Number);
  const fMin = hh * 60 + mm;
  if (fMin < 9 * 60 + 20 || fMin > 15 * 60) continue;
  // price at filing = close of the last bar that ended before the filing; buy = close of the bar starting 5+ min after
  const before = b.filter((x) => toMin(x[0]) + 5 <= fMin).at(-1);
  const buyBar = b.find((x) => toMin(x[0]) >= fMin + 5);
  const exit = b.filter((x) => x[0] <= 1515).at(-1);
  if (!before || !buyBar || !exit || toMin(buyBar[0]) > 15 * 60 + 10) continue;
  const prevC = series[r.sym][r.i].prev;
  const dayHigh = Math.max(...b.map((x) => x[2]));
  C.push({ ...r, type: first.type, hm: first.hm, preMove: before[4] / prevC - 1, jump: buyBar[4] / before[4] - 1,
    after: exit[4] / buyBar[4] - 1 - COST, best: dayHigh / prevC - 1 });
}
const span = [...new Set(C.map((r) => r.d))].sort();
log(`  ${C.length} stock-days with news filed 9:20-15:00 and 5-min bars (${span[0]}..${span.at(-1)}, one period only: treat as a hint).`);
log(`  type          n   yday->filing  jump in 5-10 min  buy then, sell 3:15 (net)  win  | gainers: median share of the day's best move done BEFORE the filing`);
for (const t of ['all', ...STRONG]) {
  const g = C.filter((r) => t === 'all' || r.type === t);
  if (g.length < 8) continue;
  const gg = g.filter((r) => r.ret >= 0.05);
  const leak = gg.length ? median(gg.map((r) => Math.max(0, Math.min(1, r.preMove / r.best)))) : NaN;
  log(`  ${t.padEnd(11)} ${String(g.length).padStart(4)}   ${pct(mean(g.map((r) => r.preMove))).padStart(7)}       ${pct(mean(g.map((r) => r.jump))).padStart(7)}          ${pct(mean(g.map((r) => r.after)), 2).padStart(7)}           ${pct(g.filter((r) => r.after > 0).length / g.length, 0).padStart(4)} | ${String(gg.length).padStart(3)} gainers, ${Number.isFinite(leak) ? pct(leak, 0) : '-'} before filing`);
}
log('  Filing that itself sparks a jump (+2% within 5-10 min), then buy:');
for (const t of ['all', 'result', 'order', 'deal', 'approval', 'other']) {
  const g = C.filter((r) => (t === 'all' || r.type === t) && r.jump >= 0.02);
  if (g.length < 5) continue;
  log(`    ${t.padEnd(9)} n=${String(g.length).padStart(3)}  then ${pct(mean(g.map((r) => r.after)), 2)}  win ${pct(g.filter((r) => r.after > 0).length / g.length, 0)}`);
}
const intraDays = new Set(Object.values(intraday).flatMap((o) => Object.keys(o)));
const gIntra = inP.filter((r) => r.ret >= 0.05 && intraDays.has(r.d) && bars(r.sym, r.d)?.length >= 40);
let newsFirst = 0, moveFirst = 0, noNewsAll = 0;
const startTimes = [];
for (const r of gIntra) {
  const b = bars(r.sym, r.d); const prevC = series[r.sym][r.i].prev;
  const hit = b.find((x) => x[2] / prevC - 1 >= 0.03); // first bar that touches +3% vs yesterday
  if (!hit) continue;
  startTimes.push(hit[0]);
  if (r.pre) { newsFirst++; continue; }
  const dayNews = r.dayList.map((x) => Number(x.hm.replace(':', ''))).sort((a, z) => a - z)[0];
  if (dayNews && dayNews <= hit[0] + 5) newsFirst++; else if (dayNews) moveFirst++; else noNewsAll++;
}
const tot = newsFirst + moveFirst + noNewsAll;
log(`\n  ${tot} gainers inside the 5-min window. When did they first touch +3% above yesterday?`);
const buckets = [[915, 920, '9:15 bar'], [920, 945, '9:20-9:45'], [945, 1100, '9:45-11:00'], [1100, 1300, '11-13:00'], [1300, 1530, 'after 13:00']];
log('    ' + buckets.map(([a, z, l]) => `${l} ${pct(startTimes.filter((x) => x >= a && x < z).length / startTimes.length, 0)}`).join(', '));
log(`    news came first (before open, or filed before the +3% touch): ${pct(newsFirst / tot, 0)}`);
log(`    price moved first, a filing came LATER that day: ${pct(moveFirst / tot, 0)}`);
log(`    no news at all that day: ${pct(noNewsAll / tot, 0)}`);

// ---------- PART D ----------
log('\n==== PART D: gainers with NO news - what do they have in common? (vs all no-news stock-days) ====');
const noNews = inP.filter((r) => !r.pre && !r.day);
const nnG = noNews.filter((r) => r.ret >= 0.05);
const share = (rs, f) => rs.filter(f).length / rs.length;
const feats = [
  ['small (Rs 2-10 cr/day)', (r) => r.liq < 10], ['big (Rs 50 cr+/day)', (r) => r.liq >= 50],
  ['peers avg +2%+ same day', (r) => r.sector >= 0.02], ['peers avg +2%+ yesterday', (r) => r.ySector >= 0.02],
  ['market median +1%+ same day', (r) => r.mkt >= 0.01], ['up 2%+ each of last 2 days', (r) => r.streak >= 2],
  ['up 5%+ yesterday', (r) => r.yRet >= 0.05], ['opened 2%+ up', (r) => r.gap >= 0.02], ['opened 1%+ down', (r) => r.gap <= -0.01],
  ['volume 3x normal (same day)', (r) => r.volX >= 3], ['closed at a 20-day high', (r) => r.brk],
];
log(`  ${nnG.length.toLocaleString()} no-news gainers (${pct(nnG.length / gainers.length, 0)} of all gainers) vs ${noNews.length.toLocaleString()} no-news stock-days`);
for (const [l, f] of feats) { const a = share(nnG, f), b = share(noNews, f); log(`  ${l.padEnd(30)} gainers ${pct(a, 0).padStart(4)}  vs normal ${pct(b, 0).padStart(4)}  (${(a / b).toFixed(1)}x)`); }
const indG = {};
for (const r of nnG) if (r.ind) indG[r.ind] = (indG[r.ind] ?? 0) + 1;
log('  Industries most often behind no-news gainers: ' + Object.entries(indG).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k} ${v}`).join(', '));

// ---------- examples ----------
log('\n==== EXAMPLES: the last 3 trading days, every gainer and its reason ====');
for (const i of [days.length - 3, days.length - 2, days.length - 1]) {
  const g = rows.filter((r) => r.i === i && r.ret >= 0.05).sort((a, b) => b.ret - a.ret);
  log(`\n  ${days[i]}: ${g.length} gainers, market median ${pct(mktMed.get(i))}`);
  for (const r of g) {
    const n = [...r.preList.map((x) => ({ ...x, w: 'pre' })), ...r.dayList.map((x) => ({ ...x, w: x.hm }))]
      .sort((a, z) => STRONG.indexOf(a.type) - STRONG.indexOf(z.type))[0];
    const why = n ? `${n.w === 'pre' ? 'before open' : 'at ' + n.w} ${n.type}: ${(n.text || n.desc).replace(/\s+/g, ' ').replace(/^.*?has informed the Exchange (about|regarding|that) /i, '').slice(0, 90)}` : reasonOf(r).slice(2);
    log(`   ${r.sym.padEnd(12)} ${pct(r.ret).padStart(6)} gap ${pct(r.gap).padStart(6)} | ${why}`);
  }
}
fs.writeFileSync(new URL('why-movers-report.txt', DIR), out.join('\n'));
