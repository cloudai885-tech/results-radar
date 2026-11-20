// Step 40: deep test of the short setup from step 39 - "yesterday locked at the LOWER circuit, today it opens UP
// (better than the market) -> short at the open, buy back the same day".
// Real NSE series from the previous day's bhavcopy (only EQ can be shorted intraday; BE/T2T cannot), exits on hourly bars
// where we have them (rescaled to NSE's close; the STOP counts first if stop and target fall in one bar), daily bars
// otherwise (stop first). Top 3 most traded a day. Costs 0.4%. Choices made on train (to Sep 2025), judged on test (Oct 2025+).
//   node --max-old-space-size=12000 research/40-short-bounce.mjs > data/research/short-bounce-report.txt
import fs from 'node:fs';
import { etfList, fetchCached, mapPool } from '../src/sources.mjs';

const DIR = new URL('../data/research/', import.meta.url);
const read = (f) => JSON.parse(fs.readFileSync(new URL(f, DIR), 'utf8'));
const mk = read('market.json'), hourly = read('hourly.json');
const ETFS = await etfList();
const NOT_STOCK = /ETF|BEES|IETF|ADD$|^LIQUID|^GILT|^MON100|^MAFANG|^HNGSNG|^NIFTY|^SENSEX|^GOLD|^SILVER|CASE$|^MOM|^MID150/;
const COST = 0.004;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (v, d = 2) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : '   -   ');
const P = (...a) => console.log(a.join(' '));
const SPLIT = '2025-10-01';
const PER = [['24H1', '2024-01', '2024-07'], ['24H2', '2024-07', '2025-01'], ['25H1', '2025-01', '2025-07'], ['25H2', '2025-07', '2026-01'], ['26H1', '2026-01', '2026-07'], ['26H2', '2026-07', '2027-01']];

// ---- market opening per day ----
const byDay = mk.days.map(() => new Map());
for (const [s, rows] of Object.entries(mk.stocks)) rows.forEach((r, k) => byDay[r[0]].set(s, k));
const mGap = [];
for (let i = 1; i < mk.days.length; i++) {
  const g = []; for (const [s, k] of byDay[i]) { const r = mk.stocks[s][k]; if (r[1] > 0 && (r[6] ?? 0) >= 2) g.push(r[2] / r[1] - 1); }
  mGap[i] = g.length > 200 ? median(g) : null;
}

// ---- candidate days: yesterday closed at its low after a 4.5%+ fall ----
const raw = [];
for (const [s, R] of Object.entries(mk.stocks)) {
  if (ETFS.has(s) || NOT_STOCK.test(s)) continue;
  for (let k = 25; k < R.length; k++) {
    const r = R[k], y = R[k - 1], i = r[0];
    if (y[0] !== i - 1 || !(r[1] > 0) || !(y[1] > 0) || mGap[i] == null || r[1] < 5) continue;
    const yRet = y[5] / y[1] - 1;
    if (!(y[3] > y[4] && y[5] === y[4] && yRet <= -0.045)) continue;
    const cr = median(R.slice(k - 20, k).map((x) => x[6] ?? 0)); if (!(cr >= 1)) continue;
    let streak = 0; for (let j = k - 1; j > 0 && R[j][5] === R[j][4] && R[j][3] > R[j][4] && R[j][5] / R[j][1] - 1 <= -0.045 && R[j][0] === R[j - 1][0] + 1; j--) streak++;
    const band = yRet >= -0.0525 ? 5 : yRet >= -0.105 && yRet <= -0.095 ? 10 : yRet >= -0.205 && yRet <= -0.195 ? 20 : 0;
    raw.push({ s, d: mk.days[i], i, k, R, gap: r[2] / r[1] - 1, relGap: r[2] / r[1] - 1 - mGap[i], mGap: mGap[i], yRet, cr, streak, band,
      ret20: y[5] / R[k - 21][5] - 1, deliv: y[7] ?? null, o: r[2], h: r[3], l: r[4], c: r[5], prev: r[1] });
  }
}
// ---- real series from the previous day's bhavcopy ----
const need = [...new Set(raw.map((t) => t.i))];
const series = new Map(); // day index -> Map(symbol -> series) from the PREVIOUS session
let got = 0;
await mapPool(need, 4, async (i) => {
  const [Y, M, D] = mk.days[i - 1].split('-');
  const csv = await fetchCached(`https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${D}${M}${Y}.csv`, { ttlHours: 1e7, attempts: 2 }).catch(() => null);
  if (!csv?.startsWith('SYMBOL')) return;
  const m = new Map(); for (const line of csv.split(String.fromCharCode(10)).slice(1)) { const p = line.split(',').map((x) => x.trim()); if (p[0]) m.set(p[0], p[1]); }
  series.set(i, m); got++;
});
for (const t of raw) t.series = series.get(t.i)?.get(t.s) ?? (series.has(t.i) ? 'none' : 'unknown');
P(`Lower-circuit-yesterday stock-days: ${raw.length} | bhavcopy found for ${got}/${need.length} days | series: ${Object.entries(raw.reduce((a, t) => ((a[t.series] = (a[t.series] ?? 0) + 1), a), {})).map(([k, v]) => `${k} ${v}`).join(', ')}`);

