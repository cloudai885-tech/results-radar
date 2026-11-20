// Step 42: the user asked to try MANY combinations of the rules (yesterday's fall, opening drop, earlier falls, size,
// stop/target, extra filters) for Bounce-back and the Short, looking at winners AND losers, to add winning trades and
// raise the win rate. Thousands of combinations -> some look great by luck, so: every combination is CHOSEN on train
// (Apr 2024 - Sep 2025) and JUDGED on test (Oct 2025 - Nov 2026), and the final pick must also have good neighbours
// (one step changes in any setting stay good), not be a lone lucky point.
// Same engine as steps 40-41: real NSE series (no T2T buys, shorts EQ only), opening price as the fill, top 3 most
// traded a day, hourly exits where we have them (stop first in a bar), daily bars otherwise (stop first), costs 0.4%.
//   node --max-old-space-size=14000 research/42-combo-grid.mjs > data/research/combo-grid-report.txt
import fs from 'node:fs';
import { etfList, fetchCached, mapPool } from '../src/sources.mjs';

const DIR = new URL('../data/research/', import.meta.url);
const read = (f) => JSON.parse(fs.readFileSync(new URL(f, DIR), 'utf8'));
const mk = read('market.json'), hourly = read('hourly.json'), events = read('events-results.json');
const ETFS = await etfList();
const NOT_STOCK = /ETF|BEES|IETF|ADD$|^LIQUID|^GILT|^MON100|^MAFANG|^HNGSNG|^NIFTY|^SENSEX|^GOLD|^SILVER|CASE$|^MOM|^MID150/;
const COST = 0.004, SPLIT = '2025-10-01';
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
const TRAIN_M = 18, TEST_M = 13.5; // months in each part

// exits for many stop/target pairs at once
const SLTP = [[0.03, 0.07], [0.02, 0.05], [0.03, 0.05], [0.04, 0.07], [0.03, 0.10], [0.03, null], [0.02, 0.07], [0.025, 0.04], [0.05, 0.10], [0.02, 0.03], [0.04, 0.05], [0.015, 0.03]];
function outcomes(s, d, r, side) {
  const o = r[2], b = hourly[s]?.[d], last = b?.filter((x) => x[0] < 1530).at(-1);
  const H = last ? (() => { const sc = r[5] / last[4]; return b.filter((x) => x[0] < 1520).map(([t, a, h, l, c]) => [t, a * sc, h * sc, l * sc, c * sc]); })() : null;
  return SLTP.map(([stop, tgt]) => {
    if (H) {
      for (const [n, x] of H.entries()) {
        if (side === 'buy') { const sp = o * (1 - stop); if (x[3] <= sp) return (n ? Math.min(sp, x[1]) : sp) / o - 1 - COST; if (tgt && x[2] >= o * (1 + tgt)) return tgt - COST; }
        else { const sp = o * (1 + stop); if (x[2] >= sp) return -((n ? Math.max(sp, x[1]) : sp) / o - 1) - COST; if (tgt && x[3] <= o * (1 - tgt)) return tgt - COST; }
      }
      return (side === 'buy' ? H.at(-1)[4] / o - 1 : -(H.at(-1)[4] / o - 1)) - COST;
    }
    if (side === 'buy') return (r[4] <= o * (1 - stop) ? -stop : tgt && r[3] >= o * (1 + tgt) ? tgt : r[5] / o - 1) - COST;
    return (r[3] >= o * (1 + stop) ? -stop : tgt && r[4] <= o * (1 - tgt) ? tgt : -(r[5] / o - 1)) - COST;
  });
}

