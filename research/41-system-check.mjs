// Step 41: before going live, the WHOLE system old vs new, day by day (Apr 2024 - Nov 2026).
// Each day, like the live picker: Panic rebound (HIGH) / Gap & Go first; only if none, Bounce-back. Top 3 most traded.
// NEW adds the Bounce-back filters (fell before too, no 8%+ crash) and the SHORT list (sent alongside, every day).
// Real NSE series from the previous day's bhavcopy (no T2T buys; shorts EQ only). Opening price as the fill; the -2%
// limit means Bounce-back buys stocks opening -2..-5%. Exits on hourly bars where we have them (stop first in a bar),
// daily bars otherwise (stop first). Costs 0.4% a trade. Money split equally across the day's trades.
//   node --max-old-space-size=12000 research/41-system-check.mjs
import fs from 'node:fs';
import { etfList, fetchCached, mapPool } from '../src/sources.mjs';
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
const P = (...a) => console.log(a.join(' '));

const byDay = mk.days.map(() => new Map());
for (const [s, rows] of Object.entries(mk.stocks)) rows.forEach((r, k) => byDay[r[0]].set(s, k));
const mGap = [];
for (let i = 1; i < mk.days.length; i++) { const g = []; for (const [s, k] of byDay[i]) { const r = mk.stocks[s][k]; if (r[1] > 0 && (r[6] ?? 0) >= 2) g.push(r[2] / r[1] - 1); } mGap[i] = g.length > 200 ? median(g) : null; }
const resultsOn = mk.days.map(() => new Set());
for (const e of events) {
  const [d, t = '00:00'] = e.time.split(' ');
  const i = mk.days.findIndex((x) => x > d || (x === d && t < '09:00'));
  if (i < 1 || (mk.days[i] === d && t >= '09:00')) continue;
  const pd = mk.days[i - 1]; if (d < pd || (d === pd && t < '15:30')) continue;
  resultsOn[i].add(e.symbol);
}
const START = mk.days.findIndex((d) => d >= '2024-04-01');
const series = new Map();
await mapPool([...Array(mk.days.length).keys()].filter((i) => i >= START), 6, async (i) => {
  const [Y, M, D] = mk.days[i - 1].split('-');
  const csv = await fetchCached(`https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${D}${M}${Y}.csv`, { ttlHours: 1e7, attempts: 1 }).catch(() => null);
  if (!csv?.startsWith('SYMBOL')) return;
  const m = new Map(); for (const line of csv.split(String.fromCharCode(10)).slice(1)) { const p = line.split(','); if (p[0]) m.set(p[0].trim(), p[1]?.trim()); }
  series.set(i, m);
});

function exit(s, d, r, side, stop, tgt) {
  const o = r[2], b = hourly[s]?.[d], last = b?.filter((x) => x[0] < 1530).at(-1);
  if (last) {
    const sc = r[5] / last[4], H = b.filter((x) => x[0] < 1520).map(([t, a, h, l, c]) => [t, a * sc, h * sc, l * sc, c * sc]);
    for (const [n, x] of H.entries()) {
      if (side === 'buy') { const sp = o * (1 - stop); if (x[3] <= sp) return (n ? Math.min(sp, x[1]) : sp) / o - 1 - COST; if (tgt && x[2] >= o * (1 + tgt)) return tgt - COST; }
      else { const sp = o * (1 + stop); if (x[2] >= sp) return -((n ? Math.max(sp, x[1]) : sp) / o - 1) - COST; if (tgt && x[3] <= o * (1 - tgt)) return tgt - COST; }
    }
    return (side === 'buy' ? H.at(-1)[4] / o - 1 : -(H.at(-1)[4] / o - 1)) - COST;
  }
  if (side === 'buy') return (r[4] <= o * (1 - stop) ? -stop : tgt && r[3] >= o * (1 + tgt) ? tgt : r[5] / o - 1) - COST;
  return (r[3] >= o * (1 + stop) ? -stop : tgt && r[4] <= o * (1 - tgt) ? tgt : -(r[5] / o - 1)) - COST;
}

