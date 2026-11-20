// Step 39: the user's big idea - look at EVERY intraday winner and loser of the last 2-3 years, find what they have in
// common at 9:15, search for new setups (even ~5 trades a month is fine), and check what our strategies catch or miss.
// Universe: every stock-day, companies only, Rs 1 cr+/day (median of the last 20 sessions), price Rs 5+, no ETFs, T2T
// guessed as delivery ~100% yesterday (T2T can only be delivery). Trade = buy (or short) at the official open,
// stop 3% / target 7% (stop first if both on the same day), else sold at the close. Costs 0.4%.
// Winner = closed 5%+ above its open, loser = closed 5%+ below.
// Every fact is known before 9:15 (yesterday's bars + today's opening price + the market's opening).
// GUARD against luck: setups are CHOSEN on Mar 2024 - Jun 2025 (train) and then JUDGED on Jul 2025 - Nov 2026 (test).
// Survivors are re-checked with the top 3 most traded a day and on hourly bars (2025-26).
//   node --max-old-space-size=14000 research/39-daily-winners.mjs > data/research/daily-winners-report.txt
import fs from 'node:fs';
import { etfList } from '../src/sources.mjs';
import { targetQuarter } from '../src/score.mjs';

const DIR = new URL('../data/research/', import.meta.url);
const read = (f) => JSON.parse(fs.readFileSync(new URL(f, DIR), 'utf8'));
const mk = read('market.json'), events = read('events-results.json'), funda = read('fundamentals.json');
const ETFS = await etfList();
const NOT_STOCK = /ETF|BEES|IETF|ADD$|^LIQUID|^GILT|^MON100|^MAFANG|^HNGSNG|^NIFTY|^SENSEX|^GOLD|^SILVER|CASE$|^MOM|^MID150/;
const COST = 0.004;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (v, d = 2) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : '   -   ');
const P = (...a) => console.log(a.join(' '));
const PER = ['2024H1', '2024H2', '2025H1', '2025H2', '2026H1', '2026H2'];
const perOf = (d) => (Number(d.slice(0, 4)) - 2024) * 2 + (d.slice(5, 7) >= '07' ? 1 : 0);
const TRAIN = [0, 1, 2], TEST = [3, 4, 5];

// ---------- market-level facts per day ----------
const byDay = mk.days.map(() => new Map());
for (const [s, rows] of Object.entries(mk.stocks)) rows.forEach((r, k) => byDay[r[0]].set(s, k));
const mGap = [], mYday = [], fallers = [], risers = [];
for (let i = 1; i < mk.days.length; i++) {
  const g = [], y = []; let f = 0, u = 0;
  for (const [s, k] of byDay[i]) {
    const R = mk.stocks[s], r = R[k]; if (!(r[1] > 0) || (r[6] ?? 0) < 2) continue;
    g.push(r[2] / r[1] - 1);
    const p = R[k - 1]; if (p && p[0] === i - 1 && p[1] > 0) { const m = p[5] / p[1] - 1; y.push(m); if (m <= -0.03) f++; if (m >= 0.03) u++; }
  }
  mGap[i] = g.length > 200 ? median(g) : null; mYday[i] = y.length > 200 ? median(y) : null; fallers[i] = f; risers[i] = u;
}
const resultsOn = mk.days.map(() => new Set());
for (const e of events) {
  const [d, t = '00:00'] = e.time.split(' ');
  const i = mk.days.findIndex((x) => x > d || (x === d && t < '09:00'));
  if (i < 1 || (mk.days[i] === d && t >= '09:00')) continue;
  const pd = mk.days[i - 1]; if (d < pd || (d === pd && t < '15:30')) continue;
  resultsOn[i].add(e.symbol);
}

