// Step 38: combine the winner/loser patterns from step 37 (Bounce-back) into simple rules and check each year.
// Needs data/research/win-loss-trades.json from step 37.   node research/38-refined-rules.mjs
import fs from 'node:fs';
const T = JSON.parse(fs.readFileSync(new URL('../data/research/win-loss-trades.json', import.meta.url), 'utf8')).filter((t) => t.kind === 'Bounce-back');
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const pct = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%` : '  -  ');
// NOTE: trades were already top-3 per day BEFORE filtering; re-rank isn't possible here, so this is "skip these" (a filter can only remove).
const run = (lab, f) => {
  const g = T.filter(f), days = new Set(g.map((t) => t.d)).size;
  const byDay = new Map(); for (const t of g) (byDay.get(t.d) ?? byDay.set(t.d, []).get(t.d)).push(t.r);
  const dayAvg = mean([...byDay.values()].map(mean));
  const ys = ['2024', '2025', '2026'].map((y) => mean(g.filter((t) => t.d.startsWith(y)).map((t) => t.r)));
  const l6 = g.filter((t) => t.d >= '2026-05-20');
  console.log(`  ${lab.padEnd(58)} ${String(g.length).padStart(4)} tr on ${String(days).padStart(3)} days | avg ${pct(mean(g.map((t) => t.r)))} | won ${(100 * g.filter((t) => t.r > 0).length / g.length).toFixed(0)}% | per trade-day ${pct(dayAvg)} | ${ys.map((v, j) => `${2024 + j} ${pct(v)}`).join(' ')} | last 6m ${pct(mean(l6.map((t) => t.r)))}`);
};
const crash = (t) => t.yRet > -0.08;            // L1: not a crash (fell more than 8% = real bad news)
const before = (t) => t.big5 >= 1;              // W1: fell before too
const deep = (t) => t.gap <= -0.03;             // W2: opens -3% or lower
const notRecovered = (t) => t.closeLoc <= 0.6;  // L2: did not recover yesterday
const noSpike = (t) => !(t.volSpike > 2);       // L3: no panic volume
const lively = (t) => t.atr >= 0.035;           // L4: not a slow stock
const strong = (t) => t.ret60 > 0.2 || t.vsMa50 > 0.1; // W3: was a strong stock before
console.log('Bounce-back, every trade 2024-2026 (the current rule with -2% limit):');
run('NOW (all)', () => true);
console.log('One rule at a time:');
run('skip crashes (fell 8%+ yesterday)', crash);
run('only "fell before too"', before);
run('only opens -3% or lower', deep);
run('skip "recovered yesterday"', notRecovered);
run('skip volume spike 2x+', noSpike);
run('skip slow stocks (ATR < 3.5%)', lively);
console.log('Combined:');
run('A: skip crashes + fell before too', (t) => crash(t) && before(t));
run('B: A + skip recovered', (t) => crash(t) && before(t) && notRecovered(t));
run('C: skip crashes + recovered + slow (keep first-fallers)', (t) => crash(t) && notRecovered(t) && lively(t));
run('D: B + skip slow', (t) => crash(t) && before(t) && notRecovered(t) && lively(t));
run('E: (fell before OR strong stock) + skip crashes/recovered', (t) => (before(t) || strong(t)) && crash(t) && notRecovered(t));
run('F: E + skip slow', (t) => (before(t) || strong(t)) && crash(t) && notRecovered(t) && lively(t));
console.log('What the filters REMOVE (should be bad):');
run('removed by E', (t) => !((before(t) || strong(t)) && crash(t) && notRecovered(t)));
run('removed by C', (t) => !(crash(t) && notRecovered(t) && lively(t)));
