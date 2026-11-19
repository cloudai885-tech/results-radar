// Step 27: the user's idea. Start from the ~70 stocks that rise every day: what was true about them BEFORE the move
// (yesterday's close / today's 9:15 open)? Which clues raise the chance of a riser more than the chance of a faller?
// Then trade those clues with better entries than "buy at the open": a limit order 1% / 2% below the open (the dip many
// risers make first), or after a strong first hour; exits at the close or at a target with a stop.
// Hourly bars (step 24), Jan 2024 - Nov 2026. TRAIN < 2025-11-19 <= TEST (never used to choose). Costs shown.
//   node --max-old-space-size=12000 research/27-gainer-anatomy.mjs
import fs from 'node:fs';

const DIR = new URL('../data/research/', import.meta.url);
const read = (f) => JSON.parse(fs.readFileSync(new URL(f, DIR), 'utf8'));
const hourly = read('hourly.json'), mk = read('market.json'), funda = read('fundamentals.json'), events = read('events-results.json');
const SPLIT = '2025-11-19', RECENT = '2026-05-19';
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (v, d = 2) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : '   -  ');
const D = mk.days, dayIdx = new Map(D.map((d, i) => [d, i]));

// results seen by the market on day i (filed after the previous close, before 9:15)
const resultDay = new Set();
for (const e of events) {
  const [d, t = '00:00'] = e.time.split(' ');
  const i = D.findIndex((x) => x > d || (x === d && t < '09:15'));
  if (i < 0) continue;
  const pd = D[i - 1]; if (pd && (d < pd || (d === pd && t < '15:30'))) continue;
  resultDay.add(`${e.symbol}|${i}`);
}
// market health per day (share of liquid stocks above their 50-day average) and industry move per day
const daily = {};
for (const [s, rows] of Object.entries(mk.stocks)) { const m = new Map(); rows.forEach((r, k) => m.set(r[0], k)); daily[s] = { rows, at: m }; }
const health = D.map(() => [0, 0]), indRet = D.map(() => new Map());
for (const [s, { rows }] of Object.entries(daily)) {
  const g = funda[s]?.industry;
  for (let k = 50; k < rows.length; k++) {
    const r = rows[k]; const cr20 = mean(rows.slice(k - 20, k).map((x) => x[6]));
    if (!(cr20 >= 5)) continue;
    const sma50 = mean(rows.slice(k - 49, k + 1).map((x) => x[5]));
    health[r[0]][1]++; if (r[5] > sma50) health[r[0]][0]++;
    if (g) { const m = indRet[r[0]]; const a = m.get(g) ?? m.set(g, []).get(g); a.push(r[5] / r[1] - 1); }
  }
}
const healthOf = (i) => (health[i][1] > 200 ? health[i][0] / health[i][1] : NaN);
const indOf = (i, g) => { const a = indRet[i]?.get(g); return a && a.length >= 4 ? mean(a) : NaN; };

// ---- trade simulation on hourly bars ----
// entries: 'open' | 'dip1' (limit 1% under the open) | 'dip2' | 'conf' (10:15, first hour green and closing in its top 25%)
// exits: 'close' | 't3s2' (+3% target / -2% stop, else close) | 't5s3'
const ENTRIES = ['open', 'dip1', 'dip2', 'conf'], EXITS = ['close', 't3s2', 't5s3'];
const EXP = { close: [null, null], t3s2: [0.03, 0.02], t5s3: [0.05, 0.03] };
function sim(bars, entry, exit) {
  const o = bars[0][1];
  let j, px;
  if (entry === 'open') { j = 0; px = o; }
  else if (entry === 'conf') { const b = bars[0]; if (!(b[4] > b[1] && b[4] >= b[3] + 0.75 * (b[2] - b[3]))) return null; j = 1; px = b[4]; }
  else { const L = o * (entry === 'dip1' ? 0.99 : 0.98); j = bars.findIndex((b) => b[0] <= 1415 && b[3] <= L); if (j < 0) return null; px = L; }
  const [tg, st] = EXP[exit];
  for (let i = j; i < bars.length; i++) {
    const b = bars[i];
    const fillBar = entry !== 'open' && entry !== 'conf' && i === j; // filled inside this bar: only the stop can be judged
    if (st && b[3] <= px * (1 - st)) return -st;
    if (tg && !fillBar && b[2] >= px * (1 + tg)) return tg;
  }
  return bars.at(-1)[4] / px - 1;
}

