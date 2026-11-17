// Step 16b: does READING the overnight news (graded blind by Claude: +2 strong good, +1 mild good, 0 neutral, -1 bad)
// separate the stocks that go up? Joins the grades with daily prices and 5-min bars.
//   node research/16-grade-test.mjs <gradeDir>   (gradeDir holds all-map.txt and g*.txt files "id:grade ...")
//   -> data/research/grade-report.txt
import fs from 'node:fs';
import path from 'node:path';

const G = process.argv[2];
const DIR = new URL('../data/research/', import.meta.url);
const read = (f) => JSON.parse(fs.readFileSync(new URL(f, DIR), 'utf8'));
const { days, stocks } = read('market.json');
const intra = read('intraday.json');
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (v, d = 2) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : '   -   ');
const out = [];
const log = (s = '') => { out.push(s); console.log(s); };

const map = new Map(fs.readFileSync(path.join(G, 'all-map.txt'), 'utf8').trim().split('\n').map((l) => { const [id, d, s] = l.split('|'); return [id, { d, s }]; }));
const grade = new Map();
for (const f of fs.readdirSync(G).filter((f) => /^g\d+\.txt$/.test(f))) for (const t of fs.readFileSync(path.join(G, f), 'utf8').split(/\s+/)) { const [id, g] = t.split(':'); if (g !== undefined) grade.set(id, Number(g)); }
const dayIdx = new Map(days.map((d, i) => [d, i]));
const daily = {};
for (const [sym, rows] of Object.entries(stocks)) daily[sym] = new Map(rows.map((r) => [r[0], r]));

const COST = (liq) => 0.0022 + (liq >= 20 ? 0.0005 : liq >= 5 ? 0.0015 : 0.003);
function simulate(bars, idx, px, x) {
  let peak = px;
  for (let j = idx; j < bars.length; j++) {
    const [t, o, h, l, c] = bars[j];
    if (t > 1515) break;
    const stop = Math.max(px * (1 - x.stop), x.trail ? peak * (1 - x.trail) : 0);
    if (l <= stop) return Math.min(o, stop) / px - 1;
    if (x.target && h >= px * (1 + x.target)) return x.target;
    peak = Math.max(peak, h);
    if (t === 1515) return c / px - 1;
  }
  return bars.filter((b) => b[0] <= 1515).at(-1)[4] / px - 1;
}
const EXITS = [{ n: 'hold 3:20', stop: 0.03 }, { n: 'trail 1%', stop: 0.03, trail: 0.01 }, { n: 'trail 2%', stop: 0.03, trail: 0.02 }, { n: 'tgt 3%/stop 2%', stop: 0.02, target: 0.03 }];

const rows = [];
for (const [id, { d, s }] of map) {
  const i = dayIdx.get(d), m = daily[s];
  if (i == null || !m?.has(i)) continue;
  const t = m.get(i);
  const liqA = []; for (let j = i - 1; j >= 0 && liqA.length < 20; j--) if (m.has(j)) liqA.push(m.get(j)[6]);
  const liq = median(liqA);
  const r = { id, d, s, g: grade.get(id) ?? 0, liq, prev: t[1], gap: t[2] / t[1] - 1, ret: t[5] / t[1] - 1, oc: t[5] / t[2] - 1 - COST(liq), part: d < '2026-11-03' ? 1 : 2, tr: {} };
  const b = intra[s]?.[d];
  if (b && b.length >= 60 && b[0][0] === 915) {
    const k = b.findIndex((x) => x[0] === 925);
    const entries = { '9:15 open': { idx: 0, px: b[0][1] } };
    if (k > 0 && b[k][4] > b[0][1] && b[k][4] > r.prev) entries['9:30 if above open & yday'] = { idx: k + 1, px: b[k][4] };
    for (const [en, e] of Object.entries(entries)) r.tr[en] = Object.fromEntries(EXITS.map((x) => [x.n, simulate(b, e.idx, e.px, x) - COST(liq)]));
  }
  rows.push(r);
}
log(`BLIND NEWS GRADES vs WHAT THE PRICE DID  (${rows.length} stock-days with material overnight news, ${[...new Set(rows.map((r) => r.d))].sort()[0]}..${days.at(-1)})`);
log('Grades were given reading only the headlines (no prices). Part 1 = before Nov 3, part 2 = Nov 3 onward.\n');
const LABEL = { 2: '+2 strong good', 1: '+1 mild good', 0: ' 0 neutral', '-1': '-1 bad' };
const line = (label, g) => {
  const cells = [1, 2].map((p) => { const s = g.filter((r) => r.part === p); return `p${p} n=${String(s.length).padStart(4)} gainer ${pct(s.filter((r) => r.ret >= 0.05).length / s.length, 0).padStart(4)} gap ${pct(mean(s.map((r) => r.gap)), 1).padStart(6)} open->close ${pct(mean(s.map((r) => r.oc))).padStart(7)}`; });
  log(`${label.padEnd(30)} ${cells.join(' | ')}`);
  for (const en of ['9:15 open', '9:30 if above open & yday']) {
    const t = g.filter((r) => r.tr[en]);
    if (t.length < 8) continue;
    log(`    ${en.padEnd(26)} ` + EXITS.map((x) => `${x.n}: ${[1, 2].map((p) => pct(mean(t.filter((r) => r.part === p).map((r) => r.tr[en][x.n])))).join('/')}`).join('  ') + `  (n ${[1, 2].map((p) => t.filter((r) => r.part === p).length).join('/')}, win ${pct(t.filter((r) => r.tr[en]['trail 2%'] > 0).length / t.length, 0)} on trail 2%)`);
  }
};
for (const g of [2, 1, 0, -1]) line(LABEL[g], rows.filter((r) => r.g === g));
log('\n--- strong good news (+2), split by how it opened ---');
const s2 = rows.filter((r) => r.g === 2);
line('+2, opens down', s2.filter((r) => r.gap < 0));
line('+2, opens 0..+2%', s2.filter((r) => r.gap >= 0 && r.gap < 0.02));
line('+2, opens +2..+5%', s2.filter((r) => r.gap >= 0.02 && r.gap < 0.05));
line('+2, opens +5% or more', s2.filter((r) => r.gap >= 0.05));
line('+2, liquid Rs 10 cr+/day', s2.filter((r) => r.liq >= 10));
log('\n--- +2 and +1 together, opens below +2% (news not priced in yet) ---');
line('+1/+2, opens < +2%', rows.filter((r) => r.g >= 1 && r.gap < 0.02));

