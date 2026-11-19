// Step 32: the user asked to test OUR strategies on 1/2/3/5/10/15/30-minute and 1-hour charts.
// Our entries are fixed (the official opening price, bought in pre-open), so the chart only changes the EXIT: whether the
// stop or the target was touched first during the day. Daily bars cannot tell, so earlier tests assumed the stop first.
// Same trades (research/28 EXPORT: main picks + Bounce-back at Rs 1 cr+, companies only) on every chart Yahoo keeps:
// 2/5/15/30-minute (~60 days), 1 hour (~2 years). 1-minute (7 days) is too short. If stop and target fall in the
// same bar, the stop counts first. Sell by 3:20 pm. Costs 0.4%.
//   node research/32-timeframes.mjs
import fs from 'node:fs';
import { fetchCached, mapPool } from '../src/sources.mjs';

const DIR = new URL('../data/research/', import.meta.url);
const picks = JSON.parse(fs.readFileSync(new URL('live-picks.json', DIR), 'utf8'));
const hourly = JSON.parse(fs.readFileSync(new URL('hourly.json', DIR), 'utf8'));
const COST = 0.004;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const pct = (v, d = 2) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : '   -  ');

function sim(p, bars) { // bars: [hhmm, o, h, l, c] of that day
  const px = p.open, stop = px * (1 - p.stop), tgt = p.target ? px * (1 + p.target) : null;
  const day = bars.filter((b) => b[0] < 1520);
  if (!day.length) return null;
  let same = 0;
  for (const b of day) {
    const hitS = b[3] <= stop, hitT = tgt != null && b[2] >= tgt;
    if (hitS && hitT) same = 1;
    if (hitS) return { r: Math.min(stop, b[1]) / px - 1 - COST, same };
    if (hitT) return { r: tgt / px - 1 - COST, same };
  }
  return { r: day.at(-1)[4] / px - 1 - COST, same };
}
const dailySim = (p) => { const px = p.open; const r = p.low <= px * (1 - p.stop) ? -p.stop : p.target && p.high >= px * (1 + p.target) ? p.target : p.close / px - 1; return { r: r - COST, same: p.low <= px * (1 - p.stop) && p.target && p.high >= px * (1 + p.target) ? 1 : 0 }; };

// ---- Yahoo bars for the last ~60 days ----
const recent = picks.filter((p) => p.d >= '2026-08-20');
const syms = [...new Set(recent.map((p) => p.s))];
const TF = ['2m', '5m', '15m', '30m'];
const bars = Object.fromEntries(TF.map((t) => [t, new Map()]));
for (const tf of TF) {
  await mapPool(syms, 4, async (s) => {
    const body = await fetchCached(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}.NS?range=60d&interval=${tf}`, { ttlHours: 24, attempts: 2 }).catch(() => null);
    const r = body ? JSON.parse(body).chart?.result?.[0] : null; if (!r?.timestamp) return;
    const q = r.indicators.quote[0], m = new Map();
    r.timestamp.forEach((t, i) => { if (q.open[i] == null || q.close[i] == null) return; const d = new Date((t + 19800) * 1000).toISOString(); const hm = Number(d.slice(11, 13) + d.slice(14, 16)); (m.get(d.slice(0, 10)) ?? m.set(d.slice(0, 10), []).get(d.slice(0, 10))).push([hm, q.open[i], q.high[i], q.low[i], q.close[i]]); });
    bars[tf].set(s, m);
  });
}
const P = (...a) => console.log(a.join(' '));
const report = (label, list, fns) => {
  // only trades every timeframe can simulate, so the comparison is like for like
  const rows = list.map((p) => ({ p, res: Object.fromEntries(Object.entries(fns).map(([k, f]) => [k, f(p)])) })).filter((x) => Object.values(x.res).every((v) => v));
  P(`\n${label}: ${rows.length} trades on ${new Set(rows.map((x) => x.p.d)).size} days (all charts available)`);
  for (const k of Object.keys(fns)) {
    const v = rows.map((x) => x.res[k].r), byDay = new Map();
    for (const x of rows) (byDay.get(x.p.d) ?? byDay.set(x.p.d, []).get(x.p.d)).push(x.res[k].r);
    const dv = [...byDay.values()].map(mean);
    P(`  ${k.padEnd(18)} avg per trade ${pct(mean(v))} | won ${pct(v.filter((x) => x > 0).length / v.length, 0)} | avg per trade-day ${pct(mean(dv))} | stop & target in the same bar: ${rows.filter((x) => x.res[k].same).length}`);
  }
  for (const kind of ['Bounce-back', 'Gap & Go', 'Panic rebound', 'Strong news']) {
    const sub = rows.filter((x) => x.p.kind === kind); if (!sub.length) continue;
    P(`    ${kind.padEnd(14)} ${String(sub.length).padStart(3)} trades: ${Object.keys(fns).map((k) => `${k} ${pct(mean(sub.map((x) => x.res[k].r)), 1)}`).join(' | ')}`);
  }
};
const fromYahoo = (tf) => (p) => { const b = bars[tf].get(p.s)?.get(p.d); const sb = b?.length ? scaled(p, b) : null; return sb ? sim(p, sb) : null; };
// Yahoo adjusts old prices for splits/bonuses/dividends, NSE's file does not: rescale the day's bars so the last close = NSE close
const scaled = (p, b) => { const last = b.filter((x) => x[0] < 1530).at(-1); if (!last) return null; const k = p.close / last[4]; return b.map(([t, o, h, l, c]) => [t, o * k, h * k, l * k, c * k]); };
const fromHourly = (p) => { const b = hourly[p.s]?.[p.d]; const sb = b?.length ? scaled(p, b) : null; return sb ? sim(p, sb) : null; };
report('LAST ~60 DAYS (Aug 20 - Nov 16 2026)', recent, { 'daily (old test)': dailySim, '1 hour': fromHourly, '30 min': fromYahoo('30m'), '15 min': fromYahoo('15m'), '5 min': fromYahoo('5m'), '2 min': fromYahoo('2m') });
report('2 YEARS (Jan 2025 - Nov 2026)', picks, { 'daily (old test)': dailySim, '1 hour': fromHourly });