// ---- build rows ----
const rows = [];
for (const [s, byDay] of Object.entries(hourly)) {
  const dd = daily[s]; if (!dd) continue;
  const g = funda[s]?.industry, mcap = funda[s]?.mcap;
  for (const [d, bars] of Object.entries(byDay)) {
    const i = dayIdx.get(d); if (i == null || bars.length < 7 || bars[0][0] !== 915) continue;
    const k = dd.at.get(i), ky = dd.at.get(i - 1);
    if (k == null || ky == null || ky < 252) continue;
    const R = dd.rows, y = R[ky];
    const past20 = R.slice(ky - 20, ky);
    const cr20 = mean(past20.map((x) => x[6])); if (!(cr20 >= 5)) continue;
    const o = bars[0][1], prevC = y[5];
    const hi250 = Math.max(...R.slice(ky - 250, ky).map((x) => x[3]));
    const ranges = R.slice(ky - 6, ky + 1).map((x) => (x[3] - x[4]) / x[5]);
    const hi = Math.max(...bars.map((b) => b[2])), lo = Math.min(...bars.map((b) => b[3]));
    const iHi = bars.findIndex((b) => b[2] === hi);
    const row = {
      s, d, cr: cr20, ret: {},
      oc: bars.at(-1)[4] / o - 1, oh: hi / o - 1, dipBefore: Math.min(...bars.slice(0, iHi + 1).map((b) => b[3])) / o - 1,
      f: {
        gap: o / prevC - 1,
        y1: y[5] / y[1] - 1,
        yPos: y[3] > y[4] ? (y[5] - y[4]) / (y[3] - y[4]) : 0.5,
        yVol: y[6] / cr20,
        yDel: (y[7] ?? NaN) / mean(past20.map((x) => x[7] ?? 0)),
        r5: y[5] / R[ky - 5][5] - 1,
        r20: y[5] / R[ky - 20][5] - 1,
        nearHi: y[5] / hi250 - 1,
        nr7: ranges.at(-1) <= Math.min(...ranges.slice(0, -1)) ? 1 : 0,
        health: healthOf(i - 1),
        indY: g ? indOf(i - 1, g) : NaN,
        result: resultDay.has(`${s}|${i}`) ? 1 : 0,
        size: mcap ?? NaN,
      },
    };
    for (const en of ENTRIES) for (const ex of EXITS) { const r = sim(bars, en, ex); if (r != null) row.ret[`${en}|${ex}`] = r; }
    // SHORT at the open (intraday): stop +2% above the open (hourly high), else cover at the close; or target -3%
    { let r = null; for (const b of bars) if (b[2] >= o * 1.02) { r = -0.02; break; } row.ret['short|close'] = r ?? 1 - bars.at(-1)[4] / o;
      let r2 = null; for (const b of bars) { if (b[2] >= o * 1.02) { r2 = -0.02; break; } if (b[3] <= o * 0.97) { r2 = 0.03; break; } } row.ret['short|t3s2'] = r2 ?? 1 - bars.at(-1)[4] / o; }
    void lo;
    rows.push(row);
  }
}
const train = rows.filter((r) => r.d < SPLIT), test = rows.filter((r) => r.d >= SPLIT), recent = rows.filter((r) => r.d >= RECENT);
const out = [];
const P = (...a) => { const l = a.join(' '); console.log(l); out.push(l); };
P(`${rows.length} stock-days (Rs 5 cr+/day), ${new Set(rows.map((r) => r.d)).size} days. TRAIN ${train.length}, TEST ${test.length}.`);

