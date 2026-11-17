// Step 22: the user wants a researched strategy for the ~3 days in 4 when TODAY'S BUY has no pick (no guessing).
// Same data and exits as step 21. On days with NO main pick, test several "opens down, bounces back" rules
// (lead from research/4-study and 5-movers: stocks opening 2%+ down were profitable in every period).
// Exits: target +7% / stop -3% (stop counted first if both touched) / else the close. Costs 0.4%.
//   node research/22-fallback.mjs
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
  days.push({ d, i, m, results, marketGap, n: picks.length, day: res.length ? mean(res.map((x) => x.ret)) : null, picks: res });
}
// ---------------- fallback rules, only on days with no main pick ----------------
const prevRet = (i, s) => { const r = byDay[i - 1]?.get(s); return r ? r[5] / r[1] - 1 : null; };
const RULES = {
  'A opens -2..-5%, Rs 20cr+': (i, s, r, g) => g <= -0.02 && g > -0.0495 && liq(i, s) >= 20,
  'B opens -3..-5%, Rs 20cr+': (i, s, r, g) => g <= -0.03 && g > -0.0495 && liq(i, s) >= 20,
  'C fell 3%+ yday, opens -3..-5%, Rs 5cr+': (i, s, r, g) => g <= -0.03 && g > -0.0495 && liq(i, s) >= 5 && prevRet(i, s) <= -0.03,
  'D fell 3%+ yday, opens -2..-5%, Rs 20cr+': (i, s, r, g) => g <= -0.02 && g > -0.0495 && liq(i, s) >= 20 && prevRet(i, s) <= -0.03,
  'E opens -2..-5%, Rs 50cr+': (i, s, r, g) => g <= -0.02 && g > -0.0495 && liq(i, s) >= 50,
};
const out2 = [];
const Q = (...a) => { const l = a.join(' '); console.log(l); out2.push(l); };
const PER = [['2025 H1', (d) => d < '2025-07'], ['2025 H2', (d) => d >= '2025-07' && d < '2026'], ['2026 H1', (d) => d >= '2026' && d < '2026-07'], ['2026 Jul-Nov', (d) => d >= '2026-07'], ['last 6 months', (d) => d >= '2026-05-17']];
Q(`FALLBACK on days with NO main pick (${days.filter((x) => !x.n).length} days). Top 3 most traded each day, target +7% / stop -3% / else close, after costs.`);
for (const [name, f] of Object.entries(RULES)) {
  for (const [stop, target] of [[0.03, 0.07], [0.02, 0.04], [1, null]]) {
    const per = [];
    for (const x of days.filter((x) => !x.n)) {
      const c = [...x.m].filter(([s, r]) => r[1] > 0 && !x.results.has(s) && f(x.i, s, r, r[2] / r[1] - 1)).sort((a, b) => liq(x.i, b[0]) - liq(x.i, a[0])).slice(0, 3);
      if (!c.length) continue;
      const rets = c.map(([, r]) => { const [, , o, h, l, cl] = r; return (l <= o * (1 - stop) ? -stop : target && h >= o * (1 + target) ? target : cl / o - 1) - COST; });
      per.push({ d: x.d, v: mean(rets), n: rets.length, won: rets.filter((y) => y > 0).length });
    }
    const cells = PER.map(([lab, pf]) => { const p = per.filter((x) => pf(x.d)); let eq = 1; for (const x of p) eq *= 1 + x.v; return `${lab}: ${pct(mean(p.map((x) => x.v)), 2)}/day (${pct(eq - 1, 0)})`; });
    let eq = 1, peak = 1, dd = 0; for (const x of per) { eq *= 1 + x.v; peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1); }
    const tr = per.reduce((s, x) => s + x.n, 0), won = per.reduce((s, x) => s + x.won, 0);
    Q(`${name.padEnd(40)} ${stop === 1 ? 'hold to close    ' : `stop ${stop * 100}% tgt ${target * 100}%`.padEnd(17)} | ${per.length} days (${pct(per.length / days.filter((x) => !x.n).length, 0)}), ${tr} trades, won ${pct(won / tr, 0)}, avg/day ${pct(mean(per.map((x) => x.v)), 2)}, total ${pct(eq - 1, 0)}, worst dip ${pct(dd, 0)}`);
    Q(`${''.padEnd(58)}${cells.join(' | ')}`);
  }
}
fs.writeFileSync(new URL('fallback-report.txt', R), out2.join(String.fromCharCode(10)));
process.exit(0);

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
