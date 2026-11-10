// The single scoring model, used by both the live scan and the backtest.
// It only looks at data that existed before the entry date, so the backtest is honest.
// Weights are set by judgement and deliberately NOT fitted to the backtest.
import { quarterOrdinal } from './sources.mjs';

export const WEIGHTS = { profit: 20, sales: 15, consistency: 15, easyBase: 15, margin: 10, reactions: 15, momentum: 10 };
export const RULES = { minTradedValueRs: 10e7, maxRunUp10d: 0.2, stopLoss: 0.03, roundTripCost: 0.0035, sessionsBeforeToBuy: 2 };

const scale = (v, lo, hi) => Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// Growth that stays meaningful when the base is zero or negative.
function growth(now, base) {
  if (now == null || base == null) return null;
  if (base > 0) return Math.max(-1, Math.min(1, (now - base) / base));
  return now > base ? 1 : -1;
}

// The quarter being reported: latest quarter that ended at least 10 days before the meeting.
export function targetQuarter(dateIso) {
  const [y, m, d] = dateIso.split('-').map(Number);
  let ord = y * 4 + Math.floor((m - 1) / 3) - 1; // quarter that ended most recently
  const endMonth = (ord % 4) * 3 + 3;
  const end = Date.UTC(Math.floor(ord / 4), endMonth, 0);
  if ((Date.UTC(y, m - 1, d) - end) / 864e5 < 10) ord -= 1;
  return ord;
}

export function indexBefore(bars, dateIso) {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (bars[mid].date < dateIso) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}

const retOver = (bars, i, n) => (i - n >= 0 ? bars[i].close / bars[i - n].close - 1 : null);

function closeOn(bars, dateIso) {
  const i = indexBefore(bars, dateIso + 'z'); // last bar on or before the date
  return i >= 0 ? bars[i].close : null;
}

// Stock move vs Nifty across a past result: close before the meeting to close after it.
export function reactionFor(bars, nifty, dateIso) {
  const before = indexBefore(bars, dateIso);
  const after = indexBefore(bars, dateIso + 'z') + 1; // first session strictly after the meeting
  if (before < 0 || after >= bars.length) return null;
  const stock = bars[after].close / bars[before].close - 1;
  const n0 = closeOn(nifty, bars[before].date), n1 = closeOn(nifty, bars[after].date);
  if (!n0 || !n1) return null;
  return { date: dateIso, excess: stock - (n1 / n0 - 1), stock };
}

// bars must end at the entry session (inclusive); quarters is Map(ordinal -> numbers).
export function scoreEvent({ dateIso, quarters, bars, nifty, pastReactions }) {
  const T = targetQuarter(dateIso);
  const q = (o) => quarters.get(o) ?? {};
  const L = T - 1, L1 = T - 2;
  if (q(L).pat == null || q(L - 4).pat == null) return { rejected: 'not enough quarterly history' };

  const salesG = [growth(q(L).sales, q(L - 4).sales), growth(q(L1).sales, q(L1 - 4).sales)].filter((x) => x != null);
  const patG = [growth(q(L).pat, q(L - 4).pat), growth(q(L1).pat, q(L1 - 4).pat)].filter((x) => x != null);
  if (!salesG.length || !patG.length) return { rejected: 'not enough quarterly history' };

  const yoyFlags = [];
  for (let o = L; o > L - 6; o--) { const g = growth(q(o).pat, q(o - 4).pat); if (g != null) yoyFlags.push(g > 0 ? 1 : 0); }
  const baseGrowth = growth(q(T - 4).pat, q(T - 8).pat);
  const marginDelta = q(L).opm != null && q(L - 4).opm != null ? q(L).opm - q(L - 4).opm : null;

  const past = pastReactions.slice(-8);
  const wins = past.filter((r) => r.excess > 0).length;
  const hitRate = (wins + 2) / (past.length + 4); // shrunk toward 50% when history is short

  const i = bars.length - 1;
  if (i < 60) return { rejected: 'not enough price history' };
  const close = bars[i].close;
  const sma50 = avg(bars.slice(i - 49, i + 1).map((b) => b.close));
  const run10 = retOver(bars, i, 10);
  const ret20 = retOver(bars, i, 20);
  const n1 = closeOn(nifty, bars[i].date), n0 = closeOn(nifty, bars[i - 20].date);
  const rel20 = n0 && n1 ? ret20 - (n1 / n0 - 1) : 0;
  const tradedValue = median(bars.slice(i - 19, i + 1).map((b) => b.close * b.volume));

  const parts = {
    profit: scale(avg(patG), -0.1, 0.4),
    sales: scale(avg(salesG), -0.05, 0.25),
    consistency: yoyFlags.length >= 3 ? avg(yoyFlags) : 0.5,
    easyBase: baseGrowth == null ? 0.5 : scale(-baseGrowth, -0.3, 0.3),
    margin: marginDelta == null ? 0.5 : scale(marginDelta, -3, 3),
    reactions: scale(hitRate, 0.3, 0.7),
    momentum: 0.5 * (close > sma50 ? 1 : 0) + 0.5 * scale(rel20, -0.05, 0.1),
  };
  const raw = Object.entries(WEIGHTS).reduce((s, [k, w]) => s + w * parts[k], 0);
  const runUpPenalty = 10 * scale(run10, 0.08, 0.2); // the good news may already be in the price
  const score = Math.round((raw - runUpPenalty) * 10) / 10;

  let rejected = null;
  if (tradedValue < RULES.minTradedValueRs) rejected = 'too illiquid';
  else if (q(L).pat <= 0) rejected = 'loss-making last quarter';
  else if (run10 > RULES.maxRunUp10d) rejected = 'already ran up more than 20% in 10 sessions';

  return {
    score, rejected, parts,
    facts: {
      targetQuarter: T, salesYoY: avg(salesG), patYoY: avg(patG), baseQuarterYoY: baseGrowth, marginDelta,
      reactionsSeen: past.length, reactionWins: wins, run10, rel20, close, tradedValueCr: tradedValue / 1e7,
    },
  };
}

// Simulates one trade: buy at entry close, stop-loss checked daily, otherwise sell at exit close.
// If a stock opens below the stop, the fill is the open, which is how gaps really hurt.
export function simulateTrade(bars, entryIdx, exitIdx) {
  const entry = bars[entryIdx].close;
  const stop = entry * (1 - RULES.stopLoss);
  let exit = bars[exitIdx].close, stopped = false, gapped = false;
  for (let i = entryIdx + 1; i <= exitIdx; i++) {
    if (bars[i].open <= stop) { exit = bars[i].open; stopped = gapped = true; break; }
    if (bars[i].low <= stop) { exit = stop; stopped = true; break; }
  }
  return { net: exit / entry - 1 - RULES.roundTripCost, noStopNet: bars[exitIdx].close / entry - 1 - RULES.roundTripCost, stopped, gapped };
}

export { quarterOrdinal };
