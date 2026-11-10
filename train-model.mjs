// Trains the result-chance model and proves it on quarters it has not seen.
import fs from 'node:fs';
import { nifty500, pastResultDates, dailyBars, fundamentals, mapPool, ordinalLabel } from './src/sources.mjs';
import { scoreEvent, reactionFor, indexBefore, targetQuarter } from './src/score.mjs';
import { modelFeatures, fitLogistic, predict, auc } from './src/model.mjs';

const CACHE_HOURS = 1e7; // uses whatever the backtest step already downloaded
const today = new Date().toISOString().slice(0, 10).split('-').reverse().join('-');
const nifty = await dailyBars('^NSEI', '5y', CACHE_HOURS);

const perStock = await mapPool(await nifty500(), 8, async ({ symbol }) => {
  const [b, f, dates] = await Promise.all([dailyBars(`${symbol}.NS`, '5y', CACHE_HOURS), fundamentals(symbol, CACHE_HOURS), pastResultDates(symbol, '01-01-2022', today)]);
  if (!b || !f || !dates?.length) return [];
  const rows = [], reactions = [];
  for (const date of dates) {
    const before = indexBefore(b, date), entry = before - 1, T = targetQuarter(date);
    const now = f.quarters.get(T)?.pat, lastYear = f.quarters.get(T - 4)?.pat, lastQuarter = f.quarters.get(T - 1)?.pat;
    if (entry >= 120 && now != null && lastYear != null) {
      const bars = b.slice(0, entry + 1);
      const s = scoreEvent({ dateIso: date, quarters: f.quarters, bars, nifty, pastReactions: reactions });
      if (s.score != null) rows.push({ T, X: modelFeatures({ dateIso: date, quarters: f.quarters, bars, nifty, pastReactions: reactions }), y: { yoy: now > lastYear ? 1 : 0, qoq: lastQuarter != null ? (now > lastQuarter ? 1 : 0) : null } });
    }
    const r = reactionFor(b, nifty, date);
    if (r) reactions.push(r);
  }
  return rows;
});
const failures = perStock.filter((r) => r.error);
const rows = perStock.filter((r) => Array.isArray(r)).flat();
if (rows.length < 1000) throw new Error(`Only ${rows.length} rows (${failures.length} failures). Model not saved.`);

// Learn from older quarters, predict the next one, and repeat.
const seasons = [...new Set(rows.map((r) => r.T))].sort((a, b) => a - b);
const tested = { yoy: [], qoq: [] };
for (const T of seasons) {
  const train = rows.filter((r) => r.T < T);
  if (train.length < 800) continue;
  for (const key of ['yoy', 'qoq']) {
    const model = fitLogistic(train, key);
    for (const r of rows.filter((x) => x.T === T && x.y[key] != null)) tested[key].push([predict(model, r.X), r.y[key]]);
  }
}
const check = {};
for (const key of ['yoy', 'qoq']) {
  check[key] = { auc: auc(tested[key]), tested: tested[key].length, bands: [] };
  console.log(`\n${key}: AUC ${check[key].auc.toFixed(3)} on ${tested[key].length} unseen results`);
  for (const [lo, hi] of [[0, 0.5], [0.5, 0.65], [0.65, 0.8], [0.8, 0.9], [0.9, 1.01]]) {
    const band = tested[key].filter(([p]) => p >= lo && p < hi);
    if (!band.length) continue;
    const actual = band.reduce((s, [, y]) => s + y, 0) / band.length;
    check[key].bands.push({ lo, hi: Math.min(hi, 1), count: band.length, actual });
    console.log(`  predicted ${Math.round(lo * 100)}-${Math.round(Math.min(hi, 1) * 100)}%: ${band.length} results, actually better ${(actual * 100).toFixed(0)}%`);
  }
}
console.log(`\nSeasons: ${ordinalLabel(seasons[0])} to ${ordinalLabel(seasons.at(-1))}, ${rows.length} results, ${failures.length} stocks failed.`);

fs.writeFileSync(new URL('./data/model.json', import.meta.url), JSON.stringify({ trainedOn: rows.length, yoy: fitLogistic(rows, 'yoy'), qoq: fitLogistic(rows, 'qoq'), check }));