// ---- exits ----
const bars = (t) => {
  const b = hourly[t.s]?.[t.d]; const last = b?.filter((x) => x[0] < 1530).at(-1); if (!last) return null;
  const sc = t.c / last[4]; return b.filter((x) => x[0] < 1520).map(([tm, a, h, l, c]) => [tm, a * sc, h * sc, l * sc, c * sc]);
};
// short at entry price e (default the open); stop/target as fractions (null = none); exit by time `till` (hhmm, bar start)
function shortRes(t, { stop = 0.03, tgt = 0.07, slip = 0, till = 1520, useDaily = false } = {}) {
  const e = t.o * (1 - slip), sp = stop ? e * (1 + stop) : null, tp = tgt ? e * (1 - tgt) : null;
  const B = useDaily ? null : bars(t);
  if (B) {
    const H = B.filter((x) => x[0] < till); if (!H.length) return null;
    for (const [n, x] of H.entries()) {
      if (sp && x[2] >= sp) return { r: -((n ? Math.max(sp, x[1]) : sp) / e - 1) - COST, how: 'stop', src: 'h' };
      if (tp && x[3] <= tp) return { r: tgt - COST, how: 'target', src: 'h' };
    }
    return { r: -(H.at(-1)[4] / e - 1) - COST, how: 'close', src: 'h' };
  }
  if (till < 1520) return null;
  if (sp && t.h >= sp) return { r: -stop - COST, how: 'stop', src: 'd' };
  if (tp && t.l <= tp) return { r: tgt - COST, how: 'target', src: 'd' };
  return { r: -(t.c / e - 1) - COST, how: 'close', src: 'd' };
}
const top3 = (list) => { const m = new Map(); for (const t of list) (m.get(t.d) ?? m.set(t.d, []).get(t.d)).push(t); return [...m.values()].flatMap((l) => l.sort((a, b) => b.cr - a.cr).slice(0, 3)); };
function stats(list, opt = {}) {
  const rs = list.map((t) => ({ t, ...shortRes(t, opt) })).filter((x) => x.r != null);
  const v = rs.map((x) => x.r), tr = rs.filter((x) => x.t.d < SPLIT).map((x) => x.r), te = rs.filter((x) => x.t.d >= SPLIT).map((x) => x.r);
  return { n: v.length, avg: mean(v), won: v.filter((x) => x > 0).length / v.length, tr: mean(tr), te: mean(te), trN: tr.length, teN: te.length, rs,
    per: PER.map(([, a, b]) => { const x = rs.filter((y) => y.t.d >= a && y.t.d < b).map((y) => y.r); return x.length >= 4 ? mean(x) : null; }) };
}
const line = (lab, st) => `  ${lab.padEnd(50)} ${String(st.n).padStart(4)} tr | avg ${pct(st.avg)} | won ${pct(st.won, 0).padStart(4)} | train ${pct(st.tr)} (${st.trN}) | test ${pct(st.te)} (${st.teN}) | ${st.per.map((v, j) => `${PER[j][0]} ${pct(v, 1)}`).join(' ')}`;

