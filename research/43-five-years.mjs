// Step 43: the LIVE system (research 41 "NEW") over ~6 years, Jan 2021 - Nov 2026, split by market regime.
// Same rules as best-pick.mjs today: Panic HIGH / Gap & Go first, else the new Bounce-back; SHORT list alongside.
// Data: NSE bhavcopy (market-2021.json), NSE announcements (news-2021.json + news.json) for overnight results,
// Screener quarters (only from mid-2023) for the Gap & Go profit check, Nifty 50 + India VIX for regimes.
// Exits: daily bars everywhere (stop counted first = conservative) so every year is judged the same way;
// hourly bars (2024-26 only) are a side check. Costs 0.4% a trade, money split equally across a day's trades.
//   node --max-old-space-size=12000 research/43-five-years.mjs
import fs from 'node:fs';
import { etfList, fetchCached, mapPool } from '../src/sources.mjs';
import { targetQuarter } from '../src/score.mjs';

const DIR = new URL('../data/research/', import.meta.url);
const read = (f) => JSON.parse(fs.readFileSync(new URL(f, DIR), 'utf8'));
const mk = read('market-2021.json'), hourly = read('hourly.json'), funda = read('fundamentals.json'), idx = read('index-2020.json');
const news = [...read('news-2021.json').items, ...read('news.json').items].filter((x) => x.cat === 'result');
const ETFS = await etfList();
const NOT_STOCK = /ETF|BEES|IETF|ADD$|^LIQUID|^GILT|^MON100|^MAFANG|^HNGSNG|^NIFTY|^SENSEX|^GOLD|^SILVER|CASE$|^MOM|^MID150/;
const COST = 0.004, SLIP = Number(process.env.SLIP ?? 0), MINPX = Number(process.env.MINPX ?? 5); // SLIP = worse fill on entry, e.g. 0.0025
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (v, d = 2) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : '-');
const out = [];
const P = (...a) => { const l = a.join(' '); console.log(l); out.push(l); };

// ---- regimes -------------------------------------------------------------------------------------------
const nifty = idx['^NSEI'], vix = new Map(idx['^INDIAVIX']);
const niftyAt = new Map(nifty.map(([d], k) => [d, k]));
const PERIODS = [
  ['2021-01-01', '2021-05-31', 'Covid 2nd wave (fear, VIX 20-28)', 'crisis'],
  ['2021-06-01', '2021-10-31', 'Post-Covid bull run (calm)', 'normal'],
  ['2021-11-01', '2022-01-31', 'Omicron + FII selling (top)', 'normal'],
  ['2022-02-01', '2022-06-30', 'Russia-Ukraine war + rate hikes (VIX 32)', 'war'],
  ['2022-07-01', '2022-12-31', 'Recovery after war fall', 'normal'],
  ['2023-01-01', '2023-03-31', 'Adani-Hindenburg + US bank crisis', 'crisis'],
  ['2023-04-01', '2023-12-31', 'Calm bull (VIX ~11, Israel-Hamas Oct)', 'normal'],
  ['2024-01-01', '2024-04-30', 'Bull market', 'normal'],
  ['2024-05-01', '2024-06-30', 'Election + Jun 4 result crash', 'crisis'],
  ['2024-07-01', '2024-09-30', 'Bull top', 'normal'],
  ['2024-10-01', '2025-02-28', 'FII selling correction (-15%)', 'crisis'],
  ['2025-03-01', '2025-06-30', 'US tariffs + India-Pak conflict', 'war'],
  ['2025-07-01', '2026-02-28', 'Calm / sideways (VIX 10-14)', 'normal'],
  ['2026-03-01', '2026-05-31', '2026 war crash (Nifty -11% in Mar, VIX 28)', 'war'],
  ['2026-06-01', '2026-11-30', 'After the war: recovery / chop', 'normal'],
];
const TYPE_NAME = { normal: 'NORMAL years / calm', war: 'WAR / geopolitical', crisis: 'Other crisis (Covid, Adani, election, FII crash)' };
function regime(d) {
  const p = PERIODS.find(([a, b]) => d >= a && d <= b);
  let k = niftyAt.get(d); if (k == null) { k = nifty.findIndex(([x]) => x > d) - 1; }
  const c = nifty[k]?.[1], m200 = k >= 199 ? mean(nifty.slice(k - 199, k + 1).map((x) => x[1])) : null;
  const r60 = k >= 60 ? c / nifty[k - 60][1] - 1 : null;
  const prevVix = [...Array(5).keys()].map((j) => vix.get(nifty[k - 1 - j]?.[0])).find((v) => v != null); // yesterday's VIX = known before 9:15
  const trend = m200 == null ? null : r60 > 0.05 && c > m200 ? 'Strong uptrend' : c > m200 ? 'Mild uptrend' : r60 < -0.05 ? 'Strong downtrend' : 'Mild downtrend';
  const vb = prevVix == null ? null : prevVix < 13 ? 'VIX <13 (very calm)' : prevVix < 16 ? 'VIX 13-16 (normal)' : prevVix < 20 ? 'VIX 16-20 (nervous)' : 'VIX 20+ (fear)';
  return { period: p?.[2], type: p?.[3], trend, vb };
}