// ---- 1. anatomy: who are the risers? ----
const UP = 0.03;
const baseUp = rows.filter((r) => r.oc >= UP).length / rows.length, baseDn = rows.filter((r) => r.oc <= -UP).length / rows.length;
P(`\n1. RISERS: ${pct(baseUp, 1)} of stock-days close 3%+ above the open (~${Math.round(baseUp * rows.length / new Set(rows.map((r) => r.d)).size)} a day); ${pct(baseDn, 1)} close 3%+ below it.`);
const risers = rows.filter((r) => r.oc >= UP);
P(`   How far did risers dip below the open before their high? median ${pct(median(risers.map((r) => r.dipBefore)), 1)}; ${pct(risers.filter((r) => r.dipBefore <= -0.01).length / risers.length, 0)} dipped 1%+, ${pct(risers.filter((r) => r.dipBefore <= -0.02).length / risers.length, 0)} dipped 2%+.`);
P(`   For ALL stocks: ${pct(rows.filter((r) => r.dipBefore <= -0.01).length / rows.length, 0)} dip 1%+ at some point before their high.`);
const BK = {
  gap: [['gap < -2%', (v) => v < -0.02], ['gap -2..0%', (v) => v >= -0.02 && v < 0], ['gap 0..+2%', (v) => v >= 0 && v <= 0.02], ['gap +2..+5%', (v) => v > 0.02 && v <= 0.05], ['gap > +5%', (v) => v > 0.05]],
  y1: [['yday < -3%', (v) => v < -0.03], ['yday -3..0%', (v) => v >= -0.03 && v < 0], ['yday 0..+3%', (v) => v >= 0 && v < 0.03], ['yday +3..+8%', (v) => v >= 0.03 && v < 0.08], ['yday > +8%', (v) => v >= 0.08]],
  yPos: [['yday closed near low', (v) => v < 0.25], ['yday closed mid', (v) => v >= 0.25 && v <= 0.75], ['yday closed near high', (v) => v > 0.75]],
  yVol: [['yday volume < 1x', (v) => v < 1], ['yday volume 1-2x', (v) => v >= 1 && v < 2], ['yday volume 2-4x', (v) => v >= 2 && v < 4], ['yday volume > 4x', (v) => v >= 4]],
  yDel: [['yday delivery < 0.8x', (v) => v < 0.8], ['yday delivery 0.8-1.3x', (v) => v >= 0.8 && v < 1.3], ['yday delivery > 1.3x', (v) => v >= 1.3]],
  r5: [['5 days < -8%', (v) => v < -0.08], ['5 days -8..0%', (v) => v >= -0.08 && v < 0], ['5 days 0..+8%', (v) => v >= 0 && v < 0.08], ['5 days > +8%', (v) => v >= 0.08]],
  r20: [['month < -10%', (v) => v < -0.1], ['month -10..+10%', (v) => v >= -0.1 && v <= 0.1], ['month > +10%', (v) => v > 0.1]],
  nearHi: [['at 52w high', (v) => v >= -0.005], ['within 10% of high', (v) => v < -0.005 && v >= -0.1], ['10-30% below high', (v) => v < -0.1 && v >= -0.3], ['30%+ below high', (v) => v < -0.3]],
  nr7: [['quiet day yesterday (NR7)', (v) => v === 1], ['normal range', (v) => v === 0]],
  health: [['market health < 40%', (v) => v < 0.4], ['health 40-60%', (v) => v >= 0.4 && v <= 0.6], ['health > 60%', (v) => v > 0.6]],
  indY: [['industry fell 1%+ yday', (v) => v < -0.01], ['industry flat yday', (v) => v >= -0.01 && v <= 0.01], ['industry rose 1%+ yday', (v) => v > 0.01]],
  result: [['results today', (v) => v === 1], ['no results', (v) => v === 0]],
  size: [['small < 5k cr', (v) => v < 5000], ['mid 5-50k cr', (v) => v >= 5000 && v < 50000], ['large 50k cr+', (v) => v >= 50000]],
};
P('\n   Clue (known by 9:15)                     n      chance riser  chance faller   riser-faller   avg open->close');
for (const [k, list] of Object.entries(BK)) for (const [lab, f] of list) {
  const sub = rows.filter((r) => Number.isFinite(r.f[k]) && f(r.f[k]));
  if (sub.length < 500) continue;
  const up = sub.filter((r) => r.oc >= UP).length / sub.length, dn = sub.filter((r) => r.oc <= -UP).length / sub.length;
  P(`   ${lab.padEnd(36)} ${String(sub.length).padStart(7)}   ${pct(up, 1).padStart(7)} (${(up / baseUp).toFixed(1)}x)   ${pct(dn, 1).padStart(7)} (${(dn / baseDn).toFixed(1)}x)   ${pct(up - dn, 1).padStart(7)}   ${pct(mean(sub.map((r) => r.oc)))}`);
}