// ---------- candidates: a broad superset, each with the facts the grid filters on ----------
const WIN = [3, 5, 10], FT = [-0.03, -0.04, -0.045, -0.06];
const B = [], S = [];
for (let i = START; i < mk.days.length; i++) {
  const d = mk.days[i]; if (mGap[i] == null) continue;
  const ser = series.get(i);
  for (const [s, k] of byDay[i]) {
    if (k < 70 || ETFS.has(s) || NOT_STOCK.test(s)) continue;
    const R = mk.stocks[s], r = R[k], y = R[k - 1];
    if (y[0] !== i - 1 || !(r[1] > 0) || !(y[1] > 0) || r[1] < 5) continue;
    const sr = ser?.get(s); if (sr === 'BE') continue;
    const cr = median(R.slice(k - 20, k).map((x) => x[6] ?? 0)); if (!(cr >= 1)) continue;
    const gap = r[2] / r[1] - 1, yRet = y[5] / y[1] - 1;
    const p14 = R.slice(k - 14, k), atr = mean(p14.map((x, j) => { const pc = j ? p14[j - 1][5] : x[1]; return Math.max(x[3], pc) - Math.min(x[4], pc); })) / y[5];
    const vol20 = mean(R.slice(k - 21, k - 1).map((x) => x[6] ?? 0));
    const base = { s, d, i, cr, gap, yRet, atr, mg: mGap[i], volSpike: vol20 > 0 ? (y[6] ?? 0) / vol20 : 1, ret60: y[5] / R[k - 61][5] - 1, closeLoc: y[3] > y[4] ? (y[5] - y[4]) / (y[3] - y[4]) : 0.5, train: d < SPLIT };
    // Bounce-back superset
    if (!resultsOn[i].has(s) && yRet <= -0.02 && gap <= -0.01 && gap > -0.065) {
      const falls = WIN.map((w) => FT.map((f) => { let n = 0; for (let j = k - 1 - w; j < k - 1; j++) if (j >= 1 && R[j][5] / R[j][1] - 1 <= f) n++; return n; }));
      B.push({ ...base, falls, out: outcomes(s, d, r, 'buy') });
    }
    // Short superset: yesterday closed at its low after a fall
    const lcD = (x, lim) => x[3] > x[4] && x[5] === x[4] && x[5] / x[1] - 1 <= lim;
    if (sr === 'EQ' && lcD(y, -0.03) && gap > 0) {
      let streak = 0; for (let j = k - 1; j > 0 && lcD(R[j], -0.045); j--) streak++;
      S.push({ ...base, streak, rel: gap - mGap[i], out: outcomes(s, d, r, 'short') });
    }
  }
}
P(`Candidates: Bounce-back superset ${B.length}, Short superset ${S.length} (${mk.days[START]} .. ${mk.days.at(-1)})`);

// ---------- evaluate one rule: top 3 most traded a day, then the money numbers ----------
const byDayList = (list) => { const m = new Map(); for (const c of list) (m.get(c.i) ?? m.set(c.i, []).get(c.i)).push(c); for (const l of m.values()) l.sort((a, b) => b.cr - a.cr); return [...m.values()]; };
const BD = byDayList(B), SD = byDayList(S);
function evalRule(days, f, oi = 0) {
  const acc = { tr: { n: 0, w: 0, sum: 0, days: 0, dsum: 0 }, te: { n: 0, w: 0, sum: 0, days: 0, dsum: 0 } };
  for (const l of days) {
    let got = 0, ds = 0; const part = l[0].train ? acc.tr : acc.te;
    for (const c of l) { if (!f(c)) continue; const r = c.out[oi]; part.n++; part.sum += r; if (r > 0) part.w++; ds += r; if (++got === 3) break; }
    if (got) { part.days++; part.dsum += ds / got; }
  }
  const x = (p, months) => ({ n: p.n, avg: p.sum / p.n, won: p.w / p.n, days: p.days, perMonth: p.days / months, monthly: p.dsum / months });
  return { tr: x(acc.tr, TRAIN_M), te: x(acc.te, TEST_M) };
}
const row = (lab, e) => `  ${lab.padEnd(64)} | TRAIN ${String(e.tr.n).padStart(4)} tr ${pct(e.tr.avg)} won ${pct(e.tr.won, 0).padStart(4)} ${e.tr.perMonth.toFixed(1).padStart(4)} d/mo month ${pct(e.tr.monthly, 1).padStart(6)} | TEST ${String(e.te.n).padStart(4)} tr ${pct(e.te.avg)} won ${pct(e.te.won, 0).padStart(4)} ${e.te.perMonth.toFixed(1).padStart(4)} d/mo month ${pct(e.te.monthly, 1).padStart(6)}`;
P('"month" = profit per month if all money goes in on each trade day (simple sum, before tax). d/mo = trade days a month.');