// ---- market prep ---------------------------------------------------------------------------------------
const byDay = mk.days.map(() => new Map());
for (const [s, rows] of Object.entries(mk.stocks)) rows.forEach((r, k) => byDay[r[0]].set(s, k));
const mGap = [];
for (let i = 1; i < mk.days.length; i++) { const g = []; for (const [s, k] of byDay[i]) { const r = mk.stocks[s][k]; if (r[1] > 0 && (r[6] ?? 0) >= 2 && r[2] !== r[1]) g.push(r[2] / r[1] - 1); } mGap[i] = g.length > 150 ? median(g) : null; }
const resultsOn = mk.days.map(() => new Set());
const dayPos = new Map(mk.days.map((d, i) => [d, i]));
for (const e of news) {
  const [d, t = '00:00'] = e.time.split(' ');
  // results filed after yesterday 15:30 and before today 09:00 belong to today's open
  let i = mk.days.findIndex((x) => x > d || (x === d && t < '09:00'));
  if (i < 1 || (mk.days[i] === d && t >= '09:00')) continue;
  const pd = mk.days[i - 1]; if (d < pd || (d === pd && t < '15:30')) continue;
  resultsOn[i].add(e.symbol);
}
const START = mk.days.findIndex((d) => d >= '2021-01-01');
const series = new Map();
await mapPool([...Array(mk.days.length).keys()].filter((i) => i >= START), 6, async (i) => {
  const [Y, M, D] = mk.days[i - 1].split('-');
  const csv = await fetchCached(`https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${D}${M}${Y}.csv`, { ttlHours: 1e7, attempts: 1 }).catch(() => null);
  if (!csv?.startsWith('SYMBOL')) return;
  const m = new Map(); for (const line of csv.split('\n').slice(1)) { const p = line.split(','); if (p[0]) m.set(p[0].trim(), p[1]?.trim()); }
  series.set(i, m);
});

function exitDaily(r, side, stop, tgt) {
  const o = r[2] * (side === 'buy' ? 1 + SLIP : 1 - SLIP);
  if (side === 'buy') return (r[4] <= o * (1 - stop) ? -stop : tgt && r[3] >= o * (1 + tgt) ? tgt : r[5] / o - 1) - COST;
  return (r[3] >= o * (1 + stop) ? -stop : tgt && r[4] <= o * (1 - tgt) ? tgt : -(r[5] / o - 1)) - COST;
}
function exitHourly(s, d, r, side, stop, tgt) {
  const o = r[2] * (side === 'buy' ? 1 + SLIP : 1 - SLIP), b = hourly[s]?.[d], last = b?.filter((x) => x[0] < 1530).at(-1);
  if (!last) return null;
  const sc = r[5] / last[4], H = b.filter((x) => x[0] < 1520).map(([t, a, h, l, c]) => [t, a * sc, h * sc, l * sc, c * sc]);
  for (const [n, x] of H.entries()) {
    if (side === 'buy') { const sp = o * (1 - stop); if (x[3] <= sp) return (n ? Math.min(sp, x[1]) : sp) / o - 1 - COST; if (tgt && x[2] >= o * (1 + tgt)) return tgt - COST; }
    else { const sp = o * (1 + stop); if (x[2] >= sp) return -((n ? Math.max(sp, x[1]) : sp) / o - 1) - COST; if (tgt && x[3] <= o * (1 - tgt)) return tgt - COST; }
  }
  return (side === 'buy' ? H.at(-1)[4] / o - 1 : -(H.at(-1)[4] / o - 1)) - COST;
}

