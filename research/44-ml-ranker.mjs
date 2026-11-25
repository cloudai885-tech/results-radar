// Step 44: "smart ranker" - one model that looks at ALL morning clues together and picks the top 1-3 stocks a day.
// Every stock-morning Jan 2021 - Nov 2026 (price Rs 1+, Rs 1 cr+/day, no T2T/ETF) gets ~33 clues known before 9:15
// (gap, yesterday, trend, volume, delivery, 52w distance, circuit room, results news, market mood, VIX, Nifty trend).
// A gradient-boosted tree model (written here, no libraries) learns "buy at the open -> result by the close".
// WALK-FORWARD: for each test year it is trained ONLY on earlier years, then picks the top 1-3 each day of that year.
// Trades judged on daily bars, stop counted first, 0.4% costs, locked lower circuit = sold at the next open.
//   node --max-old-space-size=7000 research/44-ml-ranker.mjs
import fs from 'node:fs';
import { etfList, fetchCached, mapPool, priceBands } from '../src/sources.mjs';

const DIR = new URL('../data/research/', import.meta.url);
const read = (f) => JSON.parse(fs.readFileSync(new URL(f, DIR), 'utf8'));
const out = []; const P = (...a) => { const l = a.join(' '); console.log(l); out.push(l); };
const pct = (v, d = 2) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : '-');
const median = (a) => { if (!a.length) return NaN; const s = Float64Array.from(a).sort(); return s[s.length >> 1]; };
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const COST = 0.004;

const mk = read('market-2021.json'), idx = read('index-2020.json');
const ETFS = await etfList(), BANDS = await priceBands();
const NOT_STOCK = /ETF|BEES|IETF|ADD$|^LIQUID|^GILT|^MON100|^MAFANG|^HNGSNG|^NIFTY|^SENSEX|^GOLD|^SILVER|CASE$|^MOM|^MID150/;
const ND = mk.days.length;

// results filed after yesterday 15:30 and before today 09:00; "unknown" where we have no announcement data
const newsDays = new Set(), resultsOn = mk.days.map(() => new Set());
{
  const items = [];
  for (const f of ['news-2021.json', 'news.json']) { const n = read(f); Object.keys(n.days).forEach((d) => newsDays.add(d)); for (const x of n.items) if (x.cat === 'result') items.push(x); }
  for (const e of items) {
    const [d, t = '00:00'] = e.time.split(' ');
    const i = mk.days.findIndex((x) => x > d || (x === d && t < '09:00'));
    if (i < 1 || (mk.days[i] === d && t >= '09:00')) continue;
    const pd = mk.days[i - 1]; if (d < pd || (d === pd && t < '15:30')) continue;
    resultsOn[i].add(e.symbol);
  }
}
const covered = mk.days.map((d, i) => i > 0 && newsDays.has(d) && newsDays.has(mk.days[i - 1]));

// yesterday's NSE series (T2T = BE cannot be sold the same day)
const series = new Map();
await mapPool([...Array(ND).keys()].filter((i) => i > 0 && mk.days[i] >= '2021-01-01'), 6, async (i) => {
  const [Y, M, D] = mk.days[i - 1].split('-');
  const csv = await fetchCached(`https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${D}${M}${Y}.csv`, { ttlHours: 1e7, attempts: 1 }).catch(() => null);
  if (!csv?.startsWith('SYMBOL')) return;
  const m = new Set(); for (const line of csv.split('\n').slice(1)) { const p = line.split(','); if (p[1]?.trim() === 'BE') m.add(p[0].trim()); }
  series.set(i, m);
});

