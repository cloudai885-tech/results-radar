// Replays the strategy on past Nifty 500 results and reports whether it actually made money.
import fs from 'node:fs';
import { nifty500, pastResultDates, dailyBars, fundamentals, mapPool } from './src/sources.mjs';
import { scoreEvent, reactionFor, indexBefore, simulateTrade, resultWasBetter, RULES } from './src/score.mjs';

const today = new Date().toISOString().slice(0, 10);
const [y, m, d] = today.split('-');
const limit = Number(process.argv[2] ?? 0);

const universe = await nifty500();
const nifty = await dailyBars('^NSEI');
const symbols = limit ? universe.slice(0, limit) : universe;
console.log(`Universe: ${symbols.length} stocks. First run takes roughly 20 minutes, later runs use the cache.`);

const results = await mapPool(symbols, 4, async ({ symbol, company }) => {
  const [dates, bars, f] = await Promise.all([
    pastResultDates(symbol, '01-01-2022', `${d}-${m}-${y}`),
    dailyBars(`${symbol}.NS`),
    fundamentals(symbol, 24 * 14),
  ]);
  if (!bars || !f || !dates.length) return { symbol, skipped: true };
  const events = [];
  const reactions = [];
  for (const date of dates) {
    const before = indexBefore(bars, date);
    const entryIdx = before - (RULES.sessionsBeforeToBuy - 1);
    const onOrBefore = indexBefore(bars, date + 'z');
    const exitIdx = onOrBefore + 1;
    if (entryIdx < 60 || exitIdx >= bars.length || bars[before].date < addDays(date, -7)) continue;
    const s = scoreEvent({ dateIso: date, quarters: f.quarters, bars: bars.slice(0, entryIdx + 1), nifty, pastReactions: reactions });
    const r = reactionFor(bars, nifty, date);
    if (s.score != null) {
      const t = simulateTrade(bars, entryIdx, exitIdx);
      const n0 = closeAt(nifty, bars[entryIdx].date), n1 = closeAt(nifty, bars[exitIdx].date);
      events.push({ symbol, company, date, entryDate: bars[entryIdx].date, exitDate: bars[exitIdx].date, score: s.score, rejected: s.rejected, ...t, nifty: n0 && n1 ? n1 / n0 - 1 : 0, resultBetter: resultWasBetter(f.quarters, date), rose: r ? r.stock > 0 : null });
    }
    if (r) reactions.push(r);
  }
  return { symbol, events };
}, (done, total) => { if (done % 25 === 0) console.log(`  ${done}/${total}`); });

function addDays(iso, n) { return new Date(Date.parse(iso) + n * 864e5).toISOString().slice(0, 10); }
function closeAt(bars, iso) { const i = indexBefore(bars, iso + 'z'); return i >= 0 ? bars[i].close : null; }

const failed = results.filter((r) => r.error);
const all = results.flatMap((r) => r.events ?? []);
const tradable = all.filter((e) => !e.rejected).sort((a, b) => a.entryDate.localeCompare(b.entryDate));
// A full run should produce thousands of trades; far fewer means the data sources blocked us.
if (!limit && tradable.length < 1000) throw new Error(`Only ${tradable.length} trades found (${failed.length} stocks failed). Results not saved.`);

const pct = (v, dp = 2) => `${(v * 100).toFixed(dp)}%`;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
function stats(list) {
  const net = list.map((e) => e.net);
  const rate = (k) => mean(list.filter((e) => e[k] != null).map((e) => (e[k] ? 1 : 0)));
  return { betterRate: rate('resultBetter'), roseRate: rate('rose'), n: list.length, win: mean(net.map((x) => (x > 0 ? 1 : 0))), avg: mean(net), median: med(net), noStop: mean(list.map((e) => e.noStopNet)), beatNifty: mean(list.map((e) => e.net + RULES.roundTripCost - e.nifty)), stopped: mean(list.map((e) => (e.stopped ? 1 : 0))), gapped: mean(list.map((e) => (e.gapped ? 1 : 0))), worst: net.length ? Math.min(...net) : 0 };
}
const show = (label, s) => console.log(`${label.padEnd(22)} n=${String(s.n).padStart(5)}  result-better ${pct(s.betterRate, 0).padStart(4)}  rose ${pct(s.roseRate, 0).padStart(4)}  win${pct(s.win, 1).padStart(6)}  avg ${pct(s.avg).padStart(7)}  median ${pct(s.median).padStart(7)}  no-stop avg ${pct(s.noStop).padStart(7)}  vs-Nifty(pre-cost) ${pct(s.beatNifty).padStart(7)}  stopped ${pct(s.stopped, 0).padStart(4)}  gap-through ${pct(s.gapped, 0).padStart(4)}  worst ${pct(s.worst, 1)}`);