log('\n--- every +2 stock: what happened (9:30 rule + trail 2% where it qualified) ---');
for (const r of s2.sort((a, z) => a.d.localeCompare(z.d))) {
  const q = r.tr['9:30 if above open & yday'];
  log(`  ${r.d} ${r.s.padEnd(12)} gap ${pct(r.gap, 1).padStart(6)} day ${pct(r.ret, 1).padStart(6)} | 9:15 hold ${r.tr['9:15 open'] ? pct(r.tr['9:15 open']['hold 3:20'], 1).padStart(6) : '   -  '} | 9:30 rule ${q ? pct(q['trail 2%'], 1).padStart(6) : ' skip '}`);
}
fs.writeFileSync(new URL('grade-report.txt', DIR), out.join('\n'));

// ---------- "pick the best, like a trader": top N strong-news stocks per day, ranked by news strength (1-10, blind) ----------
{
  const sf = path.join(G, 'strength.txt');
  if (fs.existsSync(sf)) {
    const strength = new Map(fs.readFileSync(sf, 'utf8').split(/\s+/).filter(Boolean).map((t) => t.split(':')).map(([a, b]) => [a, Number(b)]));
    for (const r of rows) r.str = strength.get(r.id) ?? 0;
    const daysList = [...new Set(rows.map((r) => r.d))].sort();
    const runs = [
      ['top 3 by news strength, buy 9:15', 3, (r) => r.tr['9:15 open'], '9:15 open'],
      ['top 3 by strength among 9:30-rule passers', 3, (r) => r.tr['9:30 if above open & yday'], '9:30 if above open & yday'],
      ['top 1 by strength among 9:30-rule passers', 1, (r) => r.tr['9:30 if above open & yday'], '9:30 if above open & yday'],
      ['top 3 strength>=8 among 9:30 passers', 3, (r) => r.str >= 8 && r.tr['9:30 if above open & yday'], '9:30 if above open & yday'],
    ];
    for (const exitName of ['trail 2%', 'tgt 3%/stop 2%', 'hold 3:20']) {
      log(`\n==== PICK THE BEST EACH DAY (exit: ${exitName}) - basket = average of that day's picks, after costs ====`);
      for (const [label, n, ok, en] of runs) {
        const dayRes = [];
        for (const d of daysList) {
          const picks = rows.filter((r) => r.d === d && r.g === 2 && ok(r)).sort((a, z) => z.str - a.str || z.liq - a.liq).slice(0, n);
          if (!picks.length) continue;
          dayRes.push({ d, part: d < '2026-11-03' ? 1 : 2, v: mean(picks.map((p) => p.tr[en][exitName])), picks: picks.map((p) => `${p.s}(${pct(p.tr[en][exitName], 1)})`) });
        }
        const sum = (p) => { const a = dayRes.filter((x) => x.part === p).map((x) => x.v); return `${a.length} days, avg day ${pct(mean(a))}, ${a.filter((v) => v > 0).length} green`; };
        log(`  ${label.padEnd(44)} part1: ${sum(1)} | part2: ${sum(2)} | total ${pct(dayRes.reduce((s, x) => s + x.v, 0), 1)} over ${dayRes.length} days`);
        if (exitName === 'trail 2%' && n === 3 && label.includes('passers') && !label.includes('>=')) for (const x of dayRes) log(`      ${x.d}  ${pct(x.v).padStart(7)}  ${x.picks.join(' ')}`);
      }
    }
  }
}
fs.writeFileSync(new URL('grade-report.txt', DIR), out.join('\n'));