// ---- market-wide numbers per day ----
const gapsByDay = mk.days.map(() => []), ret5ByDay = mk.days.map(() => []), above50 = new Float64Array(ND), tot50 = new Float64Array(ND);
for (const R of Object.values(mk.stocks)) {
  let s50 = 0;
  for (let k = 0; k < R.length; k++) {
    const r = R[k]; s50 += r[5]; if (k >= 50) s50 -= R[k - 50][5];
    if ((r[6] ?? 0) >= 2 && r[2] !== r[1]) gapsByDay[r[0]].push(r[2] / r[1] - 1);
    if (k >= 5 && (r[6] ?? 0) >= 2) ret5ByDay[r[0]].push(r[5] / R[k - 5][5] - 1);
    if (k >= 49 && (r[6] ?? 0) >= 5) { tot50[r[0]]++; if (r[5] > s50 / 50) above50[r[0]]++; }
  }
}
const mGap = gapsByDay.map((g) => (g.length > 150 ? median(g) : NaN));
const mRet5 = ret5ByDay.map((g) => (g.length > 150 ? median(g) : NaN));
const breadth = [...above50].map((a, i) => (tot50[i] > 100 ? a / tot50[i] : NaN));
const nifty = idx['^NSEI'], vixM = new Map(idx['^INDIAVIX']);
function niftyInfo(d) { // as of the close BEFORE day d
  let k = nifty.findIndex(([x]) => x >= d) - 1; if (k < 0) k = nifty.length - 1;
  const c = nifty[k][1], m200 = k >= 199 ? mean(nifty.slice(k - 199, k + 1).map((x) => x[1])) : NaN;
  const v = vixM.get(nifty[k][0]), v5 = vixM.get(nifty[Math.max(0, k - 5)][0]);
  return { n200: c / m200 - 1, vix: v ?? NaN, vixChg: v && v5 ? v / v5 - 1 : NaN };
}
const NI = mk.days.map((d) => niftyInfo(d));

// ---- rows ----
const FEAT = ['gap', 'relGap', 'mktGap', 'yRet', 'yPos', 'yBody', 'ret5', 'ret20', 'ret60', 'd52h', 'd52l', 'atr', 'volRatio', 'logCr', 'deliv', 'delivChg',
  'big5', 'up10', 'gapAtr', 'sma20', 'sma50', 'breadth', 'mktRet5', 'vix', 'vixChg', 'nifty200', 'results', 'band', 'roomDown', 'dow', 'logPrice', 'y2Ret', 'gapInYRange'];
