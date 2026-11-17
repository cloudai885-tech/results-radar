// Step 21: replay the exact TODAY'S BUY rule (best-pick.mjs) on every trading day since Jan 2025, on real prices.
// Daily candles only, so: the opening price stands in for the pre-open price; exits are judged on the day's
// high/low with the STOP counted first when both stop and target were touched (the cautious choice).
//   Panic rebound HIGH: market median opening -1.2% or worse; stock Rs 20 cr+/day, opening -3..-5%, no result overnight.
//                       Stop -3%, else sell at the close.
//   Gap & Go:           result filed after yesterday's close, profit beat last quarter AND last year; opening +5..+20%;
//                       Rs 5 cr+/day. Target +7%, stop -3%, else the close.
//   Strong news:        Claude-graded strong news (only Oct 21 - Nov 16 2026 has grades); opening +5..+15%.
//                       Daily candles cannot show the 1.5% trail, so: stop -2%, else the close (rough).
// Rule: very strong (panic, Gap & Go) first, up to 3; strong news only on days with no very strong pick. Costs 0.4%.
//   node research/21-todays-buy-replay.mjs
import fs from 'node:fs';
import { targetQuarter } from '../src/score.mjs';

const R = new URL('../data/research/', import.meta.url);
const read = (f) => JSON.parse(fs.readFileSync(new URL(f, R), 'utf8'));
const mk = read('market.json');
const events = read('events-results.json');
const funda = read('fundamentals.json');
const COST = 0.004;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (v, d = 1) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : '-');

// day index -> symbol -> row [i, prev, o, h, l, c, cr]
const byDay = mk.days.map(() => new Map());
const liqAt = new Map(); // `${i}|${s}` -> median turnover of the 20 sessions before
for (const [s, rows] of Object.entries(mk.stocks)) {
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k];
    byDay[r[0]].set(s, r);
    if (k >= 10) liqAt.set(`${r[0]}|${s}`, median(rows.slice(Math.max(0, k - 20), k).map((x) => x[6])));
  }
}
const liq = (i, s) => liqAt.get(`${i}|${s}`) ?? 0;

// results filed after the previous session's close (15:30) and before 9:00 on day i
const resultsOn = mk.days.map(() => []);
for (const e of events) {
  const [d, t = '00:00'] = e.time.split(' ');
  let i = mk.days.findIndex((x) => x > d || (x === d && t < '09:00'));
  if (i < 0) continue;
  if (mk.days[i] === d && t >= '09:00') continue;
  // must be after the previous session's close
  const prevDay = mk.days[i - 1];
  if (prevDay && (d < prevDay || (d === prevDay && t < '15:30'))) continue;
  resultsOn[i].push(e.symbol);
}
// strong news grades (blind, step 16)
const G = new URL('grades/', R);
const newsStrong = new Set();
try {
  const map = new Map(fs.readFileSync(new URL('all-map.txt', G), 'utf8').trim().split('\n').map((l) => { const [id, d, s] = l.split('|'); return [id, `${d}|${s}`]; }));
  for (const f of fs.readdirSync(G).filter((f) => /^g\d+\.txt$/.test(f))) for (const t of fs.readFileSync(new URL(f, G), 'utf8').split(/\s+/)) { const [id, g] = t.split(':'); if (g === '2' && map.has(id)) newsStrong.add(map.get(id)); }
} catch { /* no grades */ }