const days = [];
for (let i = START; i < mk.days.length; i++) {
  const d = mk.days[i]; if (mGap[i] == null) continue;
  const ser = series.get(i);
  const main = [], bOld = [], bNew = [], shorts = [];
  for (const [s, k] of byDay[i]) {
    if (k < 25 || ETFS.has(s) || NOT_STOCK.test(s)) continue;
    const R = mk.stocks[s], r = R[k], y = R[k - 1];
    if (y[0] !== i - 1 || !(r[1] > 0) || !(y[1] > 0) || r[1] < 5) continue;
    const sr = ser?.get(s); if (sr === 'BE') continue; // T2T: never (series unknown when the file is missing)
    const cr = median(R.slice(k - 20, k).map((x) => x[6] ?? 0)); if (!(cr >= 1)) continue;
    const gap = r[2] / r[1] - 1, yRet = y[5] / y[1] - 1, res = resultsOn[i].has(s);
    const c = { s, r, cr, d };
    if (mGap[i] <= -0.012 && gap <= -0.03 && gap > -0.0495 && cr >= 20 && !res) main.push({ ...c, kind: 'Panic', side: 'buy', stop: 0.03, tgt: null });
    if (res && gap >= 0.05 && gap < 0.2 && cr >= 5) {
      const q = funda[s]?.q, T = targetQuarter(d), pat = (x) => q?.[x]?.pat;
      if (q && pat(T) != null && pat(T - 1) > 0 && pat(T - 4) != null) {
        const qoq = pat(T) / pat(T - 1) - 1, yoy = pat(T - 4) > 0 ? pat(T) / pat(T - 4) - 1 : (pat(T) > pat(T - 4) ? 1 : -1);
        if (qoq > 0 && yoy > 0) {
          const p14 = R.slice(k - 14, k), atr = mean(p14.map((x, j) => { const pc = j ? p14[j - 1][5] : x[1]; return Math.max(x[3], pc) - Math.min(x[4], pc); })) / y[5];
          main.push({ ...c, kind: 'Gap & Go', side: 'buy', stop: Math.min(0.08, Math.max(0.02, 1.25 * atr)), tgt: Math.min(0.15, Math.max(0.04, 2 * atr)) });
        }
      }
    }
    if (!res && yRet <= -0.03 && gap <= -0.02 && gap > -0.0495) {
      const b = { ...c, kind: 'Bounce-back', side: 'buy', stop: 0.03, tgt: 0.07 };
      bOld.push(b);
      let big5 = 0; for (let j = k - 6; j < k - 1; j++) if (R[j][5] / R[j][1] - 1 <= -0.045) big5++;
      if (yRet > -0.08 && big5 >= 1) bNew.push(b);
    }
    const lc = (x) => x[3] > x[4] && x[5] === x[4] && x[5] / x[1] - 1 <= -0.045;
    if (sr === 'EQ' && lc(y) && !lc(R[k - 2]) && gap - mGap[i] > 0.01 && mGap[i] >= 0) shorts.push({ ...c, kind: 'Short', side: 'short', stop: 0.02, tgt: 0.05 });
  }
  const top = (l) => l.sort((a, b) => b.cr - a.cr).slice(0, 3);
  const run = (l) => l.map((t) => ({ ...t, ret: exit(t.s, t.d, t.r, t.side, t.stop, t.tgt) }));
  const m = run(top(main));
  const oldT = m.length ? m : run(top(bOld));
  const newBuys = m.length ? m : run(top(bNew));
  days.push({ d, old: oldT, neu: [...newBuys, ...run(top(shorts))] });
}

const PER = [['2024 Apr-Jun', '2024-04', '2024-07'], ['2024 Jul-Dec', '2024-07', '2025-01'], ['2025 Jan-Jun', '2025-01', '2025-07'], ['2025 Jul-Dec', '2025-07', '2026-01'], ['2026 Jan-Jun', '2026-01', '2026-07'], ['2026 Jul-Nov', '2026-07', '2027-01']];
const months = days.length / 21;
function report(label, key) {
  const td = days.filter((x) => x[key].length), trades = td.flatMap((x) => x[key]);
  const dayRet = td.map((x) => mean(x[key].map((t) => t.ret)));
  let eq = 1, pk = 1, dd = 0; for (const v of dayRet) { eq *= 1 + v; pk = Math.max(pk, eq); dd = Math.min(dd, eq / pk - 1); }
  const last6 = td.filter((x) => x.d >= '2026-05-20');
  P(`\n${label}`);
  P(`  ${trades.length} trades on ${td.length} of ${days.length} days (${(td.length / months).toFixed(1)} trade days a month) | avg per trade ${pct(mean(trades.map((t) => t.ret)))} | won ${pct(trades.filter((t) => t.ret > 0).length / trades.length, 0)}`);
  P(`  avg per trade-day ${pct(mean(dayRet))} | green days ${pct(dayRet.filter((v) => v > 0).length / dayRet.length, 0)} | money x${eq.toFixed(2)} over the whole period (all-in each trade day, before tax) | worst drop ${pct(dd, 0)}`);
  P(`  by period (avg per trade-day): ${PER.map(([l, a, b]) => { const x = td.filter((y) => y.d >= a && y.d < b).map((y) => mean(y[key].map((t) => t.ret))); return `${l} ${pct(mean(x), 1)} (${x.length}d)`; }).join(' | ')}`);
  P(`  last 6 months: ${last6.length} trade days, avg per trade-day ${pct(mean(last6.map((x) => mean(x[key].map((t) => t.ret)))))}`);
  P(`  by strategy: ${[...new Set(trades.map((t) => t.kind))].map((k) => { const a = trades.filter((t) => t.kind === k); return `${k} ${a.length} tr ${pct(mean(a.map((t) => t.ret)))} won ${pct(a.filter((t) => t.ret > 0).length / a.length, 0)}`; }).join(' | ')}`);
  return { td: td.length, avg: mean(dayRet), eq };
}
P(`Days ${days[0].d} .. ${days.at(-1).d} (${days.length} market days, ~${months.toFixed(0)} months). Bhavcopy series found for ${series.size} days.`);
const o = report('OLD SYSTEM (live until now: main picks, else Bounce-back at -2% limit)', 'old');
const n = report('NEW SYSTEM (main picks, else NEW Bounce-back rule; plus SHORTS)', 'neu');
P(`\nVERDICT: avg per trade-day ${pct(o.avg)} -> ${pct(n.avg)}, trade days ${o.td} -> ${n.td}, money x${o.eq.toFixed(2)} -> x${n.eq.toFixed(2)}`);