// ---- 2. pattern search: pairs of clues x 12 entry/exit ways, chosen on TRAIN only ----
const STRATS = [...ENTRIES.flatMap((en) => EXITS.map((ex) => `${en}|${ex}`)), 'short|close', 'short|t3s2'];
const buckets = Object.entries(BK).flatMap(([k, list]) => list.map(([lab, f]) => ({ k, lab, mask: Uint8Array.from(train, (r) => (Number.isFinite(r.f[k]) && f(r.f[k]) ? 1 : 0)), fn: (r) => Number.isFinite(r.f[k]) && f(r.f[k]) })));
const days = [...new Set(train.map((r) => r.d))].sort(), mid = days[Math.floor(days.length / 2)];
const isH1 = Uint8Array.from(train, (r) => (r.d < mid ? 1 : 0));
const found = [];
for (const st of STRATS) {
  const R = Float64Array.from(train, (r) => (st in r.ret ? r.ret[st] - 0.003 : NaN));
  for (let a = 0; a < buckets.length; a++) for (let b = a + 1; b < buckets.length; b++) {
    if (buckets[a].k === buckets[b].k) continue;
    const ma = buckets[a].mask, mb = buckets[b].mask;
    let n = 0, s = 0, s2 = 0, s1 = 0, n1 = 0;
    for (let i = 0; i < R.length; i++) { if (!ma[i] || !mb[i]) continue; const v = R[i]; if (v !== v) continue; n++; s += v; s2 += v * v; if (isH1[i]) { n1++; s1 += v; } }
    if (n < 300) continue;
    const m = s / n, t = m / (Math.sqrt(Math.max(1e-12, s2 / n - m * m)) / Math.sqrt(n));
    if (t < 3 || s1 <= 0 || s - s1 <= 0) continue;
    found.push({ st, label: `${buckets[a].lab} + ${buckets[b].lab}`, f: (r) => buckets[a].fn(r) && buckets[b].fn(r), n, m, t });
  }
}
found.sort((x, y) => y.t - x.t);
const per = (list, st, cost) => { const v = list.filter((r) => st in r.ret).map((r) => r.ret[st] - cost); return { n: v.length, m: mean(v), win: v.filter((x) => x > 0).length / v.length }; };
P(`\n2. PATTERN SEARCH: ${found.length} (clue pair x entry/exit) made money in TRAIN (t>3, both halves, 0.3% costs). Top 40 by TRAIN strength:`);
P('   entry|exit   clues                                                              TRAIN            | TEST (0.2% / 0.4%)              | recent 6m');
for (const x of found.slice(0, 40)) {
  const b2 = per(test.filter(x.f), x.st, 0.002), b4 = per(test.filter(x.f), x.st, 0.004), c = per(recent.filter(x.f), x.st, 0.002);
  P(`   ${x.st.padEnd(12)} ${x.label.padEnd(64)} ${String(x.n).padStart(5)} ${pct(x.m + 0.001)} | ${String(b2.n).padStart(5)} ${pct(b2.m)} / ${pct(b4.m)} won ${pct(b2.win, 0)} | ${String(c.n).padStart(4)} ${pct(c.m)}`);
}
const held = found.map((x) => ({ ...x, b: per(test.filter(x.f), x.st, 0.002) })).filter((x) => x.b.n >= 100);
P(`   ${held.length} with 100+ TEST trades: ${held.filter((x) => x.b.m > 0).length} positive in TEST at 0.2% costs, ${held.filter((x) => per(test.filter(x.f), x.st, 0.004).m > 0).length} at 0.4%.`);

// ---- 3. real basket: at most 3 a day (most traded first), for the 15 best TEST survivors ----
P('\n3. AS A REAL DAILY BASKET (max 3 stocks a day, most traded first), TEST period and recent 6 months:');
const surv = held.filter((x) => process.env.SHORTONLY ? x.st.startsWith('short') : true).filter((x) => x.b.m > 0).sort((a, b) => b.b.m - a.b.m).slice(0, 15);
for (const x of surv) {
  for (const cost of [0.002, 0.004]) {
    const by = new Map(); for (const r of rows) if (x.f(r) && x.st in r.ret) (by.get(r.d) ?? by.set(r.d, []).get(r.d)).push(r);
    const dayv = [...by].sort(([a], [b]) => a.localeCompare(b)).map(([d, l]) => ({ d, v: mean(l.sort((a, b) => b.cr - a.cr).slice(0, 3).map((r) => r.ret[x.st] - cost)) }));
    const T = dayv.filter((z) => z.d >= SPLIT), Rc = dayv.filter((z) => z.d >= RECENT), Tr = dayv.filter((z) => z.d < SPLIT);
    let eq = 1, pk = 1, dd = 0; for (const z of T) { eq *= 1 + z.v; pk = Math.max(pk, eq); dd = Math.min(dd, eq / pk - 1); }
    P(`   ${x.st.padEnd(12)} ${x.label.padEnd(64)} cost ${cost * 100}% | TRAIN ${Tr.length}d ${pct(mean(Tr.map((z) => z.v)))}/day | TEST ${T.length}d ${pct(mean(T.map((z) => z.v)))}/day, green days ${pct(T.filter((z) => z.v > 0).length / T.length, 0)}, total ${pct(eq - 1, 1)}, worst drop ${pct(dd, 1)} | recent ${Rc.length}d ${pct(mean(Rc.map((z) => z.v)))}/day`);
  }
}
fs.writeFileSync(new URL('gainer-anatomy-report.txt', DIR), out.join('\n'));