const EQ = raw.filter((t) => t.series === 'EQ');
const base = (t) => t.relGap > 0.005;
P('\n=== 1. THE SETUP FROM STEP 39, NOW WITH REAL NSE SERIES ===');
P(line('step 39 rule, any series (not tradable if BE)', stats(top3(raw.filter(base)))));
P(line('step 39 rule, EQ only (can be shorted)', stats(top3(EQ.filter(base)))));
P(line('  same, daily bars only (stop first, old way)', stats(top3(EQ.filter(base)), { useDaily: true })));
const hb = top3(EQ.filter(base)).filter((t) => bars(t));
P(line('  only trades with hourly bars, hourly exits', stats(hb)));
P(line('  only trades with hourly bars, daily exits', stats(hb, { useDaily: true })));

P('\n=== 2. VARIANTS (EQ only, top 3 a day, stop 3% / target 7%) - "+" = beats the base in BOTH train and test ===');
const B0 = stats(top3(EQ.filter(base)));
const V = [
  ['opens up at all (gap > 0)', (t) => t.gap > 0], ['gap > 0.5%', (t) => t.gap > 0.005], ['gap > 1%', (t) => t.gap > 0.01], ['gap > 2%', (t) => t.gap > 0.02], ['gap > 3%', (t) => t.gap > 0.03],
  ['vs market > 0%', (t) => t.relGap > 0], ['vs market > 1%', (t) => t.relGap > 0.01], ['vs market > 2%', (t) => t.relGap > 0.02],
  ['gap 0.5..2% (small bounce)', (t) => t.relGap > 0.005 && t.gap <= 0.02], ['gap 2%+ (big bounce)', (t) => t.relGap > 0.005 && t.gap > 0.02],
  ['base + 5% band stock', (t) => base(t) && t.band === 5], ['base + 10% band', (t) => base(t) && t.band === 10], ['base + 20% band', (t) => base(t) && t.band === 20], ['base + other (no band / 2%)', (t) => base(t) && t.band === 0],
  ['base + 1st lower-circuit day', (t) => base(t) && t.streak === 1], ['base + 2nd+ lower-circuit day', (t) => base(t) && t.streak >= 2],
  ['base + Rs 1-5 cr', (t) => base(t) && t.cr < 5], ['base + Rs 5-20 cr', (t) => base(t) && t.cr >= 5 && t.cr < 20], ['base + Rs 20 cr+', (t) => base(t) && t.cr >= 20],
  ['base + market opens down', (t) => base(t) && t.mGap < 0], ['base + market opens up', (t) => base(t) && t.mGap >= 0],
  ['base + month before down 20%+', (t) => base(t) && t.ret20 <= -0.2], ['base + month before better than -20%', (t) => base(t) && t.ret20 > -0.2],
  ['NOT bounced: opens flat/down (gap <= 0)', (t) => t.gap <= 0],
];
P(line('BASE: vs market > 0.5%', B0));
for (const [lab, f] of V) { const st = stats(top3(EQ.filter(f))); P(line(lab, st) + (st.tr > B0.tr && st.te > B0.te && st.n >= 40 ? '  +' : '')); }

P('\n=== 3. STOP / TARGET (base, trades with hourly bars only; chosen on train, judged on test) ===');
const grid = [];
for (const stop of [0.02, 0.03, 0.04, 0.05, 0.07, null]) for (const tgt of [0.03, 0.05, 0.07, 0.1, null]) {
  const st = stats(hb, { stop, tgt }); grid.push({ stop, tgt, st });
}
const lab = (v) => (v == null ? 'none' : `${v * 100}%`);
for (const g of grid.sort((a, b) => b.st.tr - a.st.tr).slice(0, 12)) P(`  stop ${lab(g.stop).padStart(4)} target ${lab(g.tgt).padStart(4)} | avg ${pct(g.st.avg)} won ${pct(g.st.won, 0)} | train ${pct(g.st.tr)} | test ${pct(g.st.te)}${g.stop === 0.03 && g.tgt === 0.07 ? '  <- now' : ''}`);
const now = grid.find((g) => g.stop === 0.03 && g.tgt === 0.07); P(`  (stop 3% / target 7% for reference: train ${pct(now.st.tr)} test ${pct(now.st.te)})`);

P('\n=== 4. WHEN TO BUY BACK (hourly) ===');
for (const till of [1015, 1115, 1215, 1315, 1415, 1520]) P(line(`buy back by ${String(till).replace(/(\d\d)$/, ':$1')} (stop 3%, target 7%)`, stats(hb, { till })));

