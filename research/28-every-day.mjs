// Step 28: the user wants a trade EVERY day, but safely. A daily ladder: TODAY'S BUY main picks (panic HIGH, Gap & Go,
// strong news) first; else Bounce-back (fell 3%+ yesterday, opens -3..-5%); else "Dip at open" (opens -2..-5%, no fall
// needed). Top 3 most traded each day, target +7% / stop -3% / else close (stop counted first). No T2T stocks.
// Safety: every result also with the buy filled 0.25% and 0.5% WORSE than the open (thin stocks rarely fill at the open).
// Size limits (median turnover of the last 20 sessions) are tried for each level.
//   node --max-old-space-size=8000 research/28-every-day.mjs
import fs from 'node:fs';
import { targetQuarter } from '../src/score.mjs';
import { fetchCached } from '../src/sources.mjs';

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
// T2T (series BE) in the previous day's bhavcopy = what the picker knows at 9 am
const beOn = mk.days.map(() => new Set());
for (let i = 1; i < mk.days.length; i++) {
  if (mk.days[i] < '2025-01-01') continue;
  const [y, m, d] = mk.days[i - 1].split('-');
  const csv = await fetchCached('https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_' + d + m + y + '.csv', { ttlHours: 1e7, attempts: 1 }).catch(() => null);
  if (csv?.startsWith('SYMBOL')) for (const line of csv.split(String.fromCharCode(10)).slice(1)) { const p = line.split(',').map((x) => x.trim()); if (p[1] === 'BE') beOn[i].add(p[0]); }
}

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
    if (g > -0.03 || g <= -0.0495 || liq(i, s) < 20 || results.has(s) || beOn[i].has(s)) continue;
    cands.push({ s, kind: 'Panic rebound', score: 95 + Math.min(4, liq(i, s) / 500), r, stop: 0.03, target: null });
  }
  for (const s of results) {
    const r = m.get(s), q = funda[s]?.q;
    if (!r || !q || beOn[i].has(s)) continue;
    const T = targetQuarter(d), pat = (o) => q[o]?.pat;
    if (!(pat(T) != null && pat(T - 1) > 0 && pat(T - 4) != null)) continue;
    const qoq = pat(T) / pat(T - 1) - 1, yoy = pat(T - 4) > 0 ? pat(T) / pat(T - 4) - 1 : (pat(T) > pat(T - 4) ? 1 : -1);
    const g = gapOf(r);
    if (qoq <= 0 || yoy <= 0 || g < 0.05 || g >= 0.2 || liq(i, s) < 5) continue;
    cands.push({ s, kind: 'Gap & Go', score: 85 + Math.min(5, Math.min(qoq, yoy) * 5), r, stop: 0.03, target: 0.07 });
  }
  for (const [s, r] of m) {
    if (!newsStrong.has(`${d}|${s}`) || beOn[i].has(s)) continue;
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
// ---------------- the ladder ----------------
// TIERS=1: the bounce-back trades by stock size, with worse fills and the lower-circuit trap (user asked: why not Rs 1 cr?)
if (process.env.TIERS) {
  const etf = /ETF|BEES$|IETF$|^LIQUID|^GILT|^MON100|^MAFANG|^HNGSNG|^NIFTY|^SENSEX|^(GOLD|SILVER)(CASE|SHARE|1|ADD|IETF)$|MOMENTUM|^MID150|^MOM(30|50|100)/;
  const prevR = (i, s) => { const r = byDay[i - 1]?.get(s); return r ? r[5] / r[1] - 1 : null; };
  const T = [['Rs 1-2 cr', 1, 2], ['Rs 2-5 cr', 2, 5], ['Rs 5 cr+', 5, 1e9]];
  const tr = [];
  for (const x of days) {
    if (x.n) continue;
    const c = [...x.m].filter(([s, r]) => !etf.test(s) && r[1] > 0 && !x.results.has(s) && !beOn[x.i].has(s) && liq(x.i, s) >= 1 && r[2] / r[1] - 1 <= -0.03 && r[2] / r[1] - 1 > -0.0495 && prevR(x.i, s) <= -0.03)
      .sort((a, b) => liq(x.i, b[0]) - liq(x.i, a[0])).slice(0, 3);
    for (const [s, r] of c) { const [, prev, o, h, l, cl] = r; tr.push({ d: x.d, s, cr: liq(x.i, s), o, h, l, cl, prev, lowCirc: l <= prev * 0.9505 }); }
  }
  // stuck at the lower circuit: the stop cannot fill above the circuit price, so the loss is at least down to it
  const ret = (t, slip) => { const px = t.o * (1 + slip); return (t.l <= px * 0.97 ? (t.lowCirc ? Math.min(-0.03, (t.prev * 0.95) / px - 1) : -0.03) : t.h >= px * 1.07 ? 0.07 : t.cl / px - 1) - COST; };
  const { priceBands } = await import('../src/sources.mjs'); const bands = await priceBands(); const bandOf = (s) => (bands.has(s) ? bands.get(s) : undefined);
  for (const [lab, f] of [['band 5% or less (circuit trap)', (t) => bandOf(t.s) != null && bandOf(t.s) <= 0.05], ['band 10-20% or F&O (no trap)', (t) => bandOf(t.s) === null || bandOf(t.s) > 0.05]]) for (const [tl, lo, hi] of T) { const a = tr.filter((t) => f(t) && t.cr >= lo && t.cr < hi); if (!a.length) continue; console.log(`  ${lab.padEnd(30)} ${tl.padEnd(10)} ${String(a.length).padStart(4)} trades | at open ${pct(mean(a.map((t) => ret(t, 0))))}, 0.5% worse ${pct(mean(a.map((t) => ret(t, 0.005))))} | won ${pct(a.filter((t) => ret(t, 0) > 0).length / a.length, 0)} | locked at -5% from yesterday ${pct(a.filter((t) => t.lowCirc).length / a.length, 0)}`); }
  for (const [lab, minCr, noTrap] of [['NOW: Rs 5 cr+, any band', 5, false], ['Rs 5 cr+, skip 5% band', 5, true], ['Rs 1 cr+, any band', 1, false], ['Rs 1 cr+, skip 5% band', 1, true]]) { const byD = new Map(); for (const t of tr) { if (t.cr < minCr || (noTrap && bandOf(t.s) != null && bandOf(t.s) <= 0.05)) continue; (byD.get(t.d) ?? byD.set(t.d, []).get(t.d)).push(t); } const dv = [...byD].map(([d, l]) => ({ d, v: mean(l.slice(0, 3).map((t) => ret(t, 0))), v5: mean(l.slice(0, 3).map((t) => ret(t, 0.005))) })); const mainDays = days.filter((x) => x.n); const all = days.length, last = days.filter((x) => x.d >= '2026-05-17'); const tradeDays = (f) => mainDays.filter(f).length + dv.filter((x) => f({ d: x.d })).length; console.log(`  ${lab.padEnd(26)} bounce days ${dv.length}, avg/day ${pct(mean(dv.map((x) => x.v)))} (0.5% worse ${pct(mean(dv.map((x) => x.v5)))}) | days with ANY trade: ${tradeDays(() => true)}/${all}, last 6 months ${tradeDays((x) => x.d >= '2026-05-17')}/${last.length}`); }
  { const b5 = tr.filter((t) => t.cr >= 1 && bandOf(t.s) != null && bandOf(t.s) <= 0.05); const stuck = b5.filter((t) => t.cl <= t.prev * 0.9505); console.log(`  5%-band picks: ${b5.length}; CLOSED the day locked at the lower circuit (cannot sell, carried overnight): ${stuck.length} = ${pct(stuck.length / b5.length, 0)}; per month about ${(stuck.length / 22).toFixed(1)}`); }
  for (const [lab, lo, hi] of T) {
    const a = tr.filter((t) => t.cr >= lo && t.cr < hi), rc = a.filter((t) => t.d >= '2026-05-17');
    console.log(`${lab.padEnd(10)} ${String(a.length).padStart(4)} trades (last 6m ${rc.length}) | per trade: fill at open ${pct(mean(a.map((t) => ret(t, 0))))}, 0.25% worse ${pct(mean(a.map((t) => ret(t, 0.0025))))}, 0.5% worse ${pct(mean(a.map((t) => ret(t, 0.005))))}, 1% worse ${pct(mean(a.map((t) => ret(t, 0.01))))} | last 6m at open ${pct(mean(rc.map((t) => ret(t, 0))))} | won ${pct(a.filter((t) => ret(t, 0) > 0).length / a.length, 0)} | hit the -5% lower circuit later ${pct(a.filter((t) => t.lowCirc).length / a.length, 0)}`);
  }
  process.exit(0);
}
if (process.env.TIERS) {
  const etf = /ETF|BEES$|IETF$|^LIQUID|^GILT|^MON100|^MAFANG|^HNGSNG|^NIFTY|^SENSEX|^(GOLD|SILVER)(CASE|SHARE|1|ADD|IETF)$|MOMENTUM|^MID150|^MOM(30|50|100)/;
  const prevR = (i, s) => { const r = byDay[i - 1]?.get(s); return r ? r[5] / r[1] - 1 : null; };
  const T = [['Rs 1-2 cr', 1, 2], ['Rs 2-5 cr', 2, 5], ['Rs 5 cr+', 5, 1e9]];
  const tr = [];
  for (const x of days) { if (x.n) continue;
    const c = [...x.m].filter(([s, r]) => !etf.test(s) && r[1] > 0 && !x.results.has(s) && !beOn[x.i].has(s) && liq(x.i, s) >= 1 && r[2] / r[1] - 1 <= -0.03 && r[2] / r[1] - 1 > -0.0495 && prevR(x.i, s) <= -0.03).sort((a, b) => liq(x.i, b[0]) - liq(x.i, a[0])).slice(0, 3);
    for (const [s, r] of c) { const [, prev, o, h, l, cl] = r; tr.push({ d: x.d, s, cr: liq(x.i, s), o, h, l, cl, prev, lowCirc: l <= prev * 0.9505 }); } }
  const ret = (t, slip) => { const px = t.o * (1 + slip); return (t.l <= px * 0.97 ? (t.lowCirc ? Math.min(-0.03, t.prev * 0.95 / px - 1) : -0.03) : t.h >= px * 1.07 ? 0.07 : t.cl / px - 1) - COST; };
  for (const [lab, lo, hi] of T) { const a = tr.filter((t) => t.cr >= lo && t.cr < hi); const rc = a.filter((t) => t.d >= '2026-05-17');
    console.log(); }
  process.exit(0);
}
if (process.env.MAINETF) { const re = /ETF|BEES|IETF|ADD$|^LIQUID|^GILT|^MON100|^MAFANG|^HNGSNG|^NIFTY|^SENSEX|^GOLD|^SILVER|CASE$|^MOM|^MID150/; const all = days.flatMap((x) => x.picks); const e = all.filter((t) => re.test(t.s)); console.log(`main picks: ${all.length}, ETFs among them: ${e.length}`, e.map((t) => `${t.d} ${t.s} ${t.kind} ${pct(t.ret)}`).join(", ")); const ok = all.filter((t) => !re.test(t.s)); for (const k of ["Panic rebound", "Gap & Go", "Strong news"]) { const a = all.filter((t) => t.kind === k), b = ok.filter((t) => t.kind === k); console.log(`  ${k}: with ETFs ${a.length} avg ${pct(mean(a.map((t) => t.ret)))} | companies only ${b.length} avg ${pct(mean(b.map((t) => t.ret)))}`); } process.exit(0); }
const prevRet = (i, s) => { const r = byDay[i - 1]?.get(s); return r ? r[5] / r[1] - 1 : null; };
const exitRet = (r, slip) => { const [, , o, h, l, cl] = r; const px = o * (1 + slip); return (l <= px * 0.97 ? -0.03 : h >= px * 1.07 ? 0.07 : cl / px - 1) - COST; };
const LEVELS = {
  bounce: (i, s, g) => g <= -0.03 && g > -0.0495 && prevRet(i, s) <= -0.03,
  dip: (i, s, g) => g <= -0.02 && g > -0.0495,
};
const NOT_STOCK = /ETF|BEES|IETF|ADD$|^LIQUID|^GILT|^MON100|^MAFANG|^HNGSNG|^NIFTY|^SENSEX|^GOLD|^SILVER|CASE$|^MOM|^MID150|^AXIS.*ETF|^ICICI.*ETF/;
const { etfList: _etfList } = await import('../src/sources.mjs'); const ETFS = await _etfList();
const pick = (x, f, minCr) => [...x.m].filter(([s, r]) => !(process.env.ETF ? false : (NOT_STOCK.test(s) || ETFS.has(s))) && r[1] > 0 && !x.results.has(s) && !beOn[x.i].has(s) && liq(x.i, s) >= minCr && f(x.i, s, r[2] / r[1] - 1)).sort((a, b) => liq(x.i, b[0]) - liq(x.i, a[0])).slice(0, 3);
const PER = [['25H1', (d) => d < '2025-07'], ['25H2', (d) => d >= '2025-07' && d < '2026'], ['26H1', (d) => d >= '2026' && d < '2026-07'], ['26H2', (d) => d >= '2026-07']];
const RECENT = '2026-05-17';
const out = [];
const P = (...a) => { const l = a.join(' '); console.log(l); out.push(l); };
P(`${days.length} trading days ${days[0].d}..${days.at(-1).d}. Costs ${COST * 100}% a trade. "slip" = bought that much worse than the open.`);
for (const [bCr, dCr] of (process.env.LADDER ? JSON.parse(process.env.LADDER) : [[5, 20], [1, 20], [1, 5], [0.5, 5], [0.5, 1], [1, 1]])) {
  for (const slip of [0, 0.0025, 0.005]) {
    const per = [];
    for (const x of days) {
      let level = null, rets = [];
      if (x.n) { level = 'main'; rets = x.picks.map((t) => t.ret - slip); }
      else { const b = pick(x, LEVELS.bounce, bCr); if (b.length) { level = 'bounce'; rets = b.map(([, r]) => exitRet(r, slip)); } else { const dd = pick(x, LEVELS.dip, dCr); if (dd.length) { level = 'dip'; rets = dd.map(([, r]) => exitRet(r, slip)); } } }
      per.push({ d: x.d, level, v: rets.length ? mean(rets) : null });
    }
    const traded = per.filter((p) => p.v != null);
    let eq = 1, pk = 1, dd = 0; for (const p of traded) { eq *= 1 + p.v; pk = Math.max(pk, eq); dd = Math.min(dd, eq / pk - 1); }
    const lv = (k) => { const l = traded.filter((p) => p.level === k); return `${k} ${l.length}d ${pct(mean(l.map((p) => p.v)))}`; };
    const rc = per.filter((p) => p.d >= RECENT);
    P(`bounce Rs ${bCr}cr+, dip Rs ${dCr}cr+, slip ${(slip * 100).toFixed(2)}% | days traded ${traded.length}/${per.length} (last 6m ${rc.filter((p) => p.v != null).length}/${rc.length}) | avg/day ${pct(mean(traded.map((p) => p.v)))} | green days ${pct(traded.filter((p) => p.v > 0).length / traded.length, 0)} | worst drop ${pct(dd, 0)} | ${lv('main')} | ${lv('bounce')} | ${lv('dip')} | ${PER.map(([l, f]) => `${l} ${pct(mean(traded.filter((p) => f(p.d)).map((p) => p.v)))}`).join(' ')} | last 6m ${pct(mean(rc.filter((p) => p.v != null).map((p) => p.v)))}`);
  }
}
// PRINTFROM=YYYY-MM-DD: day-by-day list with the CURRENT live rules (main picks, else Bounce-back at Rs 1 cr+)
if (process.env.PRINTFROM) {
  for (const x of days.filter((x) => x.d >= process.env.PRINTFROM)) {
    if (x.n) { console.log(`  ${x.d}  MAIN     ${x.picks.map((t) => `${t.s} (${t.kind}) ${pct(t.ret)}`).join(', ')} | day ${pct(x.day)}`); continue; }
    const b = pick(x, LEVELS.bounce, 1);
    if (!b.length) { console.log(`  ${x.d}  no trade (market opened ${pct(x.marketGap)})`); continue; }
    const rets = b.map(([, r]) => exitRet(r, 0));
    console.log(`  ${x.d}  BOUNCE   ${b.map(([s2, r], k) => `${s2} opened ${pct(r[2] / r[1] - 1)} -> ${pct(rets[k])}`).join(', ')} | day ${pct(mean(rets))}`);
  }
  process.exit(0);
}
// GRID=1 (step 29): variations of the only clue that has worked ("fell, opens down again, bounces"), judged ONLY on days
// when the live system has nothing (no main pick and no Bounce-back at Rs 1 cr+). Chosen on TRAIN (2025-01..2025-10),
// checked on TEST (2025-11..2026-11). Companies only (no ETF / T2T / results that day), Rs 1 cr+, top 3 most traded.
if (process.env.GRID) {
  const etf = /ETF|BEES$|IETF$|^LIQUID|^GILT|^MON100|^MAFANG|^HNGSNG|^NIFTY|^SENSEX|^(GOLD|SILVER)(CASE|SHARE|1|ADD|IETF)$|MOMENTUM|^MID150|^MOM(30|50|100)/;
  const back = (i, s, n) => { const a = byDay[i - 1]?.get(s), b = byDay[i - n]?.get(s); return a && b ? a[5] / b[1] - 1 : null; };
  const empty = days.filter((x) => !x.n && !pick(x, LEVELS.bounce, 1).length);
  console.log(`Days with NO live trade: ${empty.length} of ${days.length} (TRAIN ${empty.filter((x) => x.d < '2025-11-01').length}, TEST ${empty.filter((x) => x.d >= '2025-11-01').length})`);
  const EX = { 't7s3': [0.07, 0.03], 't4s2': [0.04, 0.02], 'close s3': [null, 0.03] };
  const res = [];
  for (const [fl, fn] of [['yday <= -2%', (i, s) => back(i, s, 1) <= -0.02], ['yday <= -5%', (i, s) => back(i, s, 1) <= -0.05], ['2 days <= -5%', (i, s) => back(i, s, 2) <= -0.05], ['5 days <= -8%', (i, s) => back(i, s, 5) <= -0.08], ['5 days <= -12%', (i, s) => back(i, s, 5) <= -0.12], ['any (no fall)', () => true]])
    for (const [gl, g1, g2] of [['gap -1..-2%', -0.02, -0.01], ['gap -2..-3%', -0.03, -0.02], ['gap -3..-5%', -0.0495, -0.03], ['gap -1..-3%', -0.03, -0.01]])
      for (const [ek, [tg, st]] of Object.entries(EX)) for (const minCr of [1, 5, 20]) {
        const per = [];
        for (const x of empty) {
          const c = [...x.m].filter(([s, r]) => !etf.test(s) && r[1] > 0 && !x.results.has(s) && !beOn[x.i].has(s) && liq(x.i, s) >= minCr && r[2] / r[1] - 1 > g1 && r[2] / r[1] - 1 <= g2 && fn(x.i, s)).sort((a, b) => liq(x.i, b[0]) - liq(x.i, a[0])).slice(0, 3);
          if (!c.length) continue;
          const v = (slip) => mean(c.map(([, r]) => { const [, , o, h, l, cl] = r; const px = o * (1 + slip); return (l <= px * (1 - st) ? -st : tg && h >= px * (1 + tg) ? tg : cl / px - 1) - COST; }));
          per.push({ d: x.d, v: v(0), v25: v(0.0025) });
        }
        const tr = per.filter((p) => p.d < '2025-11-01'), te = per.filter((p) => p.d >= '2025-11-01');
        if (tr.length < 30) continue;
        res.push({ k: `${fl} + ${gl} | ${ek} | Rs ${minCr}cr+`, ntr: tr.length, tr: mean(tr.map((p) => p.v)), nte: te.length, te: mean(te.map((p) => p.v)), te25: mean(te.map((p) => p.v25)), rc: mean(te.filter((p) => p.d >= '2026-05-17').map((p) => p.v)), halves: [['25H1', '2025-01', '2025-07'], ['25H2', '2025-07', '2026'], ['26H1', '2026', '2026-07'], ['26H2', '2026-07', '2027']].map(([, a, b]) => mean(per.filter((p) => p.d >= a && p.d < b).map((p) => p.v))) });
      }
  res.sort((a, b) => b.tr - a.tr);
  console.log(`${res.length} variations. Top 25 by TRAIN (2025), then their TEST (last 12 months) - per day, after 0.4% costs:`);
  for (const r of res.slice(0, 25)) console.log(`  ${r.k.padEnd(58)} TRAIN ${String(r.ntr).padStart(3)}d ${pct(r.tr)} | TEST ${String(r.nte).padStart(3)}d ${pct(r.te)} (0.25% worse ${pct(r.te25)}) | last 6m ${pct(r.rc)} | half-years +${r.halves.filter((h) => h > 0).length}/4`);
  const good = res.filter((r) => r.tr > 0.002 && r.te > 0.002 && r.te25 > 0 && r.halves.every((h) => !(h < 0)));
  for (const r of res.filter((r) => /^(any \(no fall\)|yday <= -2%) \+ gap -2\.\.-3% \| t7s3 \| Rs 1cr\+/.test(r.k))) console.log(`  DETAIL ${r.k}: 25H1 ${pct(r.halves[0])}, 25H2 ${pct(r.halves[1])}, 26H1 ${pct(r.halves[2])}, 26H2 ${pct(r.halves[3])}`);
  console.log(`\nPassed ALL checks (TRAIN > +0.2%, TEST > +0.2%, still positive 0.25% worse, no negative half-year): ${good.length}`);
  for (const r of good.sort((a, b) => b.nte - a.nte)) console.log(`  ${r.k.padEnd(58)} TRAIN ${r.ntr}d ${pct(r.tr)} | TEST ${r.nte}d ${pct(r.te)} (0.25% worse ${pct(r.te25)}) | last 6m ${pct(r.rc)}`);
  process.exit(0);
}
// SMALLDIP=1: full result of the "Small dip" candidate (any company Rs 1 cr+ opening -2..-3%, top 3, +7%/-3%) on empty days
if (process.env.SMALLDIP) {
  const { etfList } = await import('../src/sources.mjs'); const E = await etfList();
  const etf0 = /ETF|BEES$|IETF$|^LIQUID|^GILT|^MON100|^MAFANG|^HNGSNG|^NIFTY|^SENSEX|^(GOLD|SILVER)(CASE|SHARE|1|ADD|IETF)$|MOMENTUM|^MID150|^MOM(30|50|100)/;
  const empty = days.filter((x) => !x.n && !pick(x, LEVELS.bounce, 1).length);
  const per = [];
  for (const x of empty) {
    const c = [...x.m].filter(([s, r]) => !E.has(s) && !etf0.test(s) && r[1] > 0 && !x.results.has(s) && !beOn[x.i].has(s) && liq(x.i, s) >= 1 && r[2] / r[1] - 1 > -0.03 && r[2] / r[1] - 1 <= -0.02).sort((a, b) => liq(x.i, b[0]) - liq(x.i, a[0])).slice(0, 3);
    if (!c.length) continue;
    const t = c.map(([s, r]) => { const [, , o, h, l, cl] = r; return { s, v: (l <= o * 0.97 ? -0.03 : h >= o * 1.07 ? 0.07 : cl / o - 1) - COST }; });
    per.push({ d: x.d, t, v: mean(t.map((z) => z.v)) });
  }
  for (const [lab, f] of [['ALL (Jan 2025 - Nov 2026)', () => true], ['2025', (d) => d < '2026'], ['2026', (d) => d >= '2026'], ['last 6 months', (d) => d >= '2026-05-17']]) {
    const p = per.filter((x) => f(x.d)), trades = p.flatMap((x) => x.t);
    let eq = 1, pk = 1, dd = 0, streak = 0, worstStreak = 0;
    for (const x of p) { eq *= 1 + x.v; pk = Math.max(pk, eq); dd = Math.min(dd, eq / pk - 1); streak = x.v < 0 ? streak + 1 : 0; worstStreak = Math.max(worstStreak, streak); }
    console.log(`${lab.padEnd(26)} ${String(p.length).padStart(3)} days, ${String(trades.length).padStart(3)} trades | trades won ${pct(trades.filter((z) => z.v > 0).length / trades.length, 0)}, green days ${pct(p.filter((x) => x.v > 0).length / p.length, 0)} | avg/day ${pct(mean(p.map((x) => x.v)))} | best day ${pct(Math.max(...p.map((x) => x.v)))}, worst day ${pct(Math.min(...p.map((x) => x.v)))} | money growth ${pct(eq - 1)} | worst drop ${pct(dd)} | longest losing run ${worstStreak} days`);
  }
  console.log('\nLast 12 days it would have traded:');
  for (const x of per.slice(-12)) console.log(`  ${x.d}  ${x.t.map((z) => `${z.s} ${pct(z.v)}`).join(', ')} | day ${pct(x.v)}`);
  process.exit(0);
}
// picks of the last ~55 days at the lowest limits, for the 5-minute fill check
const recentPicks = [];
for (const x of days.filter((x) => x.d >= '2026-08-25' && !x.n)) {
  const b = pick(x, LEVELS.bounce, 0.5), dd = b.length ? [] : pick(x, LEVELS.dip, 1);
  for (const [s, r] of [...b, ...dd]) recentPicks.push({ d: x.d, s, level: b.length ? 'bounce' : 'dip', open: r[2], cr: liq(x.i, s) });
}
fs.writeFileSync(new URL('every-day-picks.json', R), JSON.stringify(recentPicks));
fs.writeFileSync(new URL('every-day-report.txt', R), out.join(String.fromCharCode(10)));