// ---------- every stock-day ----------
const FEAT = ['gap', 'gapAtr', 'relGap', 'yRet', 'y2Ret', 'ret5', 'ret20', 'ret60', 'big5', 'up5', 'upStreak', 'downStreak',
  'fromHigh', 'fromLow', 'vsMa20', 'vsMa50', 'vsMa200', 'atr', 'yRangeAtr', 'nr7', 'closeLoc', 'volSpike', 'vol5', 'deliv',
  'cr', 'price', 'results', 'yUpperCkt', 'yLowerCkt', 'open20High', 'open20Low', 'mGap', 'mYday', 'fallers', 'risers', 'dow'];
const NAME = {
  gap: 'opening gap', gapAtr: 'gap / daily range', relGap: 'gap vs market gap', yRet: 'yesterday move', y2Ret: 'day-before move',
  ret5: '5-day move', ret20: '1-month move', ret60: '3-month move', big5: 'big falls in 5d before yday', up5: 'big rises in 5d before yday',
  upStreak: 'up days in a row', downStreak: 'down days in a row', fromHigh: 'below 1-yr high', fromLow: 'above 1-yr low',
  vsMa20: 'vs 20-day avg', vsMa50: 'vs 50-day avg', vsMa200: 'vs 200-day avg', atr: 'daily range (ATR)', yRangeAtr: 'yday range / ATR',
  nr7: 'yday narrowest of 7', closeLoc: 'yday close in range', volSpike: 'yday volume vs normal', vol5: '5d volume vs normal',
  deliv: 'yday delivery %', cr: 'Rs cr/day', price: 'price Rs', results: 'results overnight', yUpperCkt: 'yday upper circuit',
  yLowerCkt: 'yday lower circuit', open20High: 'opens above 20-day high', open20Low: 'opens below 20-day low',
  mGap: 'market opening', mYday: 'market yesterday', fallers: 'stocks down 3%+ yday', risers: 'stocks up 3%+ yday', dow: 'weekday',
};
const PCTF = new Set(['gap', 'relGap', 'yRet', 'y2Ret', 'ret5', 'ret20', 'ret60', 'fromHigh', 'fromLow', 'vsMa20', 'vsMa50', 'vsMa200', 'atr', 'closeLoc', 'mGap', 'mYday']);
const BOOL = new Set(['results', 'nr7', 'yUpperCkt', 'yLowerCkt', 'open20High', 'open20Low']);