const NF = FEAT.length;
const START = mk.days.findIndex((d) => d >= '2021-03-01');
const cols = FEAT.map(() => []), lab = [], meta = [];
for (const [s, R] of Object.entries(mk.stocks)) {
  if (ETFS.has(s) || NOT_STOCK.test(s)) continue;
  const band = BANDS.has(s) ? BANDS.get(s) : undefined;
  // rolling 250-day high/low of the previous days via simple block scan (cheap enough per stock)
  for (let k = 61; k < R.length; k++) {
    const r = R[k], y = R[k - 1], i = r[0];
    if (i < START || y[0] !== i - 1 || !(r[1] >= 1) || !(r[2] > 0) || Number.isNaN(mGap[i])) continue;
    if (series.get(i)?.has(s)) continue;
    const t20 = R.slice(k - 20, k).map((x) => x[6] ?? 0), cr = median(t20); if (!(cr >= 1)) continue;
    const pc = r[1], o = r[2];
    const up = band != null ? pc * (1 + band) : Infinity, lo = band != null ? pc * (1 - band) : 0;
    if (o >= up * 0.999 || o <= lo * 1.001) continue; // opens locked at a circuit: cannot trade normally
    let hh = 0, ll = Infinity; for (let j = Math.max(0, k - 250); j < k; j++) { if (R[j][3] > hh) hh = R[j][3]; if (R[j][4] < ll) ll = R[j][4]; }
    let tr = 0; for (let j = k - 14; j < k; j++) { const pcj = R[j - 1][5]; tr += Math.max(R[j][3], pcj) - Math.min(R[j][4], pcj); }
    const atr = tr / 14 / y[5];
    let s20 = 0, s50 = 0; for (let j = k - 50; j < k; j++) { s50 += R[j][5]; if (j >= k - 20) s20 += R[j][5]; }
    let big5 = 0; for (let j = k - 6; j < k - 1; j++) if (R[j][5] / R[j][1] - 1 <= -0.045) big5++;
    let up10 = 0; for (let j = k - 10; j < k; j++) if (R[j][5] > R[j][1]) up10++;
    const dl = R.slice(k - 20, k).map((x) => x[7]).filter((v) => v != null);
    const gap = o / pc - 1;
    const f = [gap, gap - mGap[i], mGap[i], y[5] / y[1] - 1, y[3] > y[4] ? (y[5] - y[4]) / (y[3] - y[4]) : NaN, y[5] / y[2] - 1,
      y[5] / R[k - 6][5] - 1, y[5] / R[k - 21][5] - 1, y[5] / R[k - 61][5] - 1, y[5] / hh - 1, y[5] / ll - 1, atr, (y[6] ?? 0) / cr, Math.log(cr),
      y[7] ?? NaN, y[7] != null && dl.length ? y[7] - mean(dl) : NaN, big5, up10, gap / atr, y[5] / (s20 / 20) - 1, y[5] / (s50 / 50) - 1,
      breadth[i - 1], mRet5[i - 1], NI[i].vix, NI[i].vixChg, NI[i].n200, covered[i] ? (resultsOn[i].has(s) ? 1 : 0) : NaN,
      band === undefined ? NaN : band == null ? 1 : band, band ? 1 - lo / o : 0.5, new Date(mk.days[i] + 'T00:00:00Z').getUTCDay(), Math.log(pc),
      R[k - 2][0] === i - 2 ? R[k - 1][1] / R[k - 2][1] - 1 : NaN, y[3] > y[4] ? (o - y[4]) / (y[3] - y[4]) : NaN];
    if (process.env.NOBAND) { f[27] = NaN; f[28] = NaN; } // leakage check: today's circuit band is unknown for past years
    for (let j = 0; j < NF; j++) cols[j].push(Number.isFinite(f[j]) ? f[j] : NaN);
    lab.push(Math.max(-0.1, Math.min(0.1, r[5] / o - 1)) - COST);
    const nx = R[k + 1]?.[0] === i + 1 ? R[k + 1][2] : NaN;
    meta.push([i, s, pc, o, r[3], r[4], r[5], band ?? null, nx, cr]);
  }
}
const N = lab.length;
P(`RESEARCH 44 - SMART RANKER. ${N.toLocaleString()} stock-mornings, ${mk.days[START]} .. ${mk.days.at(-1)}, ${NF} clues each.`);

// ---- bin every feature into 64 buckets (0 = missing) ----
const X = cols.map((c) => {
  const v = c.filter((x) => !Number.isNaN(x)); const smp = []; for (let j = 0; j < v.length; j += Math.max(1, Math.floor(v.length / 200000))) smp.push(v[j]);
  smp.sort((a, b) => a - b); const th = []; for (let q = 1; q < 64; q++) th.push(smp[Math.floor((q / 64) * (smp.length - 1))]);
  const b = new Uint8Array(N);
  for (let r = 0; r < N; r++) { const x = c[r]; if (Number.isNaN(x)) { b[r] = 0; continue; } let lo = 0, hi = th.length; while (lo < hi) { const m = (lo + hi) >> 1; if (x > th[m]) lo = m + 1; else hi = m; } b[r] = lo + 1; }
  return b;
});
const Y = Float64Array.from(lab);
cols.length = 0;

