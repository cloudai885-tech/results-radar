// Weekly scan: finds upcoming results in the Nifty 500, scores them, and names one pick (or none).
import fs from 'node:fs';
import { nifty500, eventCalendar, pastResultDates, dailyBars, fundamentals, holidays, mapPool, ordinalLabel, deliveryDay } from './src/sources.mjs';
import { scoreEvent, reactionFor, targetQuarter, RULES } from './src/score.mjs';
import { ipoReport } from './src/ipo.mjs';
import { modelFeatures, predict, demandSignals } from './src/model.mjs';

const nowIst = new Date(Date.now() + 19800e3);
const today = nowIst.toISOString().slice(0, 10);
const marketClosed = nowIst.getUTCHours() * 60 + nowIst.getUTCMinutes() >= 15 * 60 + 30;

const closedDays = await holidays();
const isSession = (iso) => { const wd = new Date(iso).getUTCDay(); return wd !== 0 && wd !== 6 && !closedDays.has(iso); };
const addDays = (iso, n) => new Date(Date.parse(iso) + n * 864e5).toISOString().slice(0, 10);
function sessionsBefore(dateIso, count) {
  const out = [];
  for (let d = addDays(dateIso, -1); out.length < count; d = addDays(d, -1)) if (isSession(d)) out.unshift(d);
  return out;
}
function nextSessionAfter(dateIso) { let d = addDays(dateIso, 1); while (!isSession(d)) d = addDays(d, 1); return d; }
// The earliest session where a new order can still be placed.
const firstOpenSession = isSession(today) && !marketClosed ? today : nextSessionAfter(today);

const universe = new Map((await nifty500()).map((c) => [c.symbol, c]));
// A 7-day window starting 3 days out, so there is still time to buy before each result.
const windowStart = addDays(today, 3);
const horizon = addDays(today, 9);
const calendar = (await eventCalendar()).filter((e) => universe.has(e.symbol) && e.date >= windowStart && e.date <= horizon);
const nifty = await dailyBars('^NSEI');

let model = null;
try { model = JSON.parse(fs.readFileSync(new URL('./data/model.json', import.meta.url))); } catch { console.warn('Result-chance model not found.'); }