const X = Object.fromEntries(FEAT.map((f) => [f, []]));
const sym = [], dayI = [], per = [], crA = [], L = [], S = [], OC = [], famA = [];
const syms = Object.keys(mk.stocks);
for (const [si, s] of syms.entries()) {
  if (ETFS.has(s) || NOT_STOCK.test(s)) continue;
  const R = mk.stocks[s];
  const cs = [0]; for (const r of R) cs.push(cs.at(-1) + r[5]);       // prefix sums of closes
  const ts = [0]; for (const r of R) ts.push(ts.at(-1) + (r[6] ?? 0)); // prefix sums of turnover
  const maC = (k, n) => (k - n >= 0 ? (cs[k] - cs[k - n]) / n : NaN);   // average close of rows k-n..k-1
  for (let k = 60; k < R.length; k++) {
    const r = R[k], y = R[k - 1], i = r[0], d = mk.days[i];
    if (y[0] !== i - 1 || !(r[1] > 0) || !(y[1] > 0) || mGap[i] == null || r[1] < 5) continue;
    if ((y[7] ?? 0) >= 99.9) continue; // T2T guess
    const cr = median(R.slice(k - 20, k).map((x) => x[6] ?? 0)); if (!(cr >= 1)) continue;
    const p14 = R.slice(k - 14, k);
    const atr = mean(p14.map((x, j) => { const pc = j ? p14[j - 1][5] : x[1]; return Math.max(x[3], pc) - Math.min(x[4], pc); })) / y[5];
    if (!(atr > 0)) continue;
    const gap = r[2] / r[1] - 1, yRet = y[5] / y[1] - 1;
    let big5 = 0, up5 = 0; for (let j = k - 6; j < k - 1; j++) { const m = R[j][5] / R[j][1] - 1; if (m <= -0.045) big5++; if (m >= 0.045) up5++; }
    let upS = 0; for (let j = k - 1; j > k - 15 && R[j][5] > R[j][1]; j--) upS++;
    let dnS = 0; for (let j = k - 1; j > k - 15 && R[j][5] < R[j][1]; j--) dnS++;
    const yr = R.slice(Math.max(0, k - 250), k); let hi = -Infinity, lo = Infinity; for (const x of yr) { if (x[3] > hi) hi = x[3]; if (x[4] < lo) lo = x[4]; }
    let h20 = -Infinity, l20 = Infinity; for (let j = k - 20; j < k; j++) { if (R[j][3] > h20) h20 = R[j][3]; if (R[j][4] < l20) l20 = R[j][4]; }
    const rngs = R.slice(k - 7, k).map((x) => x[3] - x[4]); const yRng = y[3] - y[4];
    const vol20 = (ts[k - 1] - ts[k - 21]) / 20, vol5 = (ts[k] - ts[k - 5]) / 5;
    const results = resultsOn[i].has(s);
    const f = {
      gap, gapAtr: gap / atr, relGap: gap - mGap[i], yRet, y2Ret: R[k - 2][5] / R[k - 2][1] - 1,
      ret5: y[5] / R[k - 6][5] - 1, ret20: y[5] / R[k - 21][5] - 1, ret60: y[5] / R[k - 60][5] - 1, big5, up5, upStreak: upS, downStreak: dnS,
      fromHigh: y[5] / hi - 1, fromLow: y[5] / lo - 1, vsMa20: y[5] / maC(k, 20) - 1, vsMa50: y[5] / maC(k, 50) - 1, vsMa200: k >= 200 ? y[5] / maC(k, 200) - 1 : NaN,
      atr, yRangeAtr: yRng / y[5] / atr, nr7: yRng <= Math.min(...rngs) ? 1 : 0, closeLoc: yRng > 0 ? (y[5] - y[4]) / yRng : 0.5,
      volSpike: vol20 > 0 ? (y[6] ?? 0) / vol20 : NaN, vol5: vol20 > 0 ? vol5 / vol20 : NaN, deliv: y[7] ?? NaN, cr, price: r[1], results: results ? 1 : 0,
      yUpperCkt: yRng > 0 && y[5] === y[3] && yRet >= 0.045 ? 1 : 0, yLowerCkt: yRng > 0 && y[5] === y[4] && yRet <= -0.045 ? 1 : 0,
      open20High: r[2] > h20 ? 1 : 0, open20Low: r[2] < l20 ? 1 : 0,
      mGap: mGap[i], mYday: mYday[i] ?? NaN, fallers: fallers[i], risers: risers[i], dow: new Date(d + 'T00:00:00Z').getUTCDay(),
    };
    for (const k2 of FEAT) X[k2].push(f[k2]);
    const o = r[2], h = r[3], l = r[4], c = r[5];
    L.push((l <= o * 0.97 ? -0.03 : h >= o * 1.07 ? 0.07 : c / o - 1) - COST);
    S.push((h >= o * 1.03 ? -0.03 : l <= o * 0.93 ? 0.07 : -(c / o - 1)) - COST);
    OC.push(c / o - 1);
    // our strategy families (candidate sets, before the top-3 cut)
    let fam = 0;
    const bounce = !results && yRet <= -0.03 && gap <= -0.02 && gap > -0.0495;
    if (bounce) fam |= 1;
    if (bounce && yRet > -0.08 && big5 >= 1) fam |= 2;
    if (results && gap >= 0.05 && gap < 0.2 && cr >= 5) {
      const q = funda[s]?.q, T = targetQuarter(d), pat = (x) => q?.[x]?.pat;
      if (q && pat(T) != null && pat(T - 1) > 0 && pat(T - 4) != null) {
        const qoq = pat(T) / pat(T - 1) - 1, yoy = pat(T - 4) > 0 ? pat(T) / pat(T - 4) - 1 : (pat(T) > pat(T - 4) ? 1 : -1);
        if (qoq > 0 && yoy > 0) fam |= 4;
      }
    }
    if (mGap[i] <= -0.012 && gap <= -0.03 && gap > -0.0495 && cr >= 20 && !results) fam |= 8;
    famA.push(fam); sym.push(si); dayI.push(i); per.push(perOf(d)); crA.push(cr);
  }
}
const N = L.length;
P(`Stock-days: ${N.toLocaleString()} (${mk.days[dayI.reduce((a, b) => Math.min(a, b))]} .. ${mk.days[dayI.reduce((a, b) => Math.max(a, b))]}), costs ${COST * 100}%`);
P(`Buy at open & hold (stop 3% / target 7%): avg ${pct(mean(L))} | short at open: avg ${pct(mean(S))} | winners (close 5%+ above open) ${pct(OC.filter((v) => v >= 0.05).length / N, 1)} of stock-days, losers ${pct(OC.filter((v) => v <= -0.05).length / N, 1)}`);

