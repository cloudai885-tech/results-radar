// Step 31: the same well-known strategies as step 30, on 5-MINUTE bars (the user: hourly bars may hide the real entry).
// Yahoo keeps 5-minute data for ~60 days only (data/research/intraday.json, Aug 19 - Nov 16 2026), so this is a short test:
// first half vs second half of those days. ORB uses the classic 15- and 30-minute ranges; VWAP is the real running VWAP.
// Exits by the 3:15 pm bar. Companies only, Rs 5 cr+, no T2T/ETF, max 3 a day (most traded first). Costs 0.4% (0.2% shown).
//   node --max-old-space-size=12000 research/31-known-strategies-5min.mjs
import fs from 'node:fs';
import { fetchCached, etfList } from '../src/sources.mjs';

const DIR = new URL('../data/research/', import.meta.url);
const read = (f) => JSON.parse(fs.readFileSync(new URL(f, DIR), 'utf8'));
const hourly = read('intraday.json'), mk = read('market.json');
const SPLIT = '2026-10-02', RECENT = '2026-10-02'; // second half of the 60 days
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (v, d = 2) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : '   -  ');
const D = mk.days, dayIdx = new Map(D.map((d, i) => [d, i]));
const ETFS = await etfList();

// T2T lists (series BE in the previous day's bhavcopy)
const beOn = new Map();
for (let i = 1; i < D.length; i++) {
  if (D[i] < '2026-08-01') continue;
  const [y, m, d] = D[i - 1].split('-');
  const csv = await fetchCached(`https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${d}${m}${y}.csv`, { ttlHours: 1e7, attempts: 1 }).catch(() => null);
  const set = new Set();
  if (csv?.startsWith('SYMBOL')) for (const line of csv.split(String.fromCharCode(10)).slice(1)) { const p = line.split(','); if (p[1]?.trim() === 'BE') set.add(p[0].trim()); }
  beOn.set(i, set);
}
// market mood each day: median opening gap of liquid stocks (from daily data)
const gapsByDay = D.map(() => []);
const daily = {};
for (const [s, rows] of Object.entries(mk.stocks)) {
  const at = new Map(); rows.forEach((r, k) => at.set(r[0], k)); daily[s] = { rows, at };
  for (let k = 20; k < rows.length; k++) { const cr = mean(rows.slice(k - 20, k).map((x) => x[6])); if (cr >= 5 && rows[k][1] > 0) gapsByDay[rows[k][0]].push(rows[k][2] / rows[k][1] - 1); }
}
const mktGap = gapsByDay.map((g) => (g.length > 200 ? median(g) : NaN));

// ---- walk the hourly bars after an entry ----
function walk(bars, j, px, stop, target, fillBar) {
  for (let i = j; i < bars.length; i++) {
    const b = bars[i];
    if (stop != null && b[3] <= stop) return (i > j ? Math.min(stop, b[1]) : stop) / px - 1; // a later bar opening below the stop fills at its open
    if (target != null && !(fillBar && i === j) && b[2] >= target) return target / px - 1;
  }
  return bars.at(-1)[4] / px - 1;
}
function walkShort(bars, j, px, stop, target, fillBar) {
  for (let i = j; i < bars.length; i++) {
    const b = bars[i];
    if (b[2] >= stop) return 1 - stop / px;
    if (target != null && !(fillBar && i === j) && b[3] <= target) return 1 - target / px;
  }
  return 1 - bars.at(-1)[4] / px;
}
const capStop = (px, s, maxPct) => Math.max(s, px * (1 - maxPct));