// =================== BOUNCE-BACK GRID ===================
P('\n################ BOUNCE-BACK ################');
const NOW = (c) => c.yRet <= -0.03 && c.yRet > -0.08 && c.gap <= -0.02 && c.gap > -0.0495 && c.falls[1][2] >= 1;
const OLD = (c) => c.yRet <= -0.03 && c.gap <= -0.02 && c.gap > -0.0495;
P(row('OLD rule (before today)', evalRule(BD, OLD)));
P(row('NOW live (new rule pushed today)', evalRule(BD, NOW)));
const G = { yMax: [-0.02, -0.03, -0.04, -0.05], yMin: [-0.06, -0.08, -0.10, -0.20], gHi: [-0.015, -0.02, -0.025, -0.03], gLo: [-0.04, -0.05, -0.06], fall: [null], cr: [1, 5] };
const fallOpts = [null]; for (let w = 0; w < WIN.length; w++) for (let f = 0; f < FT.length; f++) for (const n of [1, 2]) fallOpts.push([w, f, n]);
const desc = (p) => `yday ${pct(p.yMax, 0)}..${pct(p.yMin, 0)} open ${pct(p.gHi, 1)}..${pct(p.gLo, 0)} ${p.fall ? `${p.fall[2]}x fall<=${pct(FT[p.fall[1]], 1)} in ${WIN[p.fall[0]]}d` : 'no earlier-fall need'} Rs${p.cr}cr+`;
const res = [];
for (const yMax of G.yMax) for (const yMin of G.yMin) for (const gHi of G.gHi) for (const gLo of G.gLo) for (const fall of fallOpts) for (const crMin of G.cr) {
  const p = { yMax, yMin, gHi, gLo, fall, cr: crMin };
  const f = (c) => c.yRet <= yMax && c.yRet > yMin && c.gap <= gHi && c.gap > gLo && c.cr >= crMin && (!fall || c.falls[fall[0]][fall[1]] >= fall[2]);
  const e = evalRule(BD, f);
  if (e.tr.n < 60) continue;
  res.push({ p, f, e });
}
P(`Bounce-back selection combinations tried: ${res.length} (each with stop 3% / target 7%)`);
const show = (title, list, n = 15) => { P(`\n  ${title}`); for (const r of list.slice(0, n)) P(row(desc(r.p), r.e)); };
// how many of the train-chosen top combos still beat NOW on unseen test data
const nowE = evalRule(BD, NOW);
const byTrainMonthly = [...res].sort((a, b) => b.e.tr.monthly - a.e.tr.monthly);
show('BEST by monthly profit on TRAIN (and what the same rule did on unseen TEST):', byTrainMonthly);
const byTrainAvg = [...res].filter((r) => r.e.tr.perMonth >= 6).sort((a, b) => b.e.tr.avg - a.e.tr.avg);
show('BEST by profit per trade on TRAIN (6+ trade days a month):', byTrainAvg);
const byTrainWon = [...res].filter((r) => r.e.tr.perMonth >= 6).sort((a, b) => b.e.tr.won - a.e.tr.won);
show('BEST by WIN RATE on TRAIN (6+ trade days a month):', byTrainWon);
const top50 = byTrainMonthly.slice(0, 50);
P(`\n  Of the 50 best-on-train combos, ${top50.filter((r) => r.e.te.monthly > nowE.te.monthly).length} beat NOW's monthly profit on unseen test, ${top50.filter((r) => r.e.te.avg > nowE.te.avg).length} beat its profit per trade.`);

// robust choice: good on train, and its one-step neighbours are good on train too (a plateau, not a spike)
const key = (p) => JSON.stringify(p);
const idx = new Map(res.map((r) => [key(r.p), r]));
const neighbours = (p) => {
  const out = [];
  for (const [k, vals] of Object.entries({ yMax: G.yMax, yMin: G.yMin, gHi: G.gHi, gLo: G.gLo, cr: G.cr })) { const j = vals.indexOf(p[k]); for (const dj of [-1, 1]) if (vals[j + dj] !== undefined) out.push({ ...p, [k]: vals[j + dj] }); }
  const fi = fallOpts.findIndex((x) => JSON.stringify(x) === JSON.stringify(p.fall));
  for (const dj of [-1, 1]) if (fallOpts[fi + dj] !== undefined) out.push({ ...p, fall: fallOpts[fi + dj] });
  return out.map((q) => idx.get(key(q))).filter(Boolean);
};
const robust = res.map((r) => { const nb = neighbours(r.p); return { ...r, nbMonthly: nb.length ? Math.min(...nb.map((x) => x.e.tr.monthly)) : -1, nbN: nb.length }; })
  .filter((r) => r.nbN >= 4).sort((a, b) => b.nbMonthly - a.nbMonthly);