// ---------- buckets (cut points from TRAIN only) ----------
const isTrain = (j) => per[j] <= 2;
const CUTS = {}, B = {};
for (const f of FEAT) {
  if (BOOL.has(f)) CUTS[f] = [0.5];
  else if (f === 'dow') CUTS[f] = [1.5, 2.5, 3.5, 4.5];
  else {
    const v = []; for (let j = 0; j < N; j += 3) if (isTrain(j) && Number.isFinite(X[f][j])) v.push(X[f][j]);
    v.sort((a, b) => a - b);
    CUTS[f] = [...new Set([0.2, 0.4, 0.6, 0.8].map((q) => v[Math.floor(q * v.length)]))];
  }
  const cuts = CUTS[f], b = new Uint8Array(N);
  for (let j = 0; j < N; j++) { const x = X[f][j]; if (!Number.isFinite(x)) { b[j] = 255; continue; } let n = 0; for (const c of cuts) if (x > c) n++; b[j] = n; }
  B[f] = b;
}
const fv = (f, v) => (PCTF.has(f) ? `${+(v * 100).toFixed(1)}%` : f === 'cr' || f === 'price' ? `${+v.toFixed(v < 10 ? 1 : 0)}` : `${+v.toFixed(2)}`);
const label = (f, b) => {
  if (BOOL.has(f)) return b ? 'yes' : 'no';
  if (f === 'dow') return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'][b];
  const c = CUTS[f];
  return b === 0 ? `<=${fv(f, c[0])}` : b === c.length ? `>${fv(f, c.at(-1))}` : `${fv(f, c[b - 1])}..${fv(f, c[b])}`;
};

// ---------- PART A: anatomy - each fact alone ----------
P('\n=========== PART A: WHAT WINNERS AND LOSERS HAVE IN COMMON (each fact alone) ===========');
P('"win%" = share of stock-days that closed 5%+ above the open, "lose%" = 5%+ below. Base rates first.');
const baseW = OC.filter((v) => v >= 0.05).length / N, baseL = OC.filter((v) => v <= -0.05).length / N;
P(`BASE: win ${pct(baseW, 1)} lose ${pct(baseL, 1)} | long avg ${pct(mean(L))} | short avg ${pct(mean(S))}`);
for (const f of FEAT) {
  const nb = CUTS[f].length + 1; const acc = Array.from({ length: nb }, () => ({ n: 0, w: 0, l: 0, sL: 0, sS: 0, trL: 0, trN: 0, teL: 0, teN: 0, trS: 0, teS: 0 }));
  for (let j = 0; j < N; j++) { const b = B[f][j]; if (b === 255) continue; const a = acc[b]; a.n++; if (OC[j] >= 0.05) a.w++; if (OC[j] <= -0.05) a.l++; a.sL += L[j]; a.sS += S[j]; if (per[j] <= 2) { a.trN++; a.trL += L[j]; a.trS += S[j]; } else { a.teN++; a.teL += L[j]; a.teS += S[j]; } }
  P(`  ${NAME[f]}:`);
  for (const [b, a] of acc.entries()) if (a.n) P(`    ${label(f, b).padEnd(16)} ${String(a.n).padStart(7)} | win ${pct(a.w / a.n, 1).padStart(6)} lose ${pct(a.l / a.n, 1).padStart(6)} (x${(a.w / a.n / baseW).toFixed(1)} / x${(a.l / a.n / baseL).toFixed(1)}) | LONG train ${pct(a.trL / a.trN)} test ${pct(a.teL / a.teN)} | SHORT train ${pct(a.trS / a.trN)} test ${pct(a.teS / a.teN)}`);
}