// ---- day loop (same rules as research 41 NEW = live) -----------------------------------------------------
const days = [];
for (let i = START; i < mk.days.length; i++) {
  const d = mk.days[i]; if (mGap[i] == null) continue;
  const ser = series.get(i);
  const main = [], bounce = [], shorts = [];
  for (const [s, k] of byDay[i]) {
    if (k < 25 || ETFS.has(s) || NOT_STOCK.test(s)) continue;
    const R = mk.stocks[s], r = R[k], y = R[k - 1];
    if (y[0] !== i - 1 || !(r[1] > 0) || !(y[1] > 0) || r[1] < MINPX) continue;
    const sr = ser?.get(s); if (sr === 'BE') continue;
    const cr = median(R.slice(k - 20, k).map((x) => x[6] ?? 0)); if (!(cr >= 1)) continue;
    const gap = r[2] / r[1] - 1, yRet = y[5] / y[1] - 1, res = resultsOn[i].has(s);
    const c = { s, r, cr, d };
    if (mGap[i] <= -0.012 && gap <= -0.03 && gap > -0.0495 && cr >= 20 && !res) main.push({ ...c, kind: 'Panic', side: 'buy', stop: 0.03, tgt: null });
    if (res && gap >= 0.05 && gap < 0.2 && cr >= 5) {
      const p14 = R.slice(k - 14, k), atr = mean(p14.map((x, j) => { const pc = j ? p14[j - 1][5] : x[1]; return Math.max(x[3], pc) - Math.min(x[4], pc); })) / y[5];
      const lv = { stop: Math.min(0.08, Math.max(0.02, 1.25 * atr)), tgt: Math.min(0.15, Math.max(0.04, 2 * atr)) };
      const q = funda[s]?.q, T = targetQuarter(d), pat = (x) => q?.[x]?.pat;
      if (q && pat(T) != null && pat(T - 1) != null && pat(T - 4) != null) {
        const yoy = pat(T - 4) > 0 ? pat(T) / pat(T - 4) - 1 : (pat(T) > pat(T - 4) ? 1 : -1);
        if (pat(T - 1) > 0 && pat(T) / pat(T - 1) - 1 > 0 && yoy > 0) main.push({ ...c, kind: 'Gap & Go', side: 'buy', ...lv });
      } // no profit numbers (before ~Oct 2024): can't apply the live rule, so no Gap & Go that day
    }
    if (!res && yRet <= -0.03 && yRet > -0.08 && gap <= -0.02 && gap > -0.0495) {
      let big5 = 0; for (let j = k - 6; j < k - 1; j++) if (R[j][5] / R[j][1] - 1 <= -0.045) big5++;
      if (big5 >= 1) bounce.push({ ...c, kind: 'Bounce-back', side: 'buy', stop: 0.03, tgt: 0.07 });
    }
    const lc = (x) => x[3] > x[4] && x[5] === x[4] && x[5] / x[1] - 1 <= -0.045;
    if (sr === 'EQ' && lc(y) && !lc(R[k - 2]) && gap - mGap[i] > 0.01 && mGap[i] >= 0) shorts.push({ ...c, kind: 'Short', side: 'short', stop: 0.02, tgt: 0.05 });
  }
  const top = (l) => l.sort((a, b) => b.cr - a.cr).slice(0, 3);
  const run = (l) => l.map((t) => ({ kind: t.kind, s: t.s, proxy: !!t.proxy, ret: exitDaily(t.r, t.side, t.stop, t.tgt), hret: exitHourly(t.s, t.d, t.r, t.side, t.stop, t.tgt) }));
  const m = run(top(main));
  const buys = m.length ? m : run(top(bounce));
  days.push({ d, ...regime(d), mGap: mGap[i], trades: [...buys, ...run(top(shorts))] });
}

