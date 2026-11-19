// Step 35: what if the user leaves an unfilled pre-open order open and it fills LATER in the day?
// Bounce-back/Panic orders sit at yesterday's close -3%. If the stock opens above that (it bounced in pre-open), NSE
// carries the order into normal trading, and it buys if the price comes back down to the limit.
// Stand-in (no old 9:05 pre-open prices exist): stocks that fell 3%+ yesterday and OPENED -1..-3% (the "bounced in
// pre-open" look), companies only, Rs 1 cr+/day, no T2T/ETF/results day, top 3 most traded a day. If an hourly low later
// reaches prev close -3%, it is bought at that price; then +7% target / -3% stop / sell 3:20 pm (hourly bars rescaled to
// NSE's close; stop first if both in one bar). Compared with the real strategy: bought at the open when it OPENS -3..-5%.
//   node --max-old-space-size=12000 research/35-late-fills.mjs
import fs from 'node:fs';
import { etfList } from '../src/sources.mjs';

const DIR = new URL('../data/research/', import.meta.url);
const hourly = JSON.parse(fs.readFileSync(new URL('hourly.json', DIR), 'utf8'));
const mk = JSON.parse(fs.readFileSync(new URL('market.json', DIR), 'utf8'));
const ETFS = await etfList();
const COST = 0.004;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const pct = (v, d = 2) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : '   -  ');
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

const late = [], onTime = [];
const byDayLate = new Map(), byDayOn = new Map();
for (const [s, rows] of Object.entries(mk.stocks)) {
  if (ETFS.has(s) || !hourly[s]) continue;
  for (let k = 21; k < rows.length; k++) {
    const r = rows[k], d = mk.days[r[0]], y = rows[k - 1];
    if (d < '2025-01-01' || y[0] !== r[0] - 1) continue;
    const cr = median(rows.slice(k - 20, k).map((x) => x[6])); if (!(cr >= 1)) continue;
    const yRet = y[5] / y[1] - 1, gap = r[2] / r[1] - 1; if (yRet > -0.03) continue;
    const bars = hourly[s][d]; if (!bars?.length) continue;
    const last = bars.filter((x) => x[0] < 1530).at(-1); if (!last) continue;
    const sc = r[5] / last[4], B = bars.filter((x) => x[0] < 1520).map(([t, o, h, l, c]) => [t, o * sc, h * sc, l * sc, c * sc]);
    const walk = (j, px, fillBar) => { const stop = px * 0.97, tgt = px * 1.07; for (let i = j; i < B.length; i++) { const b = B[i]; if (b[3] <= stop) return { r: (i > j ? Math.min(stop, b[1]) : stop) / px - 1 - COST, t: B[j][0] }; if (!(fillBar && i === j) && b[2] >= tgt) return { r: tgt / px - 1 - COST, t: B[j][0] }; } return { r: B.at(-1)[4] / px - 1 - COST, t: B[j][0] }; };
    if (gap <= -0.03 && gap > -0.0495) { (byDayOn.get(d) ?? byDayOn.set(d, []).get(d)).push({ s, cr, ...walk(0, r[2], false) }); continue; }
    if (gap > -0.03 && gap <= -0.01) {
      const L = r[1] * 0.97, j = B.findIndex((b) => b[3] <= L);
      if (j < 0) continue; // never came back down: the order would just stay unfilled (no harm)
      (byDayLate.get(d) ?? byDayLate.set(d, []).get(d)).push({ s, cr, ...walk(j, L, true) });
    }
  }
}
const top3 = (m) => [...m].flatMap(([d, l]) => l.sort((a, b) => b.cr - a.cr).slice(0, 3).map((x) => ({ d, ...x })));
for (const [lab, list] of [['REAL strategy: bought AT THE OPEN (opened -3..-5%)', top3(byDayOn)], ['LEFT ORDER OPEN: filled LATER in the day at -3%', top3(byDayLate)]]) {
  console.log(`\n${lab}: ${list.length} trades`);
  console.log(`  avg per trade ${pct(mean(list.map((x) => x.r)))} | won ${pct(list.filter((x) => x.r > 0).length / list.length, 0)} | 2025 ${pct(mean(list.filter((x) => x.d < '2026').map((x) => x.r)))} | 2026 ${pct(mean(list.filter((x) => x.d >= '2026').map((x) => x.r)))}`);
  if (lab.startsWith('LEFT')) for (const [a, b] of [[915, 1015], [1015, 1215], [1215, 1600]]) { const sub = list.filter((x) => x.t >= a && x.t < b); console.log(`    filled ${String(a).replace(/(\d\d)$/, ':$1')}-${String(b).replace(/(\d\d)$/, ':$1')}: ${sub.length} trades, avg ${pct(mean(sub.map((x) => x.r)))}, won ${pct(sub.filter((x) => x.r > 0).length / sub.length, 0)}`); }
}