// ---- the strategies: each returns null (no trade) or the trade's return before costs ----
const S = {
  'ORB 15-min breakout (stop = range low, max -2%; target 2x risk)': (c) => {
    const n = 3, f = c.bars.slice(0, n); const hi = Math.max(...f.map((b) => b[2])), lo = Math.min(...f.map((b) => b[3]));
    const j = c.bars.findIndex((b, i) => i >= n && b[0] <= 1415 && (b[2] > hi)); if (j < 0) return null;
    const px = Math.max(hi, c.bars[j][1]), stop = capStop(px, lo, 0.02); return walk(c.bars, j, px, stop, px + 2 * (px - stop), true);
  },
  'ORB 30-min breakout (stop = range low, max -2%; target 2x risk)': (c) => {
    const n = 6, f = c.bars.slice(0, n); const hi = Math.max(...f.map((b) => b[2])), lo = Math.min(...f.map((b) => b[3]));
    const j = c.bars.findIndex((b, i) => i >= n && b[0] <= 1415 && (b[2] > hi)); if (j < 0) return null;
    const px = Math.max(hi, c.bars[j][1]), stop = capStop(px, lo, 0.02); return walk(c.bars, j, px, stop, px + 2 * (px - stop), true);
  },
  'ORB 15-min breakout SHORT (stop = range high, max +2%; target 2x risk)': (c) => {
    const n = 3, f = c.bars.slice(0, n); const hi = Math.max(...f.map((b) => b[2])), lo = Math.min(...f.map((b) => b[3]));
    const j = c.bars.findIndex((b, i) => i >= n && b[0] <= 1415 && (b[3] < lo)); if (j < 0) return null;
    const px = Math.min(lo, c.bars[j][1]), stop = Math.min(hi, px * 1.02); return walkShort(c.bars, j, px, stop, px - 2 * (stop - px), true);
  },
  'ORB 30-min + quiet day before (NR7) + green range + market not down': (c) => {
    const f = c.bars.slice(0, 6); if (!c.nr7 || !(f.at(-1)[4] > f[0][1]) || !(c.mkt >= 0)) return null;
    return S['ORB 30-min breakout (stop = range low, max -2%; target 2x risk)'](c);
  },
  'Previous-day high breakout (stop -1.5%, target +3%, else close)': (c) => {
    if (!(c.open < c.yH)) return null;
    const j = c.bars.findIndex((b) => b[2] > c.yH && b[0] <= 1415); if (j < 0) return null;
    const px = Math.max(c.yH, c.bars[j][1]); return walk(c.bars, j, px, px * 0.985, px * 1.03, true);
  },
  'Classic pivot: open between P and R1 -> buy open, target R1, stop S1 (max -2%)': (c) => {
    const P = (c.yH + c.yL + c.yC) / 3, R1 = 2 * P - c.yL, S1 = 2 * P - c.yH;
    if (!(c.open > P && c.open < R1)) return null;
    return walk(c.bars, 0, c.open, capStop(c.open, S1, 0.02), R1, false);
  },
  'Narrow CPR (< 0.3% wide) + open above it -> target R1, stop BC (max -2%)': (c) => {
    const P = (c.yH + c.yL + c.yC) / 3, BC = (c.yH + c.yL) / 2, TC = 2 * P - BC, top = Math.max(TC, BC), bot = Math.min(TC, BC), R1 = 2 * P - c.yL;
    if (!((top - bot) / P < 0.003 && c.open > top && c.open < R1)) return null;
    return walk(c.bars, 0, c.open, capStop(c.open, bot, 0.02), R1, false);
  },
  'Camarilla L3 bounce: buy at L3, stop L4, target H3 (else close)': (c) => {
    const r = c.yH - c.yL, L3 = c.yC - r * 1.1 / 4, L4 = c.yC - r * 1.1 / 2, H3 = c.yC + r * 1.1 / 4;
    if (!(c.open > L3)) return null;
    const j = c.bars.findIndex((b) => b[3] <= L3 && b[0] <= 1415); if (j < 0) return null;
    return walk(c.bars, j, L3, L4, H3, true);
  },
  'Gap fill: gap down 1-3% (no big fall yday) -> target yday close, stop -1.5%': (c) => {
    const g = c.open / c.yC - 1; if (!(g <= -0.01 && g > -0.03 && c.y1 > -0.03)) return null;
    return walk(c.bars, 0, c.open, c.open * 0.985, c.yC, false);
  },
  'NR7 / inside day -> buy yday-high breakout (stop yday low, max -2%; target 2x risk)': (c) => {
    if (!(c.nr7 || c.inside) || !(c.open < c.yH)) return null;
    const j = c.bars.findIndex((b) => b[2] > c.yH && b[0] <= 1415); if (j < 0) return null;
    const px = Math.max(c.yH, c.bars[j][1]), stop = capStop(px, c.yL, 0.02); return walk(c.bars, j, px, stop, px + 2 * (px - stop), true);
  },
  'RSI(2) < 10 and above 200-day avg (Connors) -> buy open, sell close (stop -3%)': (c) => {
    if (!(c.rsi2 < 10 && c.yC > c.sma200)) return null;
    return walk(c.bars, 0, c.open, c.open * 0.97, null, false);
  },
  'VWAP pullback: green first 15 min, later dips to VWAP and holds -> target +2%, stop -1%': (c) => {
    const f3 = c.bars.slice(0, 3); if (!(f3[2][4] > f3[0][1] && f3[2][4] > c.yC)) return null;
    let pv = 0, v = 0; for (const b of f3) { pv += ((b[2] + b[3] + b[4]) / 3) * b[5]; v += b[5]; }
    for (let i = 3; i < c.bars.length - 1; i++) {
      const b = c.bars[i], vwap = v > 0 ? pv / v : NaN;
      if (b[0] <= 1315 && b[3] <= vwap && b[4] > vwap) return walk(c.bars, i + 1, b[4], b[4] * 0.99, b[4] * 1.02, false);
      pv += ((b[2] + b[3] + b[4]) / 3) * b[5]; v += b[5];
    }
    return null;
  },
};