// Who is really buying: delivery and trade counts over the last 60 sessions.
const deliveryDays = (await mapPool(nifty.slice(-60).map((b) => b.date), 3, deliveryDay)).filter((d) => d instanceof Map);
function crowdSignals(symbol) {
  if (deliveryDays.length < 40) return null;
  const mean = (days, key) => { const v = days.map((d) => d.get(symbol)?.[key]).filter(Number.isFinite); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
  const pct3 = mean(deliveryDays.slice(-3), 'deliveryPct'), pct60 = mean(deliveryDays, 'deliveryPct');
  const shares5 = mean(deliveryDays.slice(-5), 'delivered'), shares60 = mean(deliveryDays, 'delivered');
  const trades5 = mean(deliveryDays.slice(-5), 'trades'), trades60 = mean(deliveryDays, 'trades');
  if (pct3 == null || pct60 == null || !shares60 || !trades60) return null;
  return { pct3, change: pct3 - pct60, sharesRatio: shares5 / shares60, tradesRatio: trades5 / trades60 };
}

// How each reporting industry moved against the Nifty over about 3 months (60 sessions).
const threeMonths = (b) => (b?.length > 60 ? b.at(-1).close / b.at(-61).close - 1 : null);
const industriesNeeded = new Set(calendar.map((e) => universe.get(e.symbol).industry));
const members = [...universe.values()].filter((c) => industriesNeeded.has(c.industry));
const memberMoves = await mapPool(members, 4, async (c) => ({ industry: c.industry, move: threeMonths(await dailyBars(`${c.symbol}.NS`)) }));
const industryMove = new Map([...industriesNeeded].map((name) => {
  const moves = memberMoves.filter((m) => m.industry === name && m.move != null).map((m) => m.move);
  return [name, moves.length >= 3 ? moves.reduce((s, x) => s + x, 0) / moves.length - threeMonths(nifty) : null];
}));
console.log(`${calendar.length} Nifty 500 companies report results between ${windowStart} and ${horizon}. Researching each...`);

const dd = (iso) => iso.split('-').reverse().join('-');
const scored = await mapPool(calendar, 4, async (ev) => {
  const [bars, f, dates] = await Promise.all([
    dailyBars(`${ev.symbol}.NS`),
    fundamentals(ev.symbol),
    pastResultDates(ev.symbol, '01-01-2022', dd(today)),
  ]);
  if (!bars || !f) return { ...ev, rejected: 'no data' };
  if (f.quarters.has(targetQuarter(ev.date))) return { ...ev, rejected: 'this quarter is already published' };

  const [before2, before1] = sessionsBefore(ev.date, RULES.sessionsBeforeToBuy);
  // Still scored when it is too late to buy, because the app shows every company on its day.
  const tooLate = before1 < firstOpenSession;
  const late = !tooLate && before2 < firstOpenSession;
  const buyOn = tooLate ? null : late ? before1 : before2;

  const completed = bars.filter((b) => b.date < today || (b.date === today && marketClosed));
  const reactions = dates.filter((d) => d < today).map((d) => reactionFor(completed, nifty, d)).filter(Boolean);
  const s = scoreEvent({ dateIso: ev.date, quarters: f.quarters, bars: completed, nifty, pastReactions: reactions });
  let chances = null;
  if (model && s.score != null) {
    const X = modelFeatures({ dateIso: ev.date, quarters: f.quarters, bars: completed, nifty, pastReactions: reactions });
    chances = { yoy: predict(model.yoy, X), qoq: predict(model.qoq, X) };
  }
  return { ...ev, ...s, chances, signals: demandSignals(completed, f.holdings), buyOn, late, tooLate, sellOn: nextSessionAfter(ev.date), company: universe.get(ev.symbol).company, industry: universe.get(ev.symbol).industry, marketCapCr: f.marketCapCr, pe: f.pe };
}, (done, total) => { if (done % 20 === 0) console.log(`  ${done}/${total}`); });

const failed = scored.filter((r) => r.error);
const ranked = scored.filter((r) => !r.error && r.score != null && !r.rejected && !r.tooLate).sort((a, b) => b.score - a.score);
const rejected = scored.filter((r) => !r.error && (r.rejected || r.score == null));

let backtest = null;
try { backtest = JSON.parse(fs.readFileSync(new URL('./data/backtest.json', import.meta.url))); } catch { /* backtest not run yet */ }
const bucketFor = (score) => backtest?.buckets.find((b) => (b.lo == null || score >= b.lo) && (b.hi == null || score < b.hi));
const minScore = backtest?.cuts?.[3] ?? Infinity;
// Up to 3 picks, a third of the money each. Only Excellent or better; any unused third stays in cash.
const BUDGET_RS = 20000;
const PER_STOCK_RS = Math.floor(BUDGET_RS / 3);
const picks = ranked.filter((r) => !r.late && r.score >= minScore && r.facts.close <= PER_STOCK_RS)
  .sort((a, b) => (b.chances?.qoq ?? 0) - (a.chances?.qoq ?? 0)) // short trades: best chance of beating last quarter first
  .slice(0, 3);
const pick = picks[0] ?? null;

const pct = (v) => (v == null ? 'n/a' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);
const history = (b) => (b ? `${(b.win * 100).toFixed(0)}% wins, avg ${pct(b.avg)} (${b.n} past trades, ${b.name})` : 'run the backtest first');
const row = (r, i) => `| ${i + 1} | ${r.symbol} | ${r.score} | ${r.date} | ${r.buyOn}${r.late ? ' (late)' : ''} | ${ordinalLabel(r.facts.targetQuarter)} | ${pct(r.facts.salesYoY)} | ${pct(r.facts.patYoY)} | ${pct(r.facts.baseQuarterYoY)} | ${r.facts.reactionWins}/${r.facts.reactionsSeen} | ${pct(r.facts.run10)} |`;

const md = [`# Earnings scout, ${today}`, ''];
if (pick) {
  md.push(`## Pick: ${pick.symbol} (${pick.company})`, '',
    `- Score ${pick.score}. Same-score trades in the backtest: ${history(bucketFor(pick.score))}.`,
    `- Results on ${pick.date}, for the ${ordinalLabel(pick.facts.targetQuarter)} quarter.`,
    `- Buy on ${pick.buyOn} near the close, around Rs ${pick.facts.close.toFixed(1)} (last close).`,
    `- Place the stop-loss at ${(RULES.stopLoss * 100).toFixed(0)}% below your actual buy price.`,
    `- Sell by the close on ${pick.sellOn}, the first full session after results.`, '');
} else {
  md.push('## No pick this week', '', ranked.length ? 'Nothing cleared the minimum score with enough time left to buy on schedule.' : 'No eligible results in this window.', '');
}
md.push('## Ranking', '', '| # | Symbol | Score | Results | Buy on | Quarter | Sales YoY | Profit YoY | Base qtr YoY | Beat Nifty after results | 10-day run |', '|---|---|---|---|---|---|---|---|---|---|---|', ...ranked.slice(0, 25).map(row), '');
const reasons = {};
rejected.forEach((r) => { const k = r.rejected ?? 'no score'; reasons[k] = (reasons[k] ?? 0) + 1; });
md.push(`Filtered out: ${Object.entries(reasons).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}.${failed.length ? ` Data errors: ${failed.length}.` : ''}`, '');

fs.mkdirSync(new URL('./reports/', import.meta.url), { recursive: true });
const reportUrl = new URL(`./reports/${today}.md`, import.meta.url);
fs.writeFileSync(reportUrl, md.join('\n'));
fs.writeFileSync(new URL('./reports/latest.json', import.meta.url), JSON.stringify({ today, firstOpenSession, minScore, pick: pick?.symbol ?? null, top: ranked.slice(0, 8) }, null, 1));

// ---- Data for the app --------------------------------------------------
const LABELS = ['Max Confidence', 'Excellent', 'Good', 'Bad', 'No data'];
const FY_QUARTER = ['Q4', 'Q1', 'Q2', 'Q3']; // Mar, Jun, Sep, Dec quarters in the Indian financial year
const BUCKETS_FOR = { 'Max Confidence': ['Top 10%'], Excellent: ['80-90%'], Good: ['40-60%', '60-80%'], Bad: ['Bottom 20%', '20-40%'] };

function opinion(r) {
  if (r.score == null || !backtest) return 'No data';
  if (r.rejected) return 'Bad';
  const [, c40, , c80, c90] = backtest.cuts;
  return r.score >= c90 ? 'Max Confidence' : r.score >= c80 ? 'Excellent' : r.score >= c40 ? 'Good' : 'Bad';
}
function labelHistory(label) {
  const list = (backtest?.buckets ?? []).filter((b) => BUCKETS_FOR[label]?.includes(b.name));
  const n = list.reduce((s, b) => s + b.n, 0);
  if (!n) return null;
  const weighted = (k) => list.reduce((s, b) => s + b[k] * b.n, 0) / n;
  return { trades: n, winRate: weighted('win'), avgReturn: weighted('avg'), betterRate: weighted('betterRate'), roseRate: weighted('roseRate') };
}
function summaryFor(r) {
  if (r.score == null) return 'Not enough data to judge this one.';
  if (r.rejected) return `Skip this one: ${r.rejected}.`;
  const f = r.facts;
  const trend = f.patYoY > 0.15 && f.salesYoY > 0.05 ? 'Profit and sales are both growing' : f.patYoY > 0 ? 'Profit is growing, but slowly' : 'Profit is falling compared to last year';
  const base = f.baseQuarterYoY < -0.1 ? ", and last year's quarter was weak, so it is easier to beat" : f.baseQuarterYoY > 0.2 ? ", but last year's quarter was strong, so it is harder to beat" : '';
  const run = f.run10 > 0.08 ? 'The stock already went up a lot, so some good news may be priced in.' : f.run10 < -0.05 ? 'The stock has been falling lately.' : 'The stock has not run up yet.';
  return `${trend}${base}. ${run}`;
}
function reasonsFor(r) {
  if (r.score == null) return [r.rejected ?? 'Could not get enough data for this company.'];
  const f = r.facts, out = [];
  if (r.rejected) out.push(`Filtered out: ${r.rejected}.`);
  out.push(`Profit ${pct(f.patYoY)} and sales ${pct(f.salesYoY)} vs last year (last 3 quarters).`);
  if (f.baseQuarterYoY != null) out.push(f.baseQuarterYoY < -0.1 ? `Same quarter last year was weak (${pct(f.baseQuarterYoY)}), so it is easier to beat.` : f.baseQuarterYoY > 0.2 ? `Same quarter last year was strong (${pct(f.baseQuarterYoY)}), so it is harder to beat.` : `Same quarter last year was normal (${pct(f.baseQuarterYoY)}).`);
  if (f.marginDelta != null) out.push(`Margin ${f.marginDelta >= 0 ? 'up' : 'down'} ${Math.abs(f.marginDelta).toFixed(1)} points vs last year.`);
  if (f.reactionsSeen) out.push(`Beat Nifty after ${f.reactionWins} of its last ${f.reactionsSeen} results.`);
  out.push(`Stock moved ${pct(f.run10)} in the last 10 sessions.`);
  const sector = industryMove.get(r.industry);
  if (sector != null) out.push(`${r.industry} stocks are ${pct(sector)} against the Nifty over 3 months.`);
  if (r.signals?.volumeRatio != null) out.push(`Trading volume this week is ${r.signals.volumeRatio.toFixed(1)}x its normal level.`);
  if (r.signals?.fiiChange != null) out.push(`Last quarter FII holding changed ${r.signals.fiiChange >= 0 ? '+' : ''}${r.signals.fiiChange.toFixed(2)} points${r.signals.diiChange != null ? ` and DII ${r.signals.diiChange >= 0 ? '+' : ''}${r.signals.diiChange.toFixed(2)} points` : ''}.`);
  const crowd = crowdSignals(r.symbol);
  if (crowd) out.push(`Real buyers: ${crowd.pct3.toFixed(0)}% of traded shares were taken as delivery in the last 3 days (${crowd.change >= 0 ? '+' : ''}${crowd.change.toFixed(1)} points vs normal). Delivered shares are ${crowd.sharesRatio.toFixed(1)}x and number of trades ${crowd.tradesRatio.toFixed(1)}x normal.`);
  if (r.pe != null) out.push(`P/E is about ${Math.round(r.pe)}.`);
  return out;
}
const appRows = scored.map((r) => {
  const ev = r.error ? r.item : r;
  if (r.rejected === 'this quarter is already published') return null;
  const c = universe.get(ev.symbol);
  const label = r.error ? 'No data' : opinion(r);
  return {
    symbol: ev.symbol, company: c.company, industry: c.industry, date: ev.date, quarter: FY_QUARTER[targetQuarter(ev.date) % 4], label, score: r.score ?? null, filtered: !!r.rejected, chanceYoY: r.chances?.yoy ?? null, chanceQoQ: r.chances?.qoq ?? null, summary: r.error ? 'Could not get data for this company today.' : summaryFor(r),
    reasons: r.error ? ['Could not get data for this company today.'] : reasonsFor(r),
    buyOn: r.buyOn ?? null, sellOn: r.sellOn ?? null, tooLate: !!r.tooLate, late: !!r.late, lastClose: r.facts?.close ?? null,
  };
}).filter(Boolean).sort((a, b) => LABELS.indexOf(a.label) - LABELS.indexOf(b.label) || (b.score ?? 0) - (a.score ?? 0));

const days = [...new Set(appRows.map((r) => r.date))].sort().map((date) => ({ date, companies: appRows.filter((r) => r.date === date) }));
// IPOs come from a separate site, so a problem there must not stop the company ratings.
let ipo = null;
try { ipo = await ipoReport(today); } catch (e) { console.warn('IPO data unavailable:', e.message); }

const payload = {
  ipo, generated: new Date().toISOString(), stopLossPct: RULES.stopLoss * 100, pick: pick?.symbol ?? null, pickDate: pick?.date ?? null, perStockRs: PER_STOCK_RS, picks: picks.map((p) => ({ symbol: p.symbol, date: p.date })),
  history: Object.fromEntries(Object.keys(BUCKETS_FOR).map((l) => [l, labelHistory(l)])), days,
};
// If most companies failed (for example a site blocked us), keep yesterday's ratings instead of replacing them with blanks.
const noData = appRows.filter((r) => r.label === 'No data').length;
if (appRows.length && noData > appRows.length / 2) throw new Error(`${noData} of ${appRows.length} companies have no data, not publishing.`);
fs.writeFileSync(new URL('./app/data.json', import.meta.url), JSON.stringify(payload));

if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/radar`, {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ id: 1, payload, updated_at: payload.generated }),
  });
  if (!res.ok) throw new Error(`Supabase upload failed: ${res.status} ${await res.text()}`);
  console.log('Uploaded to Supabase.');
}

console.log('\n' + md.join('\n'));
console.log(`Saved to reports/${today}.md`);