// ---- gradient boosting (squared loss), level-wise trees on histograms ----
function train(rows, { trees = 250, depth = 4, lr = 0.05, minLeaf = 1500, sample = 200000, seed = 1 } = {}) {
  let rnd = seed; const rand = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
  const base = mean([...rows].map((r) => Y[r]));
  const pred = new Float64Array(N).fill(base); const model = { base, trees: [] }; const gainImp = new Float64Array(NF);
  const hs = new Float64Array(65), hc = new Float64Array(65);
  for (let t = 0; t < trees; t++) {
    const frac = Math.min(1, sample / rows.length);
    let nodeRows = [[]]; for (const r of rows) if (rand() < frac) nodeRows[0].push(r);
    const tree = []; // node: [feat, thr, left, right] or [-1, value]
    let level = [{ id: 0, rows: nodeRows[0] }]; tree.push(null);
    for (let dpt = 0; dpt <= depth; dpt++) {
      const next = [];
      for (const nd of level) {
        const rs = nd.rows; let S = 0; for (const r of rs) S += Y[r] - pred[r]; const n = rs.length;
        let best = null;
        if (dpt < depth && n >= 2 * minLeaf) {
          const parent = (S * S) / n;
          for (let f = 0; f < NF; f++) {
            hs.fill(0); hc.fill(0); const xb = X[f];
            for (const r of rs) { const b = xb[r]; hs[b] += Y[r] - pred[r]; hc[b]++; }
            let sl = 0, cl = 0;
            for (let b = 0; b < 64; b++) {
              sl += hs[b]; cl += hc[b]; const cr2 = n - cl;
              if (cl < minLeaf || cr2 < minLeaf) continue;
              const g = (sl * sl) / cl + ((S - sl) * (S - sl)) / cr2 - parent;
              if (!best || g > best.g) best = { g, f, b };
            }
          }
        }
        if (best && best.g > 0) {
          gainImp[best.f] += best.g;
          const L = [], Rr = []; const xb = X[best.f]; for (const r of rs) (xb[r] <= best.b ? L : Rr).push(r);
          const li = tree.push(null) - 1, ri = tree.push(null) - 1;
          tree[nd.id] = [best.f, best.b, li, ri];
          next.push({ id: li, rows: L }, { id: ri, rows: Rr });
        } else tree[nd.id] = [-1, lr * (n ? S / n : 0)];
      }
      level = next;
      if (!level.length) break;
    }
    model.trees.push(tree);
    for (const r of rows) pred[r] += leaf(tree, r);
  }
  model.imp = gainImp;
  return model;
}
function leaf(tree, r) { let n = tree[0]; while (n[0] >= 0) n = tree[X[n[0]][r] <= n[1] ? n[2] : n[3]]; return n[1]; }
const predict = (m, r) => { let v = m.base; for (const t of m.trees) v += leaf(t, r); return v; };

// ---- trade one pick: daily bars, stop first, locked lower circuit sold next open ----
function tradeRet(r, stop, tgt) {
  const [, , pc, o, h, l, c, band, nx] = meta[r];
  const lo = band ? pc * (1 - band) : 0;
  if (band && c <= lo * 1.001 && l <= lo * 1.001) return (Number.isFinite(nx) ? nx / o - 1 : c / o - 1) - COST;
  if (stop && l <= o * (1 - stop)) return -stop - COST;
  if (tgt && h >= o * (1 + tgt)) return tgt - COST;
  return c / o - 1 - COST;
}

// ---- walk-forward ----
const yearOf = (r) => mk.days[meta[r][0]].slice(0, 4);
const TEST = ['2023', '2024', '2025', '2026'];
const picks = []; // {r, y, score, rank}
const imp = new Float64Array(NF);
for (const ty of TEST) {
  const trainRows = [], testRows = [];
  for (let r = 0; r < N; r++) { const y = yearOf(r); if (y < ty) trainRows.push(r); else if (y === ty) testRows.push(r); }
  const t0 = Date.now();
  const m = train(trainRows);
  m.imp.forEach((v, j) => (imp[j] += v));
  const byDay = new Map();
  for (const r of testRows) { const room = X[FEAT.indexOf('roomDown')][r]; (byDay.get(meta[r][0]) ?? byDay.set(meta[r][0], []).get(meta[r][0])).push({ r, score: predict(m, r) }); }
  for (const [d, l] of byDay) {
    const ok = l.filter(({ r }) => { const [, , pc, o, , , , band] = meta[r]; return !band || 1 - pc * (1 - band) / o >= 0.03; });
    ok.sort((a, b) => b.score - a.score);
    ok.slice(0, 10).forEach((x, k) => picks.push({ ...x, d, y: ty, rank: k }));
    // daily score distribution for thresholds
  }
  P(`  trained for ${ty} on ${trainRows.length.toLocaleString()} rows (${((Date.now() - t0) / 1000).toFixed(0)} s), tested on ${testRows.length.toLocaleString()} rows / ${byDay.size} days`);
}