P('\n=== 5. RISKS ===');
const st = stats(top3(EQ.filter(base)));
const sorted = [...st.rs].sort((a, b) => a.r - b.r);
P(`  worst 8 trades: ${sorted.slice(0, 8).map((x) => `${x.t.d} ${x.t.s} ${pct(x.r, 1)}`).join(', ')}`);
P(`  best 8 trades: ${sorted.slice(-8).map((x) => `${x.t.d} ${x.t.s} ${pct(x.r, 1)}`).join(', ')}`);
P(`  without the best 10 trades: avg ${pct(mean(sorted.slice(0, -10).map((x) => x.r)))}`);
const byS = new Map(); for (const x of st.rs) byS.set(x.t.s, (byS.get(x.t.s) ?? 0) + x.r);
const tot = [...byS.values()].reduce((a, b) => a + b, 0), topS = [...byS].sort((a, b) => b[1] - a[1]);
P(`  ${byS.size} different stocks | top 5 stocks give ${pct(topS.slice(0, 5).reduce((a, x) => a + x[1], 0) / tot, 0)} of all profit: ${topS.slice(0, 5).map(([s, v]) => `${s} ${pct(v, 0)}`).join(', ')}`);
P(`  without the top 5 stocks: avg ${pct(mean(st.rs.filter((x) => !topS.slice(0, 5).some(([s]) => s === x.t.s)).map((x) => x.r)))}`);
let run = 0, maxRun = 0; for (const x of [...st.rs].sort((a, b) => a.t.d.localeCompare(b.t.d))) { run = x.r <= 0 ? run + 1 : 0; maxRun = Math.max(maxRun, run); }
P(`  longest losing streak: ${maxRun} trades`);
const ucTrap = st.rs.filter((x) => x.t.band && x.t.c === x.t.h && x.t.c / x.t.prev - 1 >= x.t.band / 100 - 0.003);
P(`  closed LOCKED at the upper circuit (could not buy back): ${ucTrap.length} of ${st.n}${ucTrap.length ? ' - ' + ucTrap.map((x) => `${x.t.d} ${x.t.s} ${pct(x.r, 1)}`).join(', ') : ''}`);
const hitUC = st.rs.filter((x) => x.t.band && x.t.h / x.t.prev - 1 >= x.t.band / 100 - 0.003);
P(`  touched the upper circuit during the day: ${hitUC.length} (the stop should have bought back before - stop is ~3% above the open)`);
for (const slip of [0.0025, 0.005, 0.01]) P(line(`shorted ${slip * 100}% WORSE than the open`, stats(top3(EQ.filter(base)), { slip })));
P(`  trades per month: ${(st.n / 31).toFixed(1)} on average; last 6 months ${st.rs.filter((x) => x.t.d >= '2026-05-20').length}`);

P('\n=== 6. MIRROR CHECK: yesterday UPPER circuit, today opens DOWN -> buy? (to see if it is a general "circuit next day" effect) ===');
// (computed quickly from market.json)
const mir = [];
for (const [s, R] of Object.entries(mk.stocks)) {
  if (ETFS.has(s) || NOT_STOCK.test(s)) continue;
  for (let k = 25; k < R.length; k++) { const r = R[k], y = R[k - 1], i = r[0]; if (y[0] !== i - 1 || mGap[i] == null || !(r[1] >= 5)) continue; const yRet = y[5] / y[1] - 1;
    if (!(y[3] > y[4] && y[5] === y[3] && yRet >= 0.045)) continue; const cr = median(R.slice(k - 20, k).map((x) => x[6] ?? 0)); if (!(cr >= 1)) continue;
    if (r[2] / r[1] - 1 - mGap[i] >= -0.005) continue; const o = r[2]; mir.push({ d: mk.days[i], cr, r: (r[4] <= o * 0.97 ? -0.03 : r[3] >= o * 1.07 ? 0.07 : r[5] / o - 1) - COST }); }
}
const mt = top3(mir); P(`  ${mt.length} trades | avg ${pct(mean(mt.map((x) => x.r)))} | won ${pct(mt.filter((x) => x.r > 0).length / mt.length, 0)} (daily bars)`);