// ---- reporting -------------------------------------------------------------------------------------------
const dayRet = (x, f = 'ret') => mean(x.trades.map((t) => t[f]));
function stats(ds, filt = () => true) {
  const td = ds.map((x) => ({ ...x, trades: x.trades.filter(filt) })).filter((x) => x.trades.length);
  const tr = td.flatMap((x) => x.trades), dr = td.map((x) => dayRet(x));
  let eq = 1, pk = 1, dd = 0; for (const v of dr) { eq *= 1 + v; pk = Math.max(pk, eq); dd = Math.min(dd, eq / pk - 1); }
  const mo = {}; for (const x of td) mo[x.d.slice(0, 7)] = (mo[x.d.slice(0, 7)] ?? 1) * (1 + dayRet(x));
  const mv = Object.values(mo).map((v) => v - 1);
  const months = ds.length / 21 || 1;
  return { n: tr.length, td: td.length, perMo: td.length / months, avgT: mean(tr.map((t) => t.ret)), won: tr.filter((t) => t.ret > 0).length / tr.length,
    avgD: mean(dr), eq, dd, moPos: mv.filter((v) => v > 0).length / mv.length, worstMo: Math.min(...mv), mCount: mv.length, monthly: mean(dr) * td.length / months };
}
const row = (label, s) => `${label.padEnd(46)} ${String(s.n).padStart(4)} tr ${String(s.td).padStart(4)} d ${s.perMo.toFixed(1).padStart(5)}/mo | trade ${pct(s.avgT).padStart(7)} won ${pct(s.won, 0).padStart(4)} | day ${pct(s.avgD).padStart(7)} ~${pct(s.monthly, 1).padStart(6)}/mo | x${s.eq.toFixed(2).padStart(5)} drop ${pct(s.dd, 0).padStart(4)} | green months ${pct(s.moPos, 0)} worst ${pct(s.worstMo, 0)}`;
const head = `${'GROUP'.padEnd(46)} trades days  freq   | avg/trade   win  | avg/trade-day  ~monthly | money  worst drop | months`;

P(`RESEARCH 43 - LIVE SYSTEM OVER ${days[0].d} .. ${days.at(-1).d} (${days.length} market days). Costs 0.4%/trade${SLIP ? `, entry ${pct(SLIP)} worse` : ''}. Daily bars, stop first.`);
P(`Bhavcopy series known on ${series.size} days. Gap & Go needs profit numbers, which start ~Oct 2024; before that it cannot be tested and Bounce-back takes those days.`);
P(`\n== WHOLE PERIOD ==`); P(head);
P(row('ALL (live rules)', stats(days)));
for (const k of ['Panic', 'Gap & Go', 'Bounce-back', 'Short']) P(row(`  only ${k}`, stats(days, (t) => t.kind === k)));

P(`\n== BY YEAR ==`); P(head);
for (const y of ['2021', '2022', '2023', '2024', '2025', '2026']) P(row(y, stats(days.filter((x) => x.d.startsWith(y)))));

P(`\n== BY MARKET TYPE ==`); P(head);
for (const t of ['normal', 'war', 'crisis']) P(row(TYPE_NAME[t], stats(days.filter((x) => x.type === t))));

P(`\n== BY NAMED PERIOD ==`); P(head);
for (const [, , name] of PERIODS) { const ds = days.filter((x) => x.period === name); if (ds.length) P(row(name, stats(ds))); }

