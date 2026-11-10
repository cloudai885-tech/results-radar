// Calculates the chance that a coming result beats last year's quarter and the previous quarter.
// It learns from past results using only what was known before each one.
import { targetQuarter, indexBefore } from './score.mjs';

const avg = (a) => { const v = a.filter((x) => x != null && Number.isFinite(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
const growth = (a, b) => { if (a == null || b == null) return null; if (b > 0) return Math.max(-1, Math.min(1, (a - b) / b)); return a > b ? 1 : -1; };
const ret = (b, i, n) => (i - n >= 0 ? b[i].close / b[i - n].close - 1 : null);

// bars must end at the entry session. Returns a plain object of numbers (null when unknown).
export function modelFeatures({ dateIso, quarters, bars, nifty, pastReactions }) {
  const T = targetQuarter(dateIso);
  const q = (o) => quarters.get(o) ?? {};
  const L = T - 1, L1 = T - 2, L2 = T - 3;
  const yoy = (o, k) => growth(q(o)[k], q(o - 4)[k]);
  const patY = [L, L1, L2].map((o) => yoy(o, 'pat'));
  const i = bars.length - 1, close = bars[i].close;
  const nE = indexBefore(nifty, bars[i].date + 'z');
  const ttm = [L, L1, L2, L - 3].map((o) => q(o).eps);
  const eps = ttm.every((x) => x != null) ? ttm.reduce((a, x) => a + x, 0) : null;
  const high = Math.max(...bars.slice(Math.max(0, i - 251), i + 1).map((x) => x.high));
  const logRets = [];
  for (let k = Math.max(1, i - 19); k <= i; k++) logRets.push(Math.log(bars[k].close / bars[k - 1].close));
  const mu = avg(logRets);
  const past = pastReactions.slice(-8);
  const rel = (n) => { const a = ret(bars, i, n), b = ret(nifty, nE, n); return a == null || b == null ? null : a - b; };
  const opmOk = [q(L).opm, q(L1).opm, q(L - 4).opm, q(L1 - 4).opm].every((x) => x != null);
  return {
    patYoY: avg(patY),
    salesYoY: avg([L, L1, L2].map((o) => yoy(o, 'sales'))),
    lastSalesYoY: yoy(L, 'sales'),
    acceleration: patY[0] != null && patY[1] != null ? patY[0] - patY[1] : null,
    streak: avg(patY.map((x) => (x == null ? null : x > 0 ? 1 : 0))),
    marginYoY: q(L).opm != null && q(L - 4).opm != null ? q(L).opm - q(L - 4).opm : null,
    marginTrend: opmOk ? (q(L).opm - q(L1).opm) - (q(L - 4).opm - q(L1 - 4).opm) : null,
    baseYoY: growth(q(T - 4).pat, q(T - 8).pat),
    seasonProfit: growth(q(T - 4).pat, q(T - 5).pat), // how this quarter moved vs the one before it, last year
    seasonSales: growth(q(T - 4).sales, q(T - 5).sales),
    otherIncomeShare: q(L).pbt > 0 && q(L).otherIncome != null ? Math.min(2, q(L).otherIncome / q(L).pbt) : null,
    pastReactionRate: past.length ? past.filter((r) => r.excess > 0).length / past.length : null,
    run10: ret(bars, i, 10),
    rel20: rel(20),
    rel60: rel(60),
    above50: i >= 49 ? (close > avg(bars.slice(i - 49, i + 1).map((x) => x.close)) ? 1 : 0) : null,
    near52WeekHigh: Math.log(close / high),
    volatility: Math.sqrt(avg(logRets.map((x) => (x - mu) ** 2))),
    logPE: eps > 0 ? Math.min(5, Math.log(close / eps)) : null,
    lossMaking: eps != null && eps <= 0 ? 1 : 0,
  };
}

export function fitLogistic(rows, yKey, iterations = 300) {
  const ok = rows.filter((r) => r.y[yKey] != null);
  const names = Object.keys(ok[0].X);
  const scale = {};
  for (const n of names) {
    const v = ok.map((r) => r.X[n]).filter((x) => x != null && Number.isFinite(x));
    const m = v.reduce((a, x) => a + x, 0) / (v.length || 1);
    scale[n] = [m, Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length || 1)) || 1];
  }
  const vec = (X) => names.map((n) => standard(X[n], scale[n]));
  const data = ok.map((r) => vec(r.X)), target = ok.map((r) => r.y[yKey]);
  const weights = new Array(names.length).fill(0);
  let intercept = 0;
  for (let it = 0; it < iterations; it++) {
    const grad = new Array(names.length).fill(0);
    let g0 = 0;
    for (let i = 0; i < data.length; i++) {
      let z = intercept;
      for (let j = 0; j < names.length; j++) z += weights[j] * data[i][j];
      const d = 1 / (1 + Math.exp(-z)) - target[i];
      g0 += d;
      for (let j = 0; j < names.length; j++) grad[j] += d * data[i][j];
    }
    intercept -= 0.3 * g0 / data.length;
    for (let j = 0; j < names.length; j++) weights[j] -= 0.3 * (grad[j] / data.length + 0.02 * weights[j]);
  }
  return { names, scale, weights, intercept };
}

// Unknown values become 0, which means "average" after standardising.
function standard(x, [m, s]) {
  return x == null || !Number.isFinite(x) ? 0 : Math.max(-3, Math.min(3, (x - m) / s));
}

export function predict(model, X) {
  let z = model.intercept;
  model.names.forEach((n, j) => { z += model.weights[j] * standard(X[n], model.scale[n]); });
  return 1 / (1 + Math.exp(-z));
}

export function auc(pairs) {
  const a = [...pairs].sort((x, y) => x[0] - y[0]);
  let rankSum = 0, positives = 0, i = 0;
  while (i < a.length) {
    let j = i;
    while (j < a.length && a[j][0] === a[i][0]) j++;
    const rank = (i + j + 1) / 2;
    for (let k = i; k < j; k++) if (a[k][1]) { rankSum += rank; positives++; }
    i = j;
  }
  return (rankSum - positives * (positives + 1) / 2) / (positives * (a.length - positives));
}

// Extra information shown on each company. These did not improve the calculated chance in testing.
export function demandSignals(bars, holdings) {
  const i = bars.length - 1;
  const mean = (n) => avg(bars.slice(Math.max(0, i - n + 1), i + 1).map((b) => b.volume));
  const dates = [...holdings.keys()].sort((a, b) => a - b).filter((k) => holdings.get(k).fii != null);
  const now = holdings.get(dates.at(-1)), prev = holdings.get(dates.at(-2));
  return {
    volumeRatio: mean(60) > 0 ? mean(5) / mean(60) : null,
    fiiChange: now && prev ? now.fii - prev.fii : null,
    diiChange: now && prev && now.dii != null && prev.dii != null ? now.dii - prev.dii : null,
  };
}
