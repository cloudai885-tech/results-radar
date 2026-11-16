// Step 8: multi-week picks. Every Monday, for every liquid stock, use only what was known by Friday's close;
// buy at Monday's open, hold 1, 2 or 4 weeks with an 8% stop (checked on daily lows; a gap below the stop fills at the open).
// Patterns are chosen on TRAIN, confirmed on VALID, and a weekly top-5 basket is judged on TEST.
//   node research/8-swing.mjs
import fs from 'node:fs';

const DIR = new URL('../data/research/', import.meta.url);
const { days, stocks } = JSON.parse(fs.readFileSync(new URL('market.json', DIR), 'utf8'));
const funda = JSON.parse(fs.readFileSync(new URL('fundamentals.json', DIR), 'utf8'));
const PERIODS = { train: ['2025-01-01', '2025-09-30'], valid: ['2025-10-01', '2026-04-30'], test: ['2026-05-01', '2099-12-31'] };
const periodOf = (iso) => Object.keys(PERIODS).find((k) => iso >= PERIODS[k][0] && iso <= PERIODS[k][1]);
const HOLDS = { '1 week': 5, '2 weeks': 10, '4 weeks': 20 };
const STOP = 0.08, COST = 0.004;
const NOT_STOCK = /ETF|BEES|IETF|ADD$|^LIQUID|^GILT|^MON100|^MAFANG|^HNGSNG|^NIFTY|^SENSEX|^GOLD(CASE|SHARE|1|IETF)|^SILVER(1|IETF)/;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const pct = (v, d = 2) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%`;
const growth = (a, b) => (a == null || b == null || !(b > 0) ? null : (a - b) / b);

// first session of each week = entry day
const entryDays = [];
for (let i = 1; i < days.length; i++) if (new Date(days[i]).getUTCDay() < new Date(days[i - 1]).getUTCDay() || Date.parse(days[i]) - Date.parse(days[i - 1]) > 3 * 864e5) entryDays.push(i);

// series with split guard: drop a stock's history before any day where prev close disagrees with the last close by 2%+
const series = {};
for (const [sym, rows] of Object.entries(stocks)) {
  if (NOT_STOCK.test(sym)) continue;
  const arr = new Array(days.length);
  let last = null;
  for (const r of rows) {
    if (last && Math.abs(r[1] / last - 1) > 0.02) arr.fill(undefined); // corporate action: restart history
    arr[r[0]] = { prev: r[1], open: r[2], high: r[3], low: r[4], close: r[5], cr: r[6], deliv: r[7] };
    last = r[5];
  }
  series[sym] = arr;
}
// equal-weight market index (median daily return of liquid stocks) for the regime and relative strength
const mret = days.map(() => []);
for (const arr of Object.values(series)) arr.forEach((t, i) => { if (t && t.cr >= 2) mret[i].push(Math.max(-0.2, Math.min(0.2, t.close / t.prev - 1))); });
const mkt = []; mret.forEach((r, i) => mkt.push((mkt[i - 1] ?? 1) * (1 + median(r))));
// sector index the same way
const secRet = new Map();
for (const [sym, arr] of Object.entries(series)) { const s = funda[sym]?.sector; if (!s) continue; arr.forEach((t, i) => { if (!t || t.cr < 2) return; const k = `${s}|${i}`; (secRet.get(k) ?? secRet.set(k, []).get(k)).push(Math.max(-0.2, Math.min(0.2, t.close / t.prev - 1))); }); }
const secIdx = new Map();
for (const s of new Set(Object.values(funda).map((f) => f.sector).filter(Boolean))) { const idx = []; days.forEach((_, i) => idx.push((idx[i - 1] ?? 1) * (1 + median(secRet.get(`${s}|${i}`) ?? [0])))); secIdx.set(s, idx); }

// quarterly numbers become public about 45 days after the quarter ends (Screener has no filing dates for most stocks)
const ordEnd = (o) => Date.UTC(Math.floor(o / 4), (o % 4) * 3 + 3, 0);
const latestKnownQuarter = (iso) => { const t = Date.parse(iso); let o = Math.floor(t / 864e5 / 91.3) ; o = Number(iso.slice(0, 4)) * 4 + Math.floor((Number(iso.slice(5, 7)) - 1) / 3); while (ordEnd(o) + 45 * 864e5 > t) o--; return o; };

const rows = [];
for (const [sym, arr] of Object.entries(series)) {
  const f = funda[sym];
  for (const e of entryDays) {
    const d = e - 1; // Friday (last session before entry)
    if (d < 252 || !arr[e] || !arr[d]) continue;
    const hist = [];
    for (let j = d; j >= 0 && hist.length < 252; j--) if (arr[j]) hist.push(arr[j]);
    if (hist.length < 240) continue;
    const liq = median(hist.slice(0, 20).map((x) => x.cr));
    if (liq < 3) continue;
    const c = (k) => hist[k].close;
    const hi252 = Math.max(...hist.map((x) => x.high));
    const rets20 = hist.slice(0, 20).map((x) => x.close / x.prev - 1);
    const sector = f?.sector ?? 'Unknown', si = secIdx.get(sector);
    const r = {
      sym, day: days[e], di: e, period: periodOf(days[e]), sector, liq,
      m5: c(0) / c(5) - 1, m20: c(0) / c(20) - 1, m60: c(0) / c(60) - 1, m120: c(0) / c(120) - 1, m240: c(0) / c(239) - 1,
      fromHigh: c(0) / hi252 - 1, vol20: sd(rets20),
      volTrend: mean(hist.slice(0, 20).map((x) => x.cr)) / (mean(hist.slice(20, 80).map((x) => x.cr)) || 1),
      delivTrend: mean(hist.slice(0, 20).map((x) => x.deliv ?? 0)) - mean(hist.slice(20, 80).map((x) => x.deliv ?? 0)),
      rs60: c(0) / c(60) - mkt[d] / mkt[d - 60],
      sec60: si ? si[d] / si[d - 60] - 1 : null,
      mktUp: mkt[d] / mkt[d - 50] - 1 > 0, mkt20: mkt[d] / mkt[d - 20] - 1,
      pe: f?.pe ?? null, mcap: f?.mcap ?? null,
    };
    if (f) {
      const T = latestKnownQuarter(days[d]);
      const q = (o) => f.q[o] ?? {};
      if (q(T).pat != null && q(T - 4).pat != null) Object.assign(r, {
        patY: growth(q(T).pat, q(T - 4).pat), revY: growth(q(T).sales, q(T - 4).sales), patQ: growth(q(T).pat, q(T - 1).pat),
        marginUp: q(T).opm != null && q(T - 4).opm != null ? q(T).opm > q(T - 4).opm : null,
        record: q(T).pat > 0 && [1, 2, 3, 4, 5, 6, 7].every((k) => q(T - k).pat == null || q(T).pat > q(T - k).pat),
        twoQtrsGrowth: growth(q(T).pat, q(T - 4).pat) > 0.15 && growth(q(T - 1).pat, q(T - 5).pat) > 0.15,
        fiiUp: f.h[T]?.fii != null && f.h[T - 1]?.fii != null ? f.h[T].fii - f.h[T - 1].fii > 0.3 : null,
        diiUp: f.h[T]?.dii != null && f.h[T - 1]?.dii != null ? f.h[T].dii - f.h[T - 1].dii > 0.3 : null,
      });
    }
    // outcomes
    const entry = arr[e].open;
    for (const [label, n] of Object.entries(HOLDS)) {
      let out = null, j = e, seen = 0;
      for (; j < days.length && seen <= n; j++) {
        const t = arr[j]; if (!t) continue; seen++;
        if (j > e && t.open <= entry * (1 - STOP)) { out = t.open / entry - 1; break; }
        if (t.low <= entry * (1 - STOP)) { out = -STOP; break; }
        if (seen === n) { out = t.close / entry - 1; break; }
      }
      r[label] = out == null ? null : out - COST;
    }
    rows.push(r);
  }
}
const nWeeks = new Set(rows.map((r) => r.di)).size;
console.log(`${rows.length} stock-weeks over ${nWeeks} weeks.`, Object.fromEntries(Object.keys(PERIODS).map((p) => [p, new Set(rows.filter((r) => r.period === p).map((r) => r.di)).size + ' weeks'])));

const C = {
  'up 20%+ in 6 months': (r) => r.m120 >= 0.2, 'up 50%+ in 1 year': (r) => r.m240 >= 0.5, 'down 20%+ in 6 months': (r) => r.m120 <= -0.2,
  'up 10%+ in 3 months': (r) => r.m60 >= 0.1, 'beating market by 10%+ (3m)': (r) => r.rs60 >= 0.1, 'lagging market by 10%+ (3m)': (r) => r.rs60 <= -0.1,
  'within 5% of 52w high': (r) => r.fromHigh >= -0.05, '30%+ below 52w high': (r) => r.fromHigh <= -0.3,
  'dipped 3%+ last week': (r) => r.m5 <= -0.03, 'rose 5%+ last week': (r) => r.m5 >= 0.05, 'up last month': (r) => r.m20 > 0, 'down 10%+ last month': (r) => r.m20 <= -0.1,
  'calm (low daily swings)': (r) => r.vol20 < 0.018, 'wild (big daily swings)': (r) => r.vol20 > 0.035,
  'volume rising 1.5x': (r) => r.volTrend >= 1.5, 'delivery rising 5pts+': (r) => r.delivTrend >= 5,
  'sector up 10%+ (3m)': (r) => r.sec60 != null && r.sec60 >= 0.1, 'sector down (3m)': (r) => r.sec60 != null && r.sec60 < 0,
  'market uptrend (50d)': (r) => r.mktUp, 'market downtrend (50d)': (r) => !r.mktUp,
  'profit up 25%+ yr': (r) => r.patY != null && r.patY >= 0.25, 'profit down yr': (r) => r.patY != null && r.patY < 0, 'revenue up 15%+ yr': (r) => r.revY != null && r.revY >= 0.15,
  'margin up yr': (r) => r.marginUp === true, 'record profit': (r) => r.record === true, 'growth 2 quarters running': (r) => r.twoQtrsGrowth === true,
  'FII buying': (r) => r.fiiUp === true, 'DII buying': (r) => r.diiUp === true,
  'PE under 25': (r) => r.pe != null && r.pe > 0 && r.pe < 25, 'PE over 60': (r) => r.pe != null && r.pe >= 60,
  'large (20k cr+)': (r) => r.mcap != null && r.mcap >= 20000, 'small (< 5k cr)': (r) => r.mcap != null && r.mcap < 5000,
};
const names = Object.keys(C);
const masks = Object.fromEntries(names.map((n) => [n, Uint8Array.from(rows, (r) => (C[n](r) ? 1 : 0))]));
const idx = { train: [], valid: [], test: [] };
rows.forEach((r, i) => idx[r.period]?.push(i));
const lines = [];
const log = (s = '') => { console.log(s); lines.push(s); };
function statsFor(ids, key) {
  const byWeek = new Map();
  for (const i of ids) { const v = rows[i][key]; if (v == null) continue; (byWeek.get(rows[i].di) ?? byWeek.set(rows[i].di, []).get(rows[i].di)).push(v); }
  const w = [...byWeek.values()].map(mean), all = [...byWeek.values()].flat();
  return { n: all.length, weeks: w.length, avg: mean(w), win: mean(all.map((x) => (x > 0 ? 1 : 0))), t: w.length > 1 ? (mean(w) / (sd(w) || 1)) * Math.sqrt(w.length) : 0 };
}
const fmt = (s) => `n=${String(s.n).padStart(5)} ${String(s.weeks).padStart(2)}w avg ${pct(s.avg).padStart(7)} win ${pct(s.win, 0).padStart(4)}`;

for (const key of Object.keys(HOLDS)) {
  log(`\n================ Hold ${key} (8% stop, 0.4% costs) ================`);
  for (const p of ['train', 'valid', 'test']) log(`Every liquid stock, ${p}: ${fmt(statsFor(idx[p], key))}`);
  const found = [];
  const pre = names.filter((n) => idx.train.filter((i) => masks[n][i]).length >= 150);
  for (let i = 0; i < pre.length; i++) {
    const li = idx.train.filter((x) => masks[pre[i]][x]);
    const tryIt = (combo, ids) => {
      const a = statsFor(ids, key);
      if (a.weeks < 15 || a.avg <= 0.01 || a.t < 2) return;
      const b = statsFor(idx.valid.filter((x) => combo.every((n) => masks[n][x])), key);
      if (b.weeks < 12 || b.n < 60 || b.avg <= 0.005) return;
      found.push({ combo, a, b, c: statsFor(idx.test.filter((x) => combo.every((n) => masks[n][x])), key) });
    };
    tryIt([pre[i]], li);
    for (let j = i + 1; j < pre.length; j++) {
      const lij = li.filter((x) => masks[pre[j]][x]);
      if (lij.length < 150) continue;
      tryIt([pre[i], pre[j]], lij);
      for (let k = j + 1; k < pre.length; k++) { const l3 = lij.filter((x) => masks[pre[k]][x]); if (l3.length >= 150) tryIt([pre[i], pre[j], pre[k]], l3); }
    }
  }
  found.sort((x, y) => Math.min(y.a.avg, y.b.avg) - Math.min(x.a.avg, x.b.avg));
  log(`${found.length} patterns made money in train (t>2, 1%+) and valid. Top 20 (TEST shown only to judge):`);
  for (const f of found.slice(0, 20)) log(`  ${f.combo.join(' + ').padEnd(80)} train ${fmt(f.a)} | valid ${fmt(f.b)} | TEST ${fmt(f.c)}`);
  // weekly top-5 basket from the top 10 rules, one per sector; hold period = key (overlapping baskets averaged)
  const rules = found.slice(0, 10);
  for (const p of ['valid', 'test']) {
    const byWeek = new Map();
    for (const i of idx[p]) {
      if (rows[i][key] == null) continue;
      const hits = rules.filter((f) => f.combo.every((n) => masks[n][i]));
      if (hits.length) (byWeek.get(rows[i].di) ?? byWeek.set(rows[i].di, []).get(rows[i].di)).push({ r: rows[i], conf: Math.max(...hits.map((f) => Math.min(f.a.avg, f.b.avg))), hits: hits.length });
    }
    const weekly = [];
    for (const [, l] of [...byWeek].sort((a, b) => a[0] - b[0])) {
      const picks = [], sec = new Set();
      for (const x of l.sort((a, b) => b.hits - a.hits || b.conf - a.conf)) { if (x.r.sector !== 'Unknown' && sec.has(x.r.sector)) continue; sec.add(x.r.sector); picks.push(x.r); if (picks.length === 5) break; }
      weekly.push(mean(picks.map((r) => r[key])));
    }
    const totalW = new Set(idx[p].map((i) => rows[i].di)).size;
    log(`Top-5 basket ${p}: picks in ${weekly.length}/${totalW} weeks, avg basket ${pct(mean(weekly))} per ${key}, winning baskets ${pct(mean(weekly.map((w) => (w > 0 ? 1 : 0))), 0)}, worst basket ${pct(Math.min(...weekly, 0))}`);
  }
}
fs.writeFileSync(new URL('swing-report.txt', DIR), lines.join('\n'));
