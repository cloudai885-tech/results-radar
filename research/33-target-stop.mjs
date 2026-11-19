// Step 33: the user asked whether the +7% target is really hit, and which profit target / stop-loss works best.
// Same live picks as step 32 (main picks + Bounce-back at Rs 1 cr+, companies only, Jan 2025 - Nov 2026), entry at the
// official open, exits walked on HOURLY bars (rescaled to NSE's close; stop first if both in one bar), sell by 3:20 pm.
// Each strategy gets its own table. Chosen on 2025, checked on 2026. Costs 0.4%.
//   node --max-old-space-size=12000 research/33-target-stop.mjs
import fs from 'node:fs';

const DIR = new URL('../data/research/', import.meta.url);
const picks = JSON.parse(fs.readFileSync(new URL('live-picks.json', DIR), 'utf8'));
const hourly = JSON.parse(fs.readFileSync(new URL('hourly.json', DIR), 'utf8'));
const COST = 0.004;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const pct = (v, d = 2) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : '   -  ');

const rows = [];
for (const p of picks) {
  const b = hourly[p.s]?.[p.d]; if (!b?.length) continue;
  const last = b.filter((x) => x[0] < 1530).at(-1); if (!last) continue;
  const k = p.close / last[4];
  rows.push({ ...p, bars: b.filter((x) => x[0] < 1520).map(([t, o, h, l, c]) => [t, o * k, h * k, l * k, c * k]) });
}
const sim = (p, tgt, st) => {
  const px = p.open, stop = st ? px * (1 - st) : null, t = tgt ? px * (1 + tgt) : null;
  for (const [i, b] of p.bars.entries()) {
    if (stop != null && b[3] <= stop) return { r: (i ? Math.min(stop, b[1]) : stop) / px - 1 - COST, how: 'stop' };
    if (t != null && b[2] >= t) return { r: tgt - COST, how: 'target' };
  }
  return { r: p.bars.at(-1)[4] / px - 1 - COST, how: 'close' };
};
const TG = [0.02, 0.03, 0.04, 0.05, 0.07, 0.10, null], ST = [0.015, 0.02, 0.03, 0.04, 0.05, null];
const lab = (v) => (v == null ? 'none' : `${(v * 100).toFixed(1).replace('.0', '')}%`);
for (const kind of ['Bounce-back', 'Gap & Go', 'Panic rebound', 'ALL']) {
  const set = rows.filter((p) => kind === 'ALL' || p.kind === kind);
  console.log(`\n=== ${kind}: ${set.length} trades (2025: ${set.filter((p) => p.d < '2026').length}, 2026: ${set.filter((p) => p.d >= '2026').length}) ===`);
  console.log('  target  stop   | avg/trade  won  | hit target  hit stop  sold 3:20 | 2025      2026');
  const res = [];
  for (const tg of TG) for (const st of ST) {
    const s = set.map((p) => ({ d: p.d, ...sim(p, tg, st) }));
    res.push({ tg, st, all: mean(s.map((x) => x.r)), won: s.filter((x) => x.r > 0).length / s.length, ht: s.filter((x) => x.how === 'target').length, hs: s.filter((x) => x.how === 'stop').length, hc: s.filter((x) => x.how === 'close').length, y25: mean(s.filter((x) => x.d < '2026').map((x) => x.r)), y26: mean(s.filter((x) => x.d >= '2026').map((x) => x.r)) });
  }
  const now = res.find((r) => (kind === 'Panic rebound' ? r.tg == null : r.tg === 0.07) && r.st === 0.03);
  const best25 = [...res].sort((a, b) => b.y25 - a.y25).slice(0, 6);
  const show = [now, ...best25.filter((r) => r !== now)];
  for (const r of show) console.log(`  ${lab(r.tg).padStart(5)}  ${lab(r.st).padStart(5)}  | ${pct(r.all).padStart(7)}  ${pct(r.won, 0).padStart(4)} | ${String(r.ht).padStart(6)}     ${String(r.hs).padStart(6)}    ${String(r.hc).padStart(6)}   | ${pct(r.y25).padStart(7)}  ${pct(r.y26).padStart(7)}${r === now ? '   <- NOW' : ''}`);
}