// ---------- PART B: search pairs of facts on TRAIN, judge on TEST ----------
P('\n=========== PART B: NEW SETUP SEARCH (two facts together) ===========');
P('Chosen on train (Mar 2024 - Jun 2025): 60+ trades, every train half-year positive, avg +0.7%+. Then judged on test (Jul 2025 - Nov 2026).');
const NB = FEAT.map((f) => CUTS[f].length + 1), MAXB = Math.max(...NB);
const pairs = []; for (let a = 0; a < FEAT.length; a++) for (let b = a; b < FEAT.length; b++) pairs.push([a, b]);
const CELLS = MAXB * MAXB;
const cnt = new Float64Array(pairs.length * CELLS * 6), sL = new Float64Array(pairs.length * CELLS * 6), sS = new Float64Array(pairs.length * CELLS * 6);
const Bs = FEAT.map((f) => B[f]);
for (let j = 0; j < N; j++) {
  const p6 = per[j], l = L[j], s = S[j];
  for (let q = 0; q < pairs.length; q++) {
    const [a, b] = pairs[q], ba = Bs[a][j], bb = Bs[b][j]; if (ba === 255 || bb === 255) continue;
    if (a === b && ba !== bb) continue;
    const idx = ((q * CELLS) + ba * MAXB + bb) * 6 + p6;
    cnt[idx]++; sL[idx] += l; sS[idx] += s;
  }
}
const cands = [];
for (let q = 0; q < pairs.length; q++) {
  const [a, b] = pairs[q];
  for (let ba = 0; ba < NB[a]; ba++) for (let bb = 0; bb < NB[b]; bb++) {
    if (a === b && ba !== bb) continue;
    const base = (q * CELLS + ba * MAXB + bb) * 6;
    for (const side of ['LONG', 'SHORT']) {
      const sum = side === 'LONG' ? sL : sS;
      const n = (ps) => ps.reduce((t, p) => t + cnt[base + p], 0), m = (ps) => ps.reduce((t, p) => t + sum[base + p], 0) / n(ps);
      const trN = n(TRAIN); if (trN < 60) continue;
      const trM = m(TRAIN); if (trM < 0.007) continue;
      if (!TRAIN.every((p) => cnt[base + p] >= 10 && sum[base + p] / cnt[base + p] > 0)) continue;
      const teN = n(TEST), teM = teN ? m(TEST) : NaN;
      const tePer = TEST.map((p) => (cnt[base + p] >= 5 ? sum[base + p] / cnt[base + p] : null));
      const pass = teN >= 30 && teM >= 0.005 && tePer.filter((v) => v != null && v > 0).length >= 2;
      cands.push({ side, a, b, ba, bb, trN, trM, teN, teM, tePer, trPer: TRAIN.map((p) => sum[base + p] / cnt[base + p]), pass });
    }
  }
}
const passN = cands.filter((c) => c.pass).length;
P(`Setups that passed the train filter: ${cands.length} | of those, also good on unseen test data: ${passN} (${pct(passN / Math.max(1, cands.length), 0)})`);
const desc = (c) => (c.a === c.b ? `${NAME[FEAT[c.a]]} ${label(FEAT[c.a], c.ba)}` : `${NAME[FEAT[c.a]]} ${label(FEAT[c.a], c.ba)} & ${NAME[FEAT[c.b]]} ${label(FEAT[c.b], c.bb)}`);
for (const side of ['LONG', 'SHORT']) {
  const list = cands.filter((c) => c.side === side).sort((x, y) => (y.pass - x.pass) || (Math.min(y.trM, y.teM) - Math.min(x.trM, x.teM)));
  P(`\n  ${side} - best by the weaker of train/test (PASS = held up on unseen data), top 45:`);
  for (const c of list.slice(0, 45)) P(`    ${c.pass ? 'PASS' : '    '} ${desc(c).padEnd(78)} train ${String(c.trN).padStart(5)} ${pct(c.trM)} | test ${String(c.teN).padStart(5)} ${pct(c.teM)} (${c.tePer.map((v) => pct(v, 1)).join(' ')})`);
}