const trades = [];
const days = [];
for (let i = 1; i < mk.days.length; i++) {
  const d = mk.days[i];
  if (d < '2025-01-01') continue;
  const m = byDay[i];
  const gapOf = (r) => r[2] / r[1] - 1;
  const gaps = [...m].filter(([s, r]) => liq(i, s) >= 2 && r[1] > 0).map(([, r]) => gapOf(r));
  if (gaps.length < 200) continue;
  const marketGap = median(gaps);
  const cands = [];
  const results = new Set(resultsOn[i]);
  if (marketGap <= -0.012) for (const [s, r] of m) {
    const g = gapOf(r);
    if (g > -0.03 || g <= -0.0495 || liq(i, s) < 20 || results.has(s)) continue;
    cands.push({ s, kind: 'Panic rebound', score: 95 + Math.min(4, liq(i, s) / 500), r, stop: 0.03, target: null });
  }
  for (const s of results) {
    const r = m.get(s), q = funda[s]?.q;
    if (!r || !q) continue;
    const T = targetQuarter(d), pat = (o) => q[o]?.pat;
    if (!(pat(T) != null && pat(T - 1) > 0 && pat(T - 4) != null)) continue;
    const qoq = pat(T) / pat(T - 1) - 1, yoy = pat(T - 4) > 0 ? pat(T) / pat(T - 4) - 1 : (pat(T) > pat(T - 4) ? 1 : -1);
    const g = gapOf(r);
    if (qoq <= 0 || yoy <= 0 || g < 0.05 || g >= 0.2 || liq(i, s) < 5) continue;
    cands.push({ s, kind: 'Gap & Go', score: 85 + Math.min(5, Math.min(qoq, yoy) * 5), r, stop: 0.03, target: 0.07 });
  }
  for (const [s, r] of m) {
    if (!newsStrong.has(`${d}|${s}`)) continue;
    const g = gapOf(r);
    if (g < 0.05 || g > 0.15 || liq(i, s) < 5) continue;
    cands.push({ s, kind: 'Strong news', score: 72 + Math.min(3, liq(i, s) / 100), r, stop: 0.02, target: null });
  }
  const seen = new Set();
  const ranked = cands.sort((a, b) => b.score - a.score).filter((c) => !seen.has(c.s) && seen.add(c.s));
  const vs = ranked.some((c) => c.score >= 85);
  const picks = ranked.filter((c) => !vs || c.score >= 85).slice(0, 3);
  const res = picks.map((c) => {
    const [, , o, h, l, cl] = c.r;
    const ret = l <= o * (1 - c.stop) ? -c.stop : c.target && h >= o * (1 + c.target) ? c.target : cl / o - 1;
    const t = { d, s: c.s, kind: c.kind, ret: ret - COST };
    trades.push(t);
    return t;
  });
  days.push({ d, marketGap, n: picks.length, day: res.length ? mean(res.map((x) => x.ret)) : null, picks: res });
}

const out = [];
const P = (...a) => { const l = a.join(' '); console.log(l); out.push(l); };
const summary = (label, ds) => {
  const tr = ds.flatMap((x) => x.picks), traded = ds.filter((x) => x.n);
  let eq = 1, peak = 1, dd = 0;
  for (const x of traded) { eq *= 1 + x.day; peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1); }
  P(`${label.padEnd(26)} ${String(ds.length).padStart(3)} days | traded ${String(traded.length).padStart(3)} days (${pct(traded.length / ds.length, 0)}) | ${String(tr.length).padStart(3)} trades, won ${pct(tr.filter((t) => t.ret > 0).length / tr.length, 0)}, avg ${pct(mean(tr.map((t) => t.ret)), 2)}/trade | money (equal split each day) ${pct(eq - 1)} | worst dip ${pct(dd)} | green days ${traded.filter((x) => x.day > 0).length}/${traded.length}`);
};
P(`TODAY'S BUY replay on real daily prices, ${days[0].d} .. ${days.at(-1).d}. After ${pct(COST)} costs per trade.\n`);
summary('ALL', days);
summary('2025 Jan-Jun', days.filter((x) => x.d < '2025-07'));
summary('2025 Jul-Dec', days.filter((x) => x.d >= '2025-07' && x.d < '2026'));
summary('2026 Jan-Jun', days.filter((x) => x.d >= '2026' && x.d < '2026-07'));
summary('2026 Jul-Nov', days.filter((x) => x.d >= '2026-07'));
summary('last 6 months', days.filter((x) => x.d >= '2026-05-17'));
P('\nBy strategy:');
for (const k of ['Panic rebound', 'Gap & Go', 'Strong news']) { const t = trades.filter((x) => x.kind === k); if (t.length) P(`  ${k.padEnd(14)} ${String(t.length).padStart(3)} trades, won ${pct(t.filter((x) => x.ret > 0).length / t.length, 0)}, avg ${pct(mean(t.map((x) => x.ret)), 2)}`); }
for (const [lab, f] of [['2025 H1', (d) => d < '2025-07'], ['2025 H2', (d) => d >= '2025-07' && d < '2026'], ['2026 H1', (d) => d >= '2026' && d < '2026-07'], ['2026 Jul-Nov', (d) => d >= '2026-07']])
  P(`  ${lab.padEnd(13)}` + ['Panic rebound', 'Gap & Go'].map((k) => { const t = trades.filter((x) => x.kind === k && f(x.d)); return `${k} ${String(t.length).padStart(3)} trades avg ${pct(mean(t.map((x) => x.ret)), 2).padStart(7)}`; }).join(' | '));
P('\nHow many picks a day:', [0, 1, 2, 3].map((n) => `${n}: ${days.filter((x) => x.n === n).length} days`).join(', '));
P('\nLast 25 trading days with a pick:');
for (const x of days.filter((x) => x.n).slice(-25)) P(`  ${x.d} market ${pct(x.marketGap).padStart(6)} | ${x.picks.map((t) => `${t.s} (${t.kind}) ${pct(t.ret)}`).join(', ')}`);
fs.writeFileSync(new URL('todays-buy-replay.txt', R), out.join('\n'));