const sorted = [...tradable].sort((a, b) => a.score - b.score);
const q = (p) => sorted[Math.floor(sorted.length * p)]?.score ?? 0;
const cuts = [q(0.2), q(0.4), q(0.6), q(0.8), q(0.9)];
const buckets = [
  { name: 'Bottom 20%', lo: -Infinity, hi: cuts[0] }, { name: '20-40%', lo: cuts[0], hi: cuts[1] }, { name: '40-60%', lo: cuts[1], hi: cuts[2] },
  { name: '60-80%', lo: cuts[2], hi: cuts[3] }, { name: '80-90%', lo: cuts[3], hi: cuts[4] }, { name: 'Top 10%', lo: cuts[4], hi: Infinity },
].map((b) => ({ ...b, stats: stats(tradable.filter((e) => e.score >= b.lo && e.score < b.hi)) }));

console.log(`\nEvents: ${all.length}, tradable after filters: ${tradable.length}, stocks failed: ${failed.length}`);
console.log(`Period: ${tradable[0]?.entryDate} to ${tradable.at(-1)?.exitDate}\n`);
show('All tradable', stats(tradable));
console.log('\nBy score bucket (cut points are ' + cuts.join(', ') + ')');
buckets.forEach((b) => show(b.name, b.stats));

const years = [...new Set(tradable.map((e) => e.entryDate.slice(0, 4)))];
console.log('\nBy year: all tradable, then top 10% by score');
for (const yr of years) {
  const list = tradable.filter((e) => e.entryDate.startsWith(yr));
  show(`${yr} all`, stats(list));
  show(`${yr} top 10%`, stats(list.filter((e) => e.score >= cuts[4])));
}

// The actual plan: one position at a time, best score of the week.
function weekOf(iso) { const dt = new Date(iso); const day = (dt.getUTCDay() + 6) % 7; return addDays(iso, -day); }
function pickOneSim(minScore, chooser) {
  const byWeek = new Map();
  for (const e of tradable) { if (e.score >= minScore) { const w = weekOf(e.entryDate); (byWeek.get(w) ?? byWeek.set(w, []).get(w)).push(e); } }
  let capital = 20000, peak = 20000, maxDd = 0, busyUntil = '';
  const trades = [];
  for (const w of [...byWeek.keys()].sort()) {
    const open = byWeek.get(w).filter((e) => e.entryDate > busyUntil);
    if (!open.length) continue;
    const e = chooser(open);
    capital *= 1 + e.net; peak = Math.max(peak, capital); maxDd = Math.min(maxDd, capital / peak - 1);
    busyUntil = e.exitDate; trades.push(e);
  }
  return { trades, capital, maxDd, stats: stats(trades) };
}
const best = pickOneSim(cuts[3], (list) => list.reduce((a, b) => (b.score > a.score ? b : a)));
const everyWeekBest = pickOneSim(-Infinity, (list) => list.reduce((a, b) => (b.score > a.score ? b : a)));
// Deterministic "no skill" comparison: alphabetically first eligible stock each week.
const arbitrary = pickOneSim(-Infinity, (list) => list.reduce((a, b) => (b.symbol < a.symbol ? b : a)));
console.log('\nOne trade at a time, starting with Rs 20,000');
for (const [label, sim] of [['Best score, top-20% only', best], ['Best score, every week', everyWeekBest], ['No-skill pick', arbitrary]]) {
  show(label, sim.stats);
  console.log(`${''.padEnd(22)} ends at Rs ${Math.round(sim.capital)}, worst drawdown ${pct(sim.maxDd, 1)}`);
}

// A small trial must never set the rating cutoffs the app relies on.
if (limit) { console.log('\nTrial run, results not saved.'); process.exit(0); }
fs.writeFileSync(new URL('./data/backtest.json', import.meta.url), JSON.stringify({ generated: today, cuts, buckets: buckets.map((b) => ({ name: b.name, lo: Number.isFinite(b.lo) ? b.lo : null, hi: Number.isFinite(b.hi) ? b.hi : null, ...b.stats })), picks: best.trades.map(({ symbol, entryDate, exitDate, score, net }) => ({ symbol, entryDate, exitDate, score, net })) }, null, 1));
fs.writeFileSync(new URL('./data/backtest-events.json', import.meta.url), JSON.stringify(all));
if (failed.length) console.log('Failed samples:', failed.slice(0, 5).map((f) => `${f.item?.symbol}: ${f.error}`));