// ---------- PART C: re-check the survivors like a real strategy ----------
P('\n=========== PART C: SURVIVORS AS A REAL STRATEGY (top 3 most traded a day, hourly bars 2025-26) ===========');
const hourly = read('hourly.json');
const hourSim = (j, side) => {
  const s = syms[sym[j]], d = mk.days[dayI[j]], R = mk.stocks[s], r = R.find((x) => x[0] === dayI[j]);
  const b = hourly[s]?.[d]; const last = b?.filter((x) => x[0] < 1530).at(-1); if (!last || !r) return null;
  const sc = r[5] / last[4], o = r[2];
  const H = b.filter((x) => x[0] < 1520).map(([t, a, h, l, c]) => [t, a * sc, h * sc, l * sc, c * sc]);
  if (side === 'LONG') { for (const [n, x] of H.entries()) { if (x[3] <= o * 0.97) return (n ? Math.min(o * 0.97, x[1]) : o * 0.97) / o - 1 - COST; if (x[2] >= o * 1.07) return 0.07 - COST; } return H.at(-1)[4] / o - 1 - COST; }
  for (const [n, x] of H.entries()) { if (x[2] >= o * 1.03) return -((n ? Math.max(o * 1.03, x[1]) : o * 1.03) / o - 1) - COST; if (x[3] <= o * 0.93) return 0.07 - COST; } return -(H.at(-1)[4] / o - 1) - COST;
};
const survivors = cands.filter((c) => c.pass).sort((x, y) => Math.min(y.trM, y.teM) - Math.min(x.trM, x.teM));
// drop near-duplicates: keep a survivor only if under 70% of its trades are already in a kept one
const kept = [];
for (const c of survivors) {
  const fa = FEAT[c.a], fb = FEAT[c.b];
  const idx = []; for (let j = 0; j < N; j++) if (B[fa][j] === c.ba && B[fb][j] === c.bb) idx.push(j);
  const set = new Set(idx);
  if (kept.some((k) => { let o = 0; for (const j of k.idx) if (set.has(j)) o++; return o / Math.min(k.idx.length, idx.length) > 0.7; })) continue;
  kept.push({ c, idx }); if (kept.length >= 25) break;
}
const ourName = (fam) => [fam & 2 ? 'Bounce(new rule)' : fam & 1 ? 'Bounce' : null, fam & 4 ? 'Gap&Go' : null, fam & 8 ? 'Panic' : null].filter(Boolean).join('+') || 'new';
for (const { c, idx } of kept) {
  const byD = new Map(); for (const j of idx) (byD.get(dayI[j]) ?? byD.set(dayI[j], []).get(dayI[j])).push(j);
  const t = [...byD.values()].flatMap((l) => l.sort((x, y) => crA[y] - crA[x]).slice(0, 3));
  const ret = (j) => (c.side === 'LONG' ? L[j] : S[j]);
  const perM = PER.map((_, p) => { const a = t.filter((j) => per[j] === p); return a.length >= 5 ? pct(mean(a.map(ret)), 1) : '  -  '; });
  const hs = t.filter((j) => mk.days[dayI[j]] >= '2025-01-01').map((j) => hourSim(j, c.side)).filter((v) => v != null);
  const last6 = t.filter((j) => mk.days[dayI[j]] >= '2026-05-20');
  const ours = t.filter((j) => famA[j]).length;
  P(`\n  ${c.side} ${desc(c)}`);
  P(`     ${t.length} trades on ${byD.size} days (~${(t.length / 32).toFixed(1)}/month, last 6 months ${last6.length}) | daily-bar avg ${pct(mean(t.map(ret)))} won ${pct(t.filter((j) => ret(j) > 0).length / t.length, 0)} | hourly (2025-26, ${hs.length} tr) ${pct(mean(hs))} | last 6m ${pct(mean(last6.map(ret)))}`);
  P(`     by half-year: ${PER.map((p, k) => `${p} ${perM[k]}`).join(' | ')} | already one of our strategies: ${pct(ours / t.length, 0)}`);
  P(`     examples: ${t.slice(-4).map((j) => `${mk.days[dayI[j]]} ${syms[sym[j]]} ${pct(ret(j), 1)}`).join(', ')}`);
}