show('ROBUST: best WORST-NEIGHBOUR monthly profit on train (the whole area is good, not one lucky point):', robust, 12);
const pick = robust[0];
P(`\n  CHOSEN (robust, chosen on train only): ${desc(pick.p)}`);
P(row('  chosen rule', pick.e));
P(row('  NOW live rule', nowE));

// stop / target for the chosen rule and for NOW
P('\n  STOP / TARGET for the chosen rule (chosen on train):');
const sl = SLTP.map(([st, tg], oi) => ({ st, tg, e: evalRule(BD, pick.f, oi) })).sort((a, b) => b.e.tr.monthly - a.e.tr.monthly);
for (const x of sl) P(row(`stop ${pct(x.st, 1)} target ${x.tg ? pct(x.tg, 0) : 'none'}`, x.e));
const bestSL = sl[0]; const oiBest = SLTP.findIndex(([a, b]) => a === bestSL.st && b === bestSL.tg);

// extra filters on top of the chosen rule (each kept only if it helps BOTH parts)
P('\n  EXTRA FILTERS on the chosen rule (+ = helps train AND test):');
const base0 = evalRule(BD, pick.f, oiBest);
P(row('chosen rule with its best stop/target', base0));
for (const [lab, g] of [['market opens up (>= 0)', (c) => c.mg >= 0], ['market not opening down hard (> -0.5%)', (c) => c.mg > -0.005], ['lively stock (range 3.5%+ a day)', (c) => c.atr >= 0.035], ['lively stock (range 5%+ a day)', (c) => c.atr >= 0.05],
  ['no big volume spike yesterday (< 2x)', (c) => c.volSpike < 2], ['strong stock before (3 months up)', (c) => c.ret60 > 0], ['closed at the day low yesterday (bottom 30%)', (c) => c.closeLoc <= 0.3], ['Rs 1-20 cr (smaller)', (c) => c.cr < 20], ['skip Rs 20-100 cr', (c) => !(c.cr >= 20 && c.cr < 100)]]) {
  const e = evalRule(BD, (c) => pick.f(c) && g(c), oiBest);
  P(row(lab, e) + (e.tr.avg > base0.tr.avg && e.te.avg > base0.te.avg ? '  +' : ''));
}

// =================== SHORT GRID ===================
P('\n################ SHORT (failed bounce) ################');
const SNOW = (c) => c.yRet <= -0.045 && c.streak === 1 && c.rel > 0.01 && c.mg >= 0;
P(row('NOW live short rule (stop 2% / target 5%)', evalRule(SD, SNOW, 1)));
const sres = [];
for (const yMax of [-0.03, -0.045, -0.07]) for (const rel of [0, 0.005, 0.01, 0.015, 0.02]) for (const mMin of [-1, -0.003, 0]) for (const st of [1, 2, 9]) for (const crMin of [1, 5]) for (let oi = 0; oi < SLTP.length; oi++) {
  const f = (c) => c.yRet <= yMax && c.rel > rel && c.mg >= mMin && c.streak <= st && c.cr >= crMin;
  const e = evalRule(SD, f, oi); if (e.tr.n < 40) continue;
  sres.push({ lab: `yday<=${pct(yMax, 1)} vs mkt>${pct(rel, 1)} mkt>=${mMin === -1 ? 'any' : pct(mMin, 1)} LC days<=${st === 9 ? 'any' : st} Rs${crMin}cr+ stop ${pct(SLTP[oi][0], 1)} tgt ${SLTP[oi][1] ? pct(SLTP[oi][1], 0) : 'none'}`, e });
}
P(`Short combinations tried: ${sres.length}`);
P('\n  BEST by monthly profit on TRAIN:'); for (const r of [...sres].sort((a, b) => b.e.tr.monthly - a.e.tr.monthly).slice(0, 12)) P(row(r.lab, r.e));
P('\n  BEST by WIN RATE on TRAIN (40+ trades):'); for (const r of [...sres].sort((a, b) => b.e.tr.won - a.e.tr.won).slice(0, 10)) P(row(r.lab, r.e));
P('\n  BEST by profit per trade on TRAIN:'); for (const r of [...sres].sort((a, b) => b.e.tr.avg - a.e.tr.avg).slice(0, 10)) P(row(r.lab, r.e));
fs.writeFileSync(new URL('combo-grid-pick.json', DIR), JSON.stringify({ bounce: { ...pick.p, sltp: SLTP[oiBest] } }));
