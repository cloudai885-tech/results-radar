// Step 34: the user asked for a stop and target that fit EACH stock (not the same % for all), and to keep looking if the
// first idea fails. Same live picks as steps 32-33, entry at the official open, exits on hourly bars (rescaled to NSE's
// close, stop first if both in one bar), sell by 3:20 pm, costs 0.4%. Chosen on 2025, judged on 2026.
//   A. volatility: stop / target = a multiple of the stock's own average daily range (ATR, last 14 days)
//   B. chart levels: stop under yesterday's low / the 5-day low; target at yesterday's close (gap fill), yesterday's high,
//      the 5-day high
//   C. mixed: chart stop, volatility target and the reverse
//   node --max-old-space-size=12000 research/34-stock-levels.mjs
import fs from 'node:fs';

const DIR = new URL('../data/research/', import.meta.url);
const picks = JSON.parse(fs.readFileSync(new URL('live-picks.json', DIR), 'utf8'));
const hourly = JSON.parse(fs.readFileSync(new URL('hourly.json', DIR), 'utf8'));
const mk = JSON.parse(fs.readFileSync(new URL('market.json', DIR), 'utf8'));
const COST = 0.004;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const pct = (v, d = 2) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : '   -  ');
const dayIdx = new Map(mk.days.map((d, i) => [d, i]));

const rows = [];
for (const p of picks) {
  const b = hourly[p.s]?.[p.d], R = mk.stocks[p.s]; if (!b?.length || !R) continue;
  const k = R.findIndex((r) => r[0] === dayIdx.get(p.d)); if (k < 15) continue;
  const last = b.filter((x) => x[0] < 1530).at(-1); if (!last) continue;
  const sc = p.close / last[4];
  const past = R.slice(k - 14, k);
  const atr = mean(past.map((r, i) => { const pc = i ? past[i - 1][5] : r[1]; return Math.max(r[3], pc) - Math.min(r[4], pc); })) / R[k - 1][5];
  const y = R[k - 1], five = R.slice(k - 5, k);
  rows.push({ ...p, atr, yH: y[3], yL: y[4], yC: y[5], h5: Math.max(...five.map((r) => r[3])), l5: Math.min(...five.map((r) => r[4])),
    bars: b.filter((x) => x[0] < 1520).map(([t, o, h, l, c]) => [t, o * sc, h * sc, l * sc, c * sc]) });
}
// stop / target given as PRICES (null = none); a stop above the open or a target below it is not usable -> fall back
const sim = (p, stopPx, tgtPx) => {
  const px = p.open;
  if (stopPx != null && stopPx >= px * 0.995) stopPx = px * 0.97;
  if (tgtPx != null && tgtPx <= px * 1.005) tgtPx = null;
  for (const [i, b] of p.bars.entries()) {
    if (stopPx != null && b[3] <= stopPx) return (i ? Math.min(stopPx, b[1]) : stopPx) / px - 1 - COST;
    if (tgtPx != null && b[2] >= tgtPx) return tgtPx / px - 1 - COST;
  }
  return p.bars.at(-1)[4] / px - 1 - COST;
};
const RULES = {
  'NOW: fixed (Bounce +7%/-3%, Gap&Go +7%/-3%, Panic none/-3%)': (p) => [p.open * (1 - p.stop), p.target ? p.open * (1 + p.target) : null],
  'Gap&Go -5% fixed (suggested earlier)': (p) => [p.open * (1 - (p.kind === 'Gap & Go' ? 0.05 : p.stop)), p.target ? p.open * (1 + p.target) : null],
};
for (const ks of [0.5, 0.75, 1, 1.25, 1.5]) for (const kt of [1, 1.5, 2, 3, null])
  RULES[`ATR: stop ${ks}x, target ${kt ?? 'none'}${kt ? 'x' : ''}`] = (p) => [p.open * (1 - ks * p.atr), kt ? p.open * (1 + kt * p.atr) : null];
for (const [sn, sf] of [['stop under yday low', (p) => p.yL * 0.995], ['stop under 5-day low', (p) => p.l5 * 0.995], ['stop -3%', (p) => p.open * 0.97], ['stop 1x ATR', (p) => p.open * (1 - p.atr)]])
  for (const [tn, tf] of [['target yday close', (p) => p.yC], ['target yday high', (p) => p.yH], ['target 5-day high', (p) => p.h5], ['target +7%', (p) => p.open * 1.07], ['target 2x ATR', (p) => p.open * (1 + 2 * p.atr)], ['no target', () => null]])
    RULES[`CHART: ${sn}, ${tn}`] = (p) => [sf(p), tf(p)];

for (const kind of ['Bounce-back', 'Gap & Go', 'ALL']) {
  const set = rows.filter((p) => kind === 'ALL' || p.kind === kind);
  const res = Object.entries(RULES).map(([name, f]) => {
    const r = set.map((p) => { const [s, t] = f(p); return { d: p.d, r: sim(p, s, t) }; });
    return { name, all: mean(r.map((x) => x.r)), won: r.filter((x) => x.r > 0).length / r.length, y25: mean(r.filter((x) => x.d < '2026').map((x) => x.r)), y26: mean(r.filter((x) => x.d >= '2026').map((x) => x.r)), worst: Math.min(...r.map((x) => x.r)) };
  });
  const now = res[0];
  console.log(`\n=== ${kind}: ${set.length} trades, typical daily range (ATR) ${pct(mean(set.map((p) => p.atr)), 1)} ===`);
  const top = [...res].sort((a, b) => b.y25 - a.y25).slice(0, 10);
  for (const r of [now, res[1], ...top.filter((x) => x !== now && x !== res[1])]) console.log(`  ${r.name.padEnd(62)} avg ${pct(r.all)} won ${pct(r.won, 0)} | 2025 ${pct(r.y25)} | 2026 ${pct(r.y26)} | worst trade ${pct(r.worst, 1)}${r === now ? '  <- NOW' : ''}${r.y25 > now.y25 && r.y26 > now.y26 ? '  BETTER BOTH YEARS' : ''}`);
}