// ---------- PART D: what our strategies catch ----------
P('\n=========== PART D: DAILY WINNERS vs OUR STRATEGIES ===========');
const days = new Map(); for (let j = 0; j < N; j++) (days.get(dayI[j]) ?? days.set(dayI[j], []).get(dayI[j])).push(j);
const W = [], Lo = []; for (let j = 0; j < N; j++) { if (OC[j] >= 0.05) W.push(j); if (OC[j] <= -0.05) Lo.push(j); }
P(`Average day: ${(W.length / days.size).toFixed(0)} stocks close 5%+ above their open, ${(Lo.length / days.size).toFixed(0)} close 5%+ below (Rs 1 cr+ companies).`);
const famShare = (list, bit) => list.filter((j) => famA[j] & bit).length;
for (const [nm, bit] of [['Bounce-back (any)', 1], ['Bounce-back new rule', 2], ['Gap & Go', 4], ['Panic', 8]]) {
  const all = []; for (let j = 0; j < N; j++) if (famA[j] & bit) all.push(j);
  P(`  ${nm.padEnd(22)} candidates ${String(all.length).padStart(5)} | became big WINNERS ${pct(famShare(W, bit) / all.length, 1)} vs big LOSERS ${pct(famShare(Lo, bit) / all.length, 1)} | share of all daily winners caught: ${pct(famShare(W, bit) / W.length, 1)}`);
}
P('\n  Where do the daily winners come from? (their 9:15 picture)');
const groups = [
  ['gap up 5%+ WITH results', (j) => X.gap[j] >= 0.05 && X.results[j]],
  ['gap up 5%+ no results', (j) => X.gap[j] >= 0.05 && !X.results[j]],
  ['gap up 2-5%', (j) => X.gap[j] >= 0.02 && X.gap[j] < 0.05],
  ['flat open (-2..+2%)', (j) => X.gap[j] > -0.02 && X.gap[j] < 0.02],
  ['gap down 2%+', (j) => X.gap[j] <= -0.02],
];
for (const [nm, f] of groups) {
  const w = W.filter(f), l = Lo.filter(f); let all = 0, sl = 0; for (let j = 0; j < N; j++) if (f(j)) { all++; sl += L[j]; }
  P(`    ${nm.padEnd(26)} ${pct(w.length / W.length, 0).padStart(5)} of all winners | in this group: ${pct(w.length / all, 1)} win vs ${pct(l.length / all, 1)} lose | buying all of them: ${pct(sl / all)}`);
}
const flat = W.filter((j) => X.gap[j] > -0.02 && X.gap[j] < 0.02);
P(`  -> ${pct(flat.length / W.length, 0)} of winners opened flat: at 9:15 they look like thousands of other stocks. That part is luck/news during the day.`);
fs.writeFileSync(new URL('daily-winners-survivors.json', DIR), JSON.stringify(kept.map(({ c, idx }) => ({ side: c.side, setup: desc(c), f: [FEAT[c.a], FEAT[c.b]], b: [c.ba, c.bb], cuts: [CUTS[FEAT[c.a]], CUTS[FEAT[c.b]]], n: idx.length }))));
