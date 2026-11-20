// Step 36: Bounce-back split by the 1-month move and by earlier big falls (-4.5%+ in the 5 days before yesterday), opened -2..-5%,
// Rs 1 cr+, top 3 most traded a day, +7%/-3% on hourly bars, costs 0.4%. Finding: stocks that fell before too bounce far better.
//   node --max-old-space-size=12000 research/36-repeat-fallers.mjs
import fs from 'node:fs';
import { etfList } from '../src/sources.mjs';
const DIR = new URL('../data/research/', import.meta.url);
const hourly = JSON.parse(fs.readFileSync(new URL('hourly.json', DIR), 'utf8'));
const mk = JSON.parse(fs.readFileSync(new URL('market.json', DIR), 'utf8'));
const ETFS = await etfList(); const COST = 0.004;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const pct = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%` : '  -  ');
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const all = new Map();
for (const [s, rows] of Object.entries(mk.stocks)) {
  if (ETFS.has(s) || !hourly[s]) continue;
  for (let k = 25; k < rows.length; k++) {
    const r = rows[k], d = mk.days[r[0]], y = rows[k - 1];
    if (d < '2025-01-01' || y[0] !== r[0] - 1) continue;
    const cr = median(rows.slice(k - 20, k).map((x) => x[6])); if (!(cr >= 1)) continue;
    if (y[5] / y[1] - 1 > -0.03) continue;
    const gap = r[2] / r[1] - 1; if (!(gap <= -0.02 && gap > -0.0495)) continue;
    const m20 = y[5] / rows[k - 21][5] - 1;                       // 1-month move before today
    const big5 = rows.slice(k - 6, k - 1).filter((x, i, a) => { const p = rows[k - 6 + i - 1]; return p && x[5] / p[5] - 1 <= -0.045; }).length; // big falls in the 5 days before yesterday
    const bars = hourly[s][d]; if (!bars?.length) continue;
    const last = bars.filter((x) => x[0] < 1530).at(-1); if (!last) continue;
    const sc = r[5] / last[4], B = bars.filter((x) => x[0] < 1520).map(([t, o, h, l, c]) => [t, o * sc, h * sc, l * sc, c * sc]);
    const px = r[2]; let ret = null;
    for (const x of B) { if (x[3] <= px * 0.97) { ret = -0.03; break; } if (x[2] >= px * 1.07) { ret = 0.07; break; } }
    if (ret == null) ret = B.at(-1)[4] / px - 1;
    (all.get(d) ?? all.set(d, []).get(d)).push({ s, cr, m20, big5, gap, r: ret - COST });
  }
}
const run = (lab, f) => {
  const t = [...all].flatMap(([d, l]) => l.filter(f).sort((a, b) => b.cr - a.cr).slice(0, 3).map((x) => ({ d, ...x })));
  const l6 = t.filter((x) => x.d >= '2026-05-20');
  console.log(`  ${lab.padEnd(46)} ${String(t.length).padStart(4)} tr | avg ${pct(mean(t.map((x) => x.r)))} | won ${(100*t.filter((x)=>x.r>0).length/t.length).toFixed(0)}% | 2025 ${pct(mean(t.filter((x) => x.d < '2026').map((x) => x.r)))} | 2026 ${pct(mean(t.filter((x) => x.d >= '2026').map((x) => x.r)))} | last 6m ${pct(mean(l6.map((x)=>x.r)))} (${l6.length})`);
};
console.log('By 1-month move BEFORE the trade (opened -2..-5%):');
run('all', () => true);
for (const [lab, lo, hi] of [['month down 15%+', -9, -0.15], ['month down 5-15%', -0.15, -0.05], ['month -5..+5%', -0.05, 0.05], ['month up 5%+', 0.05, 9]]) run(lab, (x) => x.m20 > lo && x.m20 <= hi);
console.log('By earlier big falls (-4.5%+) in the 5 days before yesterday:');
run('none', (x) => x.big5 === 0); run('1', (x) => x.big5 === 1); run('2+', (x) => x.big5 >= 2);
console.log('Candidate filters:');
run('skip month down 15%+', (x) => x.m20 > -0.15);
run('skip 2+ earlier big falls', (x) => x.big5 < 2);
run('skip both', (x) => x.m20 > -0.15 && x.big5 < 2);
console.log('Combined with opening drop / size:');
for (const [g, lo, hi] of [['open -3..-5%', -0.0495, -0.03], ['open -2..-3%', -0.03, -0.02]]) for (const [c, a, b] of [['Rs 1-5 cr', 1, 5], ['Rs 5 cr+', 5, 1e9]]) {
  run(`${g} ${c} | first fall`, (x) => x.gap > lo && x.gap <= hi && x.cr >= a && x.cr < b && x.big5 === 0);
  run(`${g} ${c} | fell before too`, (x) => x.gap > lo && x.gap <= hi && x.cr >= a && x.cr < b && x.big5 >= 1);
}
run('NEW RULE: fell before too (any open/size)', (x) => x.big5 >= 1);