// ---- report ----
const EXITS = [['hold to 3:20', 0, 0], ['stop 2% / target 4%', 0.02, 0.04], ['stop 3% / target 7%', 0.03, 0.07]];
function evalSet(sel, stop, tgt) {
  const days = new Map(); for (const p of sel) (days.get(p.d) ?? days.set(p.d, []).get(p.d)).push(tradeRet(p.r, stop, tgt));
  const tr = [...days.values()].flat(), dr = [...days.values()].map(mean);
  let eq = 1, pk = 1, dd = 0; for (const v of dr) { eq *= 1 + v; pk = Math.max(pk, eq); dd = Math.min(dd, eq / pk - 1); }
  return { n: tr.length, d: days.size, avg: mean(tr), won: tr.filter((v) => v > 0).length / tr.length, day: mean(dr), green: dr.filter((v) => v > 0).length / dr.length, dd };
}
const line = (lab2, s) => `${lab2.padEnd(44)} ${String(s.n).padStart(5)} tr ${String(s.d).padStart(4)} d | trade ${pct(s.avg).padStart(7)} won ${pct(s.won, 0).padStart(4)} | day ${pct(s.day).padStart(7)} green ${pct(s.green, 0).padStart(4)} | drop ${pct(s.dd, 0)}`;
const testDays = new Set(picks.map((p) => p.d)).size;
P(`\nTest days: ${testDays} (2023 - Nov 2026, never seen in training). Baseline = every stock in the pool, bought at the open.`);
for (const [en, st, tg] of EXITS) {
  P(`\n== EXIT: ${en} ==`);
  for (const [nm, f] of [['TOP 1 per day', (p) => p.rank === 0], ['TOP 3 per day', (p) => p.rank < 3], ['ranks 4-10 (control)', (p) => p.rank >= 3]]) {
    P(line(nm, evalSet(picks.filter(f), st, tg)));
    if (nm !== 'ranks 4-10 (control)') for (const y of TEST) P(line(`   ${y}`, evalSet(picks.filter((p) => f(p) && p.y === y), st, tg)));
  }
  // confidence filter: only days where the top score is in the top 30% of all top-scores of that year's earlier days is not
  // possible without leakage, so use an absolute bar: model expects > 0 after costs
  for (const thr of [0, 0.002, 0.005]) P(line(`TOP 3, only if model expects > ${pct(thr, 1)}`, evalSet(picks.filter((p) => p.rank < 3 && p.score > thr), st, tg)));
}
// what does the model like?
P(`\n== WHAT THE MODEL USES (share of split gain) ==`);
const totImp = imp.reduce((a, b) => a + b, 0);
P('  ' + FEAT.map((f, j) => [f, imp[j] / totImp]).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([f, v]) => `${f} ${(v * 100).toFixed(1)}%`).join(' | '));
const top3 = picks.filter((p) => p.rank < 3);
const gi = FEAT.indexOf('gap');
const gapOf = (p) => meta[p.r][3] / meta[p.r][2] - 1;
P(`  TOP 3 picks: opened DOWN 2%+ ${pct(top3.filter((p) => gapOf(p) <= -0.02).length / top3.length, 0)}, flat (+-2%) ${pct(top3.filter((p) => Math.abs(gapOf(p)) < 0.02).length / top3.length, 0)}, UP 2%+ ${pct(top3.filter((p) => gapOf(p) >= 0.02).length / top3.length, 0)}; median price Rs ${median(top3.map((p) => meta[p.r][2])).toFixed(0)}, median turnover Rs ${median(top3.map((p) => meta[p.r][9])).toFixed(1)} cr`);
const flat = top3.filter((p) => Math.abs(gapOf(p)) < 0.02);
P(line('  TOP 3 that opened FLAT only (hold to 3:20)', evalSet(flat, 0, 0)));
fs.writeFileSync(new URL(`ml-ranker-report${process.env.NOBAND ? '-noband' : ''}.txt`, DIR), out.join('\n'));
fs.writeFileSync(new URL(`ml-ranker-picks${process.env.NOBAND ? '-noband' : ''}.json`, DIR), JSON.stringify(top3.map((p) => ({ d: mk.days[p.d], s: meta[p.r][1], rank: p.rank, score: p.score, gap: gapOf(p), ret: tradeRet(p.r, 0, 0) }))));
