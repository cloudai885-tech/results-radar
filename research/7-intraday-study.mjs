// Step 7: catch the movers that start AFTER the open. Decision at 9:30 or 9:45 using the first 15/30 minutes.
// Buy at the next 5-minute bar's open, then walk the 5-minute bars in order: -3% stop, +7% target, else sell 3:20 pm.
// Days are split in time: first half TRAIN, next quarter VALID, last quarter TEST (never used for choosing).
//   node research/7-intraday-study.mjs
import fs from 'node:fs';

const DIR = new URL('../data/research/', import.meta.url);
const intra = JSON.parse(fs.readFileSync(new URL('intraday.json', DIR), 'utf8'));
const funda = fs.existsSync(new URL('fundamentals.json', DIR)) ? JSON.parse(fs.readFileSync(new URL('fundamentals.json', DIR), 'utf8')) : {};
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const pct = (v, d = 2) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%`;
const STOP = 0.03, TARGET = 0.07, EXIT = 1515; // the 15:15 bar closes at 3:20 pm

const allDays = [...new Set(Object.values(intra).flatMap((d) => Object.keys(d)))].sort();
// a day counts only if most stocks have a full session
const fullDays = allDays.filter((d) => Object.values(intra).filter((s) => (s[d]?.length ?? 0) >= 70).length > 500);
const WARM = 10;
const usable = fullDays.slice(WARM);
const cut1 = usable[Math.floor(usable.length * 0.5)], cut2 = usable[Math.floor(usable.length * 0.75)];
const periodOf = (d) => (d < cut1 ? 'train' : d < cut2 ? 'valid' : 'test');
console.log(`${fullDays.length} full days (${fullDays[0]} to ${fullDays.at(-1)}). Train from ${usable[0]}, valid from ${cut1}, test from ${cut2}.`);

function buildRows(T) {
  const rows = [];
  // pass 1: per stock-day features that do not need other stocks
  for (const [sym, days] of Object.entries(intra)) {
    const sector = funda[sym]?.sector ?? 'Unknown';
    const daily = fullDays.map((d) => days[d] ?? null);
    for (let k = WARM; k < fullDays.length; k++) {
      const bars = daily[k], prevBars = daily[k - 1];
      if (!bars || !prevBars || bars.length < 60 || bars[0][0] !== 915) continue;
      const done = bars.filter((b) => b[0] < T), rest = bars.filter((b) => b[0] >= T && b[0] <= EXIT);
      if (done.length < 2 || !rest.length) continue;
      const prevClose = prevBars.at(-1)[4], open = bars[0][1], last = done.at(-1)[4];
      const hiSoFar = Math.max(...done.map((b) => b[2])), loSoFar = Math.min(...done.map((b) => b[3]));
      const volSoFar = done.reduce((s, b) => s + b[5], 0);
      const pastSame = []; const pastTurn = [];
      for (let j = k - 10; j < k; j++) { const pb = daily[j]; if (!pb) continue; pastSame.push(pb.filter((b) => b[0] < T).reduce((s, b) => s + b[5], 0)); pastTurn.push(pb.reduce((s, b) => s + b[4] * b[5], 0) / 1e7); }
      if (pastSame.length < 6) continue;
      const liq = median(pastTurn);
      if (liq < 2) continue;
      const closes = daily.slice(k - 11, k).filter(Boolean).map((b) => b.at(-1)[4]);
      const hi20 = Math.max(...daily.slice(Math.max(0, k - 20), k).filter(Boolean).flatMap((b) => b.map((x) => x[2])));
      const pp = daily[k - 2]?.at(-1)?.[4];
      // outcome: walk the bars in order
      const cost = 0.0012 + 0.001 + (liq >= 20 ? 0.0005 : liq >= 5 ? 0.0015 : 0.003); // charges + entry slippage + spread
      const entry = rest[0][1];
      let ret = null;
      for (const b of rest) {
        if (b[3] <= entry * (1 - STOP)) { ret = -STOP; break; }
        if (b[2] >= entry * (1 + TARGET)) { ret = TARGET; break; }
      }
      if (ret == null) ret = rest.at(-1)[4] / entry - 1;
      rows.push({
        sym, day: fullDays[k], di: k, period: periodOf(fullDays[k]), sector, liq,
        gap: open / prevClose - 1, sinceOpen: last / open - 1, fromPrev: last / prevClose - 1,
        rangePos: hiSoFar > loSoFar ? (last - loSoFar) / (hiSoFar - loSoFar) : 0.5, atHigh: last >= hiSoFar * 0.998,
        rvol: volSoFar / (mean(pastSame) || 1), yRet: pp ? prevClose / pp - 1 : 0, mom10: closes.length > 5 ? prevClose / closes[0] - 1 : 0,
        newHigh20: hiSoFar > hi20, near20: prevClose / hi20 >= 0.98, price: last,
        trade: ret - cost, maxUp: Math.max(...rest.map((b) => b[2])) / entry - 1,
      });
    }
  }
  // pass 2: market and sector moves so far (median of all / same-sector stocks at the same moment)
  const byDay = new Map(), bySec = new Map();
  for (const r of rows) { (byDay.get(r.di) ?? byDay.set(r.di, []).get(r.di)).push(r.fromPrev); const k = `${r.sector}|${r.di}`; (bySec.get(k) ?? bySec.set(k, []).get(k)).push(r.fromPrev); }
  for (const r of rows) {
    r.mkt = median(byDay.get(r.di));
    const s = r.sector === 'Unknown' ? [] : bySec.get(`${r.sector}|${r.di}`);
    r.sec = s.length >= 4 ? median(s) : null;
    r.vsSec = r.sec == null ? null : r.fromPrev - r.sec;
  }
  return rows;
}

const C = {
  'gap down 2%+': (r) => r.gap <= -0.02, 'gap 0..-2%': (r) => r.gap < 0 && r.gap > -0.02, 'gap 0..2%': (r) => r.gap >= 0 && r.gap < 0.02, 'gap 2-5%': (r) => r.gap >= 0.02 && r.gap < 0.05, 'gap 5%+': (r) => r.gap >= 0.05,
  'since open < -2%': (r) => r.sinceOpen <= -0.02, 'since open -2..0': (r) => r.sinceOpen > -0.02 && r.sinceOpen <= 0, 'since open 0..+1%': (r) => r.sinceOpen > 0 && r.sinceOpen < 0.01, 'since open +1..3%': (r) => r.sinceOpen >= 0.01 && r.sinceOpen < 0.03, 'since open +3%+': (r) => r.sinceOpen >= 0.03,
  'at day high now': (r) => r.atHigh, 'near day low now': (r) => r.rangePos <= 0.2,
  'volume 2x normal': (r) => r.rvol >= 2, 'volume 3x normal': (r) => r.rvol >= 3, 'volume 5x normal': (r) => r.rvol >= 5, 'volume quiet (<0.7x)': (r) => r.rvol < 0.7,
  'sector up 1%+ now': (r) => r.sec != null && r.sec >= 0.01, 'sector down 1%+ now': (r) => r.sec != null && r.sec <= -0.01,
  'beating sector by 2%+': (r) => r.vsSec != null && r.vsSec >= 0.02, 'lagging sector by 2%+': (r) => r.vsSec != null && r.vsSec <= -0.02,
  'market up now (>0.3%)': (r) => r.mkt > 0.003, 'market down now (<-0.3%)': (r) => r.mkt < -0.003,
  'rose 3%+ yesterday': (r) => r.yRet >= 0.03, 'fell 3%+ yesterday': (r) => r.yRet <= -0.03,
  'up 10%+ in 10 days': (r) => r.mom10 >= 0.1, 'down 10%+ in 10 days': (r) => r.mom10 <= -0.1,
  'breaking 20-day high today': (r) => r.newHigh20, 'was near 20-day high': (r) => r.near20,
  'big (Rs 50 cr+/day)': (r) => r.liq >= 50, 'small (Rs 2-5 cr/day)': (r) => r.liq < 5, 'price under Rs 100': (r) => r.price < 100,
};
const names = Object.keys(C);

function statsFor(list) {
  const byDay = new Map();
  for (const r of list) (byDay.get(r.di) ?? byDay.set(r.di, []).get(r.di)).push(r.trade);
  const d = [...byDay.values()].map(mean), all = list.map((r) => r.trade);
  return { n: all.length, days: d.length, avg: mean(d), win: mean(all.map((x) => (x > 0 ? 1 : 0))), t: d.length > 1 ? (mean(d) / (sd(d) || 1)) * Math.sqrt(d.length) : 0 };
}
const fmt = (s) => `n=${String(s.n).padStart(5)} ${String(s.days).padStart(2)}d day-avg ${pct(s.avg).padStart(7)} win ${pct(s.win, 0).padStart(4)}`;
const lines = [];
const log = (s = '') => { console.log(s); lines.push(s); };

for (const T of [930, 945]) {
  const rows = buildRows(T);
  const P = (p) => rows.filter((r) => r.period === p);
  log(`\n================ Decision at ${String(T).replace(/(\d+)(\d\d)$/, '$1:$2')} am: ${rows.length} stock-days ================`);
  for (const p of ['train', 'valid', 'test']) log(`Buy every stock at this time, ${p}: ${fmt(statsFor(P(p)))}`);
  const masks = Object.fromEntries(names.map((n) => [n, Uint8Array.from(rows, (r) => (C[n](r) ? 1 : 0))]));
  const idx = { train: [], valid: [], test: [] };
  rows.forEach((r, i) => idx[r.period].push(i));
  const found = [];
  const pick = (ids) => ids.map((i) => rows[i]);
  const pre = names.filter((n) => idx.train.filter((i) => masks[n][i]).length >= 60);
  let tried = 0;
  const consider = (combo, trainIds) => {
    tried++;
    const a = statsFor(pick(trainIds));
    if (a.days < 10 || a.avg <= 0.003 || a.t < 2) return;
    const b = statsFor(pick(idx.valid.filter((i) => combo.every((n) => masks[n][i]))));
    if (b.days < 6 || b.n < 25 || b.avg <= 0.002) return;
    const c = statsFor(pick(idx.test.filter((i) => combo.every((n) => masks[n][i]))));
    found.push({ combo, a, b, c });
  };
  for (let i = 0; i < pre.length; i++) {
    const li = idx.train.filter((x) => masks[pre[i]][x]);
    consider([pre[i]], li);
    for (let j = i + 1; j < pre.length; j++) {
      const lij = li.filter((x) => masks[pre[j]][x]);
      if (lij.length < 60) continue;
      consider([pre[i], pre[j]], lij);
      for (let k = j + 1; k < pre.length; k++) { const l3 = lij.filter((x) => masks[pre[k]][x]); if (l3.length >= 60) consider([pre[i], pre[j], pre[k]], l3); }
    }
  }
  found.sort((x, y) => Math.min(y.a.avg, y.b.avg) - Math.min(x.a.avg, x.b.avg));
  log(`${tried} patterns tried, ${found.length} made money in train (t>2) and valid. Top ones, with the TEST result shown only to judge:`);
  for (const f of found.slice(0, 25)) log(`  ${f.combo.join(' + ').padEnd(78)} train ${fmt(f.a)} | valid ${fmt(f.b)} | TEST ${fmt(f.c)}`);
  // daily basket from the top 10 rules: max 3 a day, one per sector
  const rules = found.slice(0, 10);
  for (const p of ['valid', 'test']) {
    const byDay = new Map();
    for (const i of idx[p]) {
      const hits = rules.filter((f) => f.combo.every((n) => masks[n][i]));
      if (!hits.length) continue;
      const r = rows[i];
      (byDay.get(r.di) ?? byDay.set(r.di, []).get(r.di)).push({ r, conf: Math.max(...hits.map((f) => Math.min(f.a.avg, f.b.avg))) });
    }
    const daily = [];
    for (const [, l] of [...byDay].sort((a, b) => a[0] - b[0])) {
      const picks = [], sec = new Set();
      for (const x of l.sort((a, b) => b.conf - a.conf || b.r.liq - a.r.liq)) { if (x.r.sector !== 'Unknown' && sec.has(x.r.sector)) continue; sec.add(x.r.sector); picks.push(x.r); if (picks.length === 3) break; }
      daily.push({ ret: mean(picks.map((r) => r.trade)), names: picks.map((r) => r.sym) });
    }
    const totalDays = new Set(idx[p].map((i) => rows[i].di)).size;
    let eq = 1, pk = 1, dd = 0; for (const d of daily) { eq *= 1 + d.ret; pk = Math.max(pk, eq); dd = Math.min(dd, eq / pk - 1); }
    log(`Basket (max 3/day) ${p}: picks on ${daily.length}/${totalDays} days, avg day ${pct(mean(daily.map((d) => d.ret)))}, win days ${pct(mean(daily.map((d) => (d.ret > 0 ? 1 : 0))), 0)}, total ${pct(eq - 1, 1)}, worst drop ${pct(dd, 1)}`);
  }
}
fs.writeFileSync(new URL('intraday-report.txt', DIR), lines.join('\n'));