P(`\n== BY NIFTY TREND (close vs 200-day average, 3-month move) ==`); P(head);
for (const t of ['Strong uptrend', 'Mild uptrend', 'Mild downtrend', 'Strong downtrend']) P(row(t, stats(days.filter((x) => x.trend === t))));

P(`\n== BY FEAR LEVEL (yesterday's India VIX) ==`); P(head);
for (const t of ['VIX <13 (very calm)', 'VIX 13-16 (normal)', 'VIX 16-20 (nervous)', 'VIX 20+ (fear)']) P(row(t, stats(days.filter((x) => x.vb === t))));

P(`\n== EACH STRATEGY x MARKET TYPE (avg per trade, trades, win) ==`);
for (const k of ['Panic', 'Gap & Go', 'Bounce-back', 'Short']) {
  P(`  ${k.padEnd(28)} ${['normal', 'war', 'crisis'].map((t) => { const s = stats(days.filter((x) => x.type === t), (q) => q.kind === k); return `${t}: ${s.n ? `${pct(s.avgT)} (${s.n} tr, ${pct(s.won, 0)} won)` : 'none'}`; }).join(' | ')}`);
}
P(`\n== EACH STRATEGY x YEAR (avg per trade / trades) ==`);
for (const k of ['Panic', 'Gap & Go', 'Bounce-back', 'Short']) {
  P(`  ${k.padEnd(28)} ${['2021', '2022', '2023', '2024', '2025', '2026'].map((y) => { const s = stats(days.filter((x) => x.d.startsWith(y)), (q) => q.kind === k); return `${y} ${s.n ? `${pct(s.avgT, 1)}/${s.n}` : '-'}`; }).join(' | ')}`);
}

P(`\n== TIMEFRAME CHECK (2024-26 trades that have hourly bars: daily-bar result vs hourly-bar result) ==`);
const both = days.flatMap((x) => x.trades).filter((t) => t.hret != null);
P(`  ${both.length} trades: daily bars ${pct(mean(both.map((t) => t.ret)))} vs hourly bars ${pct(mean(both.map((t) => t.hret)))} per trade (won ${pct(both.filter((t) => t.ret > 0).length / both.length, 0)} vs ${pct(both.filter((t) => t.hret > 0).length / both.length, 0)})`);
for (const k of ['Panic', 'Gap & Go', 'Bounce-back', 'Short']) { const a = both.filter((t) => t.kind === k); if (a.length) P(`    ${k.padEnd(12)} ${a.length} tr: daily ${pct(mean(a.map((t) => t.ret)))} | hourly ${pct(mean(a.map((t) => t.hret)))}`); }

P(`\n== MONTHS (all, money multiplied within the month) ==`);
const mo = {}; for (const x of days) if (x.trades.length) { const m = x.d.slice(0, 7); (mo[m] ??= { v: 1, n: 0 }); mo[m].v *= 1 + dayRet(x); mo[m].n++; }
const ms = Object.entries(mo);
for (let j = 0; j < ms.length; j += 6) P('  ' + ms.slice(j, j + 6).map(([m, x]) => `${m} ${pct(x.v - 1, 1).padStart(6)} (${String(x.n).padStart(2)}d)`).join('  '));
let streak = 0, worst = 0; for (const x of days) { if (!x.trades.length) continue; if (dayRet(x) < 0) { streak++; worst = Math.max(worst, streak); } else streak = 0; }
P(`  longest losing streak: ${worst} trade days in a row`);

fs.writeFileSync(new URL(`five-years-report${SLIP ? '-slip' : ''}${MINPX !== 5 ? '-px' + MINPX : ''}.txt`, DIR), out.join('\n'));
fs.writeFileSync(new URL(`five-years-days${SLIP ? '-slip' : ''}${MINPX !== 5 ? '-px' + MINPX : ''}.json`, DIR), JSON.stringify(days.map((x) => ({ d: x.d, period: x.period, type: x.type, trend: x.trend, vb: x.vb, mGap: x.mGap, trades: x.trades }))));