// ---- build stock-days ----
const days = new Map(); // d -> [{s, cr, ...}]
for (const [s, byDay] of Object.entries(hourly)) {
  if (ETFS.has(s)) continue;
  const dd = daily[s]; if (!dd) continue;
  const R = dd.rows, closes = R.map((r) => r[5]);
  for (let [d, bars] of Object.entries(byDay)) {
    const i = dayIdx.get(d); if (i == null || bars.length < 60 || bars[0][0] !== 915) continue;
    bars = bars.filter((b) => b[0] <= 1515);
    const ky = dd.at.get(i - 1); if (ky == null || ky < 200 || beOn.get(i)?.has(s)) continue;
    const y = R[ky], cr = mean(R.slice(ky - 19, ky + 1).map((x) => x[6])); if (!(cr >= 5)) continue;
    const rng = (r) => r[3] - r[4];
    let up = 0, dn = 0; for (let k = ky - 1; k <= ky; k++) { const ch = closes[k] - closes[k - 1]; if (ch > 0) up += ch; else dn -= ch; }
    const c = {
      s, d, cr, bars, open: bars[0][1], yH: y[3], yL: y[4], yC: y[5], y1: y[5] / y[1] - 1,
      nr7: rng(y) <= Math.min(...R.slice(ky - 6, ky).map(rng)), inside: y[3] <= R[ky - 1][3] && y[4] >= R[ky - 1][4],
      rsi2: up + dn > 0 ? (100 * up) / (up + dn) : 50, sma200: mean(closes.slice(ky - 199, ky + 1)), mkt: mktGap[i],
    };
    (days.get(d) ?? days.set(d, []).get(d)).push(c);
  }
}
const allDays = [...days.keys()].sort();
console.log(`${allDays.length} days ${allDays[0]}..${allDays.at(-1)}, ${[...days.values()].reduce((a, l) => a + l.length, 0)} stock-days (companies, Rs 5 cr+, no T2T/ETF).`);
const PER = [['Aug', '2026-08', '2026-09'], ['Sep', '2026-09', '2026-10'], ['Oct', '2026-10', '2026-11'], ['Nov', '2026-11', '2026-12']];
const out = []; const P = (...a) => { const l = a.join(' '); console.log(l); out.push(l); };
for (const [name, fn] of Object.entries(S)) {
  for (const filt of ['any market', 'market green at open']) {
    const per = [];
    for (const d of allDays) {
      const cs = days.get(d).filter((c) => filt === 'any market' || c.mkt > 0).sort((a, b) => b.cr - a.cr);
      const rs = []; for (const c of cs) { if (rs.length >= 3) break; const r = fn(c); if (r != null && Number.isFinite(r)) rs.push(r); }
      if (rs.length) per.push({ d, r: rs });
    }
    const dayv = (cost) => per.map((p) => ({ d: p.d, v: mean(p.r.map((x) => x - cost)) }));
    const v4 = dayv(0.004), v2 = dayv(0.002), trades = per.flatMap((p) => p.r);
    let eq = 1, pk = 1, dd = 0; for (const x of v4) { eq *= 1 + x.v; pk = Math.max(pk, eq); dd = Math.min(dd, eq / pk - 1); }
    const sel = (l, f) => mean(l.filter((x) => f(x.d)).map((x) => x.v));
    P(`${name.slice(0, 84).padEnd(84)} ${filt.padEnd(20)} | ${String(per.length).padStart(3)} days ${String(trades.length).padStart(4)} trades won ${pct(trades.filter((x) => x > 0.004).length / trades.length, 0)} | avg/day ${pct(mean(v4.map((x) => x.v)))} [0.2%: ${pct(mean(v2.map((x) => x.v)))}] | 1st half ${pct(sel(v4, (d) => d < SPLIT))} 2nd half ${pct(sel(v4, (d) => d >= SPLIT))} | worst drop ${pct(dd, 0)} | ${PER.map(([l, a, b]) => `${l} ${pct(sel(v4, (d) => d >= a && d < b), 1)}`).join(' ')}`);
  }
}
fs.writeFileSync(new URL('known-strategies-5min-report.txt', DIR), out.join(String.fromCharCode(10)));