// ---- 7. last ~60 days on 5-minute bars: entry at the open vs a few minutes later ----
P('\n=== 7. LAST ~60 DAYS ON 5-MINUTE BARS ===');
const recent = top3(EQ.filter(base)).filter((t) => t.d >= '2026-08-25');
const five = new Map();
await mapPool([...new Set(recent.map((t) => t.s))], 4, async (s) => {
  const body = await fetchCached(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}.NS?range=60d&interval=5m`, { ttlHours: 24, attempts: 2 }).catch(() => null);
  const r = body ? JSON.parse(body).chart?.result?.[0] : null; if (!r?.timestamp) return;
  const q = r.indicators.quote[0], m = new Map();
  r.timestamp.forEach((ts, n) => { if (q.open[n] == null) return; const iso = new Date((ts + 19800) * 1000).toISOString(); const d = iso.slice(0, 10), hm = Number(iso.slice(11, 13) + iso.slice(14, 16)); (m.get(d) ?? m.set(d, []).get(d)).push([hm, q.open[n], q.high[n], q.low[n], q.close[n]]); });
  five.set(s, m);
});
const sim5 = (t, fromHm, stop = 0.03, tgt = 0.07) => {
  const b = five.get(t.s)?.get(t.d); if (!b?.length) return null; const last = b.filter((x) => x[0] < 1530).at(-1); const sc = t.c / last[4];
  const H = b.map(([tm, a, h, l, c]) => [tm, a * sc, h * sc, l * sc, c * sc]).filter((x) => x[0] < 1520);
  const j0 = H.findIndex((x) => x[0] >= fromHm); if (j0 < 0) return null;
  const e = fromHm <= 915 ? t.o : H[j0][1], sp = e * (1 + stop), tp = e * (1 - tgt);
  for (let n = j0; n < H.length; n++) { const x = H[n]; if (x[2] >= sp) return -((n > j0 ? Math.max(sp, x[1]) : sp) / e - 1) - COST; if (x[3] <= tp) return tgt - COST; }
  return -(H.at(-1)[4] / e - 1) - COST;
};
for (const [labx, hm] of [['short at the official open', 915], ['short at 9:20', 920], ['short at 9:30', 930], ['short at 9:45', 945]]) {
  const v = recent.map((t) => sim5(t, hm)).filter((x) => x != null);
  P(`  ${labx.padEnd(28)} ${v.length} trades | avg ${pct(mean(v))} | won ${pct(v.filter((x) => x > 0).length / v.length, 0)}`);
}
P(`  trades: ${recent.map((t) => `${t.d} ${t.s} gap ${pct(t.gap, 1)} -> ${pct(sim5(t, 915), 1)}`).join(' | ')}`);

// ---- 8. refined rule from sections 2-3, with the upper-circuit risk ----
P('\n=== 8. REFINED RULE + UPPER-CIRCUIT RISK ===');
const refined = (t) => t.streak === 1 && t.relGap > 0.01 && t.mGap >= 0;
for (const [labr, f] of [['BASE', base], ['REFINED: 1st LC day, opens 1%+ above market, market not down', refined]]) {
  for (const stop of [0.03, 0.02]) {
    const s2 = stats(top3(EQ.filter(f)), { stop });
    const lock = s2.rs.filter((x) => x.t.band && x.t.c === x.t.h && x.t.c / x.t.prev - 1 >= x.t.band / 100 - 0.003);
    const reach = s2.rs.filter((x) => x.t.band && x.t.h / x.t.prev - 1 >= x.t.band / 100 - 0.003);
    P(line(`${labr} | stop ${stop * 100}%`, s2));
    P(`      5%-band stocks ${s2.rs.filter((x) => x.t.band === 5).length}/${s2.n} | touched upper circuit ${reach.length} | closed LOCKED there ${lock.length} | if each locked one really lost up to the circuit: avg ${pct(mean(s2.rs.map((x) => (lock.includes(x) ? -(x.t.prev * (1 + x.t.band / 100) / x.t.o - 1) - COST : x.r))))} | last 6m ${s2.rs.filter((x) => x.t.d >= '2026-05-20').length} tr ${pct(mean(s2.rs.filter((x) => x.t.d >= '2026-05-20').map((x) => x.r)))}`);
  }
  for (const slip of [0.0025, 0.005]) P(line(`   ${labr} shorted ${slip * 100}% LOWER than the open (worse)`, stats(top3(EQ.filter(f)), { slip })));
}
const nb = top3(EQ.filter((t) => refined(t) && t.band !== 5));
P(line('REFINED but only 10%/20%/no-band stocks (no 5% trap)', stats(nb)));
