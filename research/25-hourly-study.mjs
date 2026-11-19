// Step 25: the user sees 50-70 stocks rise every day and asks for a pattern tested on a year+ of charts.
// Hourly bars (step 24, ~Dec 2023 .. now). For every liquid stock-day, look at what was visible at 10:15 / 11:15 / 12:15,
// buy at that hour's close, sell at -2% stop (hourly low) or the day's close. Costs shown at 0.2% and 0.4%.
// HONEST SPLIT: patterns are chosen on TRAIN (before 2025-11-19) only; TEST = the last 12 months, never used to choose.
//   node --max-old-space-size=8000 research/25-hourly-study.mjs
import fs from 'node:fs';

const DIR = new URL('../data/research/', import.meta.url);
const read = (f) => JSON.parse(fs.readFileSync(new URL(f, DIR), 'utf8'));
const hourly = read('hourly.json');
const mk = read('market.json');
const funda = read('fundamentals.json');
const events = read('events-results.json');
const STOP = 0.02, SPLIT = '2025-11-19', RECENT = '2026-05-19';
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const pct = (v, d = 2) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : '   -  ');

// ---- daily facts from market.json: prev close, liquidity, yesterday / 5-day return, 52-week high ----
const dayIdx = new Map(mk.days.map((d, i) => [d, i]));
const daily = new Map(); // `${s}|${d}` -> {prev, cr, y1, r5, hi250}
for (const [s, rows] of Object.entries(mk.stocks)) {
  for (let k = 1; k < rows.length; k++) {
    const r = rows[k], d = mk.days[r[0]];
    if (d < '2024-01-15') continue;
    const past = rows.slice(Math.max(0, k - 20), k);
    const p250 = rows.slice(Math.max(0, k - 250), k);
    daily.set(`${s}|${d}`, {
      prev: r[1], cr: median(past.map((x) => x[6])),
      y1: rows[k - 1][5] / rows[k - 1][1] - 1,
      r5: k >= 6 ? rows[k - 1][5] / rows[k - 6][5] - 1 : NaN,
      hi250: Math.max(...p250.map((x) => x[3])),
    });
  }
}
// results filed after the previous close and before 9:00
const resultDay = new Set();
for (const e of events) {
  const [d, t = '00:00'] = e.time.split(' ');
  const i = mk.days.findIndex((x) => x > d || (x === d && t < '09:00'));
  if (i < 0 || (mk.days[i] === d && t >= '09:00')) continue;
  const pd = mk.days[i - 1];
  if (pd && (d < pd || (d === pd && t < '15:30'))) continue;
  resultDay.add(`${e.symbol}|${mk.days[i]}`);
}
const grp = (s) => funda[s]?.industry;

const days = [...new Set(Object.values(hourly).flatMap((x) => Object.keys(x)))].sort()
  .filter((d) => dayIdx.has(d) && Object.values(hourly).filter((x) => (x[d]?.length ?? 0) >= 7).length > 400);
console.log(`${days.length} full days ${days[0]}..${days.at(-1)}, ${Object.keys(hourly).length} stocks. TRAIN < ${SPLIT} <= TEST. Recent = from ${RECENT}.`);

// typical volume up to each hour (median of the previous 20 days), per stock
function buildRows(T) {
  const rows = [];
  for (const [s, byDay] of Object.entries(hourly)) {
    const ds = Object.keys(byDay).sort();
    const cumVol = ds.map((d) => byDay[d].filter((b) => b[0] < T).reduce((a, b) => a + b[5], 0));
    for (let k = 20; k < ds.length; k++) {
      const d = ds[k], bars = byDay[d];
      if (bars.length < 7 || bars[0][0] !== 915) continue;
      const f = daily.get(`${s}|${d}`);
      if (!f || !(f.cr >= 5) || !(f.prev > 0)) continue;
      const upto = bars.filter((b) => b[0] < T), after = bars.filter((b) => b[0] >= T);
      if (!upto.length || !after.length) continue;
      const open = bars[0][1], px = upto.at(-1)[4];
      const hi = Math.max(...upto.map((b) => b[2])), lo = Math.min(...upto.map((b) => b[3]));
      const normVol = median(cumVol.slice(k - 20, k));
      // outcome: stop -2% on later hourly lows, else the day's close
      let ret = null;
      for (const b of after) if (b[3] <= px * (1 - STOP)) { ret = -STOP; break; }
      if (ret == null) ret = bars.at(-1)[4] / px - 1;
      rows.push({
        s, d, g: grp(s), ret,
        rOpen: px / open - 1, gap: open / f.prev - 1, rPrev: px / f.prev - 1,
        relVol: normVol > 0 ? cumVol[k] / normVol : NaN,
        pos: hi > lo ? (px - lo) / (hi - lo) : 0.5, // where the price sits in the morning's range (1 = at the high)
        y1: f.y1, r5: f.r5, nearHi: px / f.hi250 - 1, cr: f.cr, result: resultDay.has(`${s}|${d}`),
      });
    }
  }
  // market + industry context per day
  const byDay = new Map();
  for (const r of rows) (byDay.get(r.d) ?? byDay.set(r.d, []).get(r.d)).push(r);
  for (const list of byDay.values()) {
    const market = median(list.map((r) => r.rOpen));
    const groups = new Map();
    for (const r of list) if (r.g) (groups.get(r.g) ?? groups.set(r.g, []).get(r.g)).push(r);
    const ranked = [...groups].filter(([, m]) => m.length >= 5).map(([g, m]) => ({ g, avg: mean(m.map((x) => x.rOpen)), breadth: m.filter((x) => x.rOpen > 0).length / m.length })).sort((a, b) => b.avg - a.avg);
    const rank = new Map(ranked.map((x, i) => [x.g, { i, n: ranked.length, ...x }]));
    for (const r of list) {
      r.market = market;
      const gr = rank.get(r.g);
      r.gRank = gr ? gr.i : null; r.gAvg = gr ? gr.avg : NaN; r.gBreadth = gr ? gr.breadth : NaN; r.gN = gr?.n;
      r.relGroup = gr ? r.rOpen - gr.avg : NaN;
    }
  }
  return rows;
}

// ---- feature buckets for the pattern search ----
const B = {
  rOpen: [['since open < -2%', (r) => r.rOpen < -0.02], ['since open -2..-0.5%', (r) => r.rOpen >= -0.02 && r.rOpen < -0.005], ['since open -0.5..+0.5%', (r) => Math.abs(r.rOpen) <= 0.005], ['since open +0.5..+2%', (r) => r.rOpen > 0.005 && r.rOpen <= 0.02], ['since open +2..+4%', (r) => r.rOpen > 0.02 && r.rOpen <= 0.04], ['since open > +4%', (r) => r.rOpen > 0.04]],
  gap: [['gap < -2%', (r) => r.gap < -0.02], ['gap -2..0%', (r) => r.gap >= -0.02 && r.gap < 0], ['gap 0..+2%', (r) => r.gap >= 0 && r.gap <= 0.02], ['gap > +2%', (r) => r.gap > 0.02]],
  relVol: [['volume < 1x', (r) => r.relVol < 1], ['volume 1-2x', (r) => r.relVol >= 1 && r.relVol < 2], ['volume 2-4x', (r) => r.relVol >= 2 && r.relVol < 4], ['volume > 4x', (r) => r.relVol >= 4]],
  pos: [['at morning low', (r) => r.pos < 0.2], ['mid range', (r) => r.pos >= 0.2 && r.pos <= 0.8], ['at morning high', (r) => r.pos > 0.8]],
  market: [['market < -0.5%', (r) => r.market < -0.005], ['market -0.5..0', (r) => r.market >= -0.005 && r.market < 0], ['market 0..+0.5%', (r) => r.market >= 0 && r.market <= 0.005], ['market > +0.5%', (r) => r.market > 0.005]],
  group: [['top-3 industry', (r) => r.gRank != null && r.gRank < 3], ['bottom-3 industry', (r) => r.gRank != null && r.gRank >= r.gN - 3], ['middle industry', (r) => r.gRank != null && r.gRank >= 3 && r.gRank < r.gN - 3]],
  y1: [['fell 3%+ yesterday', (r) => r.y1 <= -0.03], ['yesterday flat', (r) => r.y1 > -0.03 && r.y1 < 0.03], ['rose 3%+ yesterday', (r) => r.y1 >= 0.03]],
  r5: [['down 8%+ in 5 days', (r) => r.r5 <= -0.08], ['5 days normal', (r) => r.r5 > -0.08 && r.r5 < 0.08], ['up 8%+ in 5 days', (r) => r.r5 >= 0.08]],
  nearHi: [['at 52-week high', (r) => r.nearHi >= -0.01], ['within 10% of high', (r) => r.nearHi < -0.01 && r.nearHi >= -0.1], ['far below high', (r) => r.nearHi < -0.1]],
  size: [['Rs 5-20 cr/day', (r) => r.cr < 20], ['Rs 20-100 cr/day', (r) => r.cr >= 20 && r.cr < 100], ['Rs 100 cr+/day', (r) => r.cr >= 100]],
};
const stat = (list, cost) => { const v = list.map((r) => r.ret - cost); const m = mean(v); return { n: v.length, m, t: v.length > 1 ? m / (sd(v) / Math.sqrt(v.length)) : 0, win: v.filter((x) => x > 0).length / v.length }; };
const out = [];
const P = (...a) => { const l = a.join(' '); console.log(l); out.push(l); };

// FOCUS=1: check the patterns that survived TEST the way they would really be traded:
// no T2T stocks (series BE in the previous day's bhavcopy), at most 3 a day (most traded first), money split equally.
if (process.env.FOCUS) {
  const { fetchCached } = await import('../src/sources.mjs');
  const rows = buildRows(1015);
  const t2t = new Map();
  for (const d of days) {
    const i = dayIdx.get(d); if (!i) continue;
    const [y, m, dd] = mk.days[i - 1].split('-');
    const csv = await fetchCached(`https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${dd}${m}${y}.csv`, { ttlHours: 1e7, attempts: 2 }).catch(() => null);
    const set = new Set();
    if (csv?.startsWith('SYMBOL')) for (const line of csv.split(/\r?\n/).slice(1)) { const p = line.split(',').map((x) => x.trim()); if (p[1] === 'BE') set.add(p[0]); }
    t2t.set(d, set);
  }
  console.log(`T2T lists found for ${[...t2t.values()].filter((s) => s.size).length} of ${days.length} days`);
  const IDEAS = {
    'A gap up 2%+ after falling 3%+ yesterday': (r) => r.gap > 0.02 && r.y1 <= -0.03,
    'A2 gap up 2%+ after falling 8%+ in 5 days': (r) => r.gap > 0.02 && r.r5 <= -0.08,
    'A3 gap up 2%+, fell 3%+ yesterday AND 8%+ in 5 days': (r) => r.gap > 0.02 && r.y1 <= -0.03 && r.r5 <= -0.08,
    'B weak market (-0.5%), fell 3%+ yesterday and 8%+ in 5 days': (r) => r.market < -0.005 && r.y1 <= -0.03 && r.r5 <= -0.08,
    'C gap up 2%+, weak market, fell 3%+ yesterday': (r) => r.gap > 0.02 && r.market < -0.005 && r.y1 <= -0.03,
  };
  const PER = [['2024 H1', (d) => d < '2024-07'], ['2024 H2', (d) => d >= '2024-07' && d < '2025'], ['2025 H1', (d) => d >= '2025' && d < '2025-07'], ['2025 H2', (d) => d >= '2025-07' && d < '2026'], ['2026 H1', (d) => d >= '2026' && d < '2026-07'], ['2026 Jul-Nov', (d) => d >= '2026-07']];
  for (const [name, f] of Object.entries(IDEAS)) {
    for (const noT2T of [false, true]) {
      const byDay = new Map();
      for (const r of rows) if (f(r) && !(noT2T && t2t.get(r.d)?.has(r.s))) (byDay.get(r.d) ?? byDay.set(r.d, []).get(r.d)).push(r);
      for (const cost of [0.002, 0.004]) {
        const per = [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([d, l]) => { const p = l.sort((a, b) => b.cr - a.cr).slice(0, 3); return { d, v: mean(p.map((x) => x.ret - cost)), n: p.length, won: p.filter((x) => x.ret - cost > 0).length }; });
        let eq = 1, peak = 1, dd = 0; for (const x of per) { eq *= 1 + x.v; peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1); }
        const tr = per.reduce((s, x) => s + x.n, 0), won = per.reduce((s, x) => s + x.won, 0);
        const cell = (lab, pf) => { const p = per.filter((x) => pf(x.d)); return `${lab} ${pct(mean(p.map((x) => x.v)))} (${p.length}d)`; };
        P(`${name.padEnd(62)} ${noT2T ? 'no T2T' : 'all   '} cost ${cost * 100}% | ${per.length} days, ${tr} trades, won ${pct(won / tr, 0)}, avg/day ${pct(mean(per.map((x) => x.v)))}, worst dip ${pct(dd, 0)} | TEST ${pct(mean(per.filter((x) => x.d >= SPLIT).map((x) => x.v)))} | ${PER.map(([l, pf]) => cell(l, pf)).join(' | ')}`);
      }
    }
  }
  process.exit(0);
}

for (const T of [1015, 1115, 1215]) {
  const rows = buildRows(T);
  const train = rows.filter((r) => r.d < SPLIT), test = rows.filter((r) => r.d >= SPLIT), recent = rows.filter((r) => r.d >= RECENT);
  const tDays = [...new Set(train.map((r) => r.d))].sort(), mid = tDays[Math.floor(tDays.length / 2)];
  P(`\n================ decision at ${String(T).replace(/(\d\d)$/, ':$1')} · ${rows.length} stock-days ================`);
  for (const [lab, L] of [['TRAIN', train], ['TEST (last 12 months)', test], ['recent 6 months', recent]]) { const a = stat(L, 0.002); P(`Buy every stock (0.2% cost) ${lab.padEnd(22)} n=${a.n} avg ${pct(a.m)} won ${pct(a.win, 0)}`); }

  // named ideas
  P('\nNamed ideas (TRAIN | TEST | recent 6 months), after 0.2% costs; [0.4% costs in brackets]:');
  const named = {
    'sector leaders: top industry +1%, 70%+ green, market >= 0, stock in its top 3': (r) => r.gRank === 0 && r.gAvg >= 0.01 && r.gBreadth >= 0.7 && r.market >= 0 && r.relGroup > 0,
    'gap down 2%+ but now above the open (reversal)': (r) => r.gap <= -0.02 && r.rOpen > 0.005,
    '52-week high + volume 2x+ + above open': (r) => r.nearHi >= 0 && r.relVol >= 2 && r.rOpen > 0,
    'result overnight, above the open': (r) => r.result && r.rOpen > 0.005,
    'result overnight, below the open': (r) => r.result && r.rOpen < -0.005,
    'down 2%+ since open, market green (dip in a good market)': (r) => r.rOpen <= -0.02 && r.market > 0.002,
    'at morning high, volume 2x+, market green': (r) => r.pos > 0.8 && r.relVol >= 2 && r.market > 0,
    'fell 3%+ yesterday, opened down, now green': (r) => r.y1 <= -0.03 && r.gap < 0 && r.rPrev > 0,
  };
  for (const [k, f] of Object.entries(named)) {
    const a = stat(train.filter(f), 0.002), b = stat(test.filter(f), 0.002), c = stat(recent.filter(f), 0.002), b4 = stat(test.filter(f), 0.004);
    P(`  ${k.padEnd(78)} ${String(a.n).padStart(6)} ${pct(a.m)} | ${String(b.n).padStart(5)} ${pct(b.m)} [${pct(b4.m)}] won ${pct(b.win, 0)} | ${String(c.n).padStart(5)} ${pct(c.m)}`);
  }

  // pattern search: every pair and triple of buckets from different features, chosen on TRAIN only
  const feats = Object.keys(B), found = [];
  const N = train.length, rets = Float64Array.from(train, (r) => r.ret - 0.003), isH1 = Uint8Array.from(train, (r) => (r.d < mid ? 1 : 0));
  for (const k of feats) for (const b of B[k]) b.mask = Uint8Array.from(train, (r) => (b[1](r) ? 1 : 0));
  const tryCombo = (parts) => {
    const ms = parts.map((p) => p.mask);
    let n = 0, s = 0, s2 = 0, n1 = 0, s1 = 0;
    for (let i = 0; i < N; i++) {
      if (!ms[0][i] || !ms[1][i] || (ms[2] && !ms[2][i])) continue;
      const v = rets[i]; n++; s += v; s2 += v * v; if (isH1[i]) { n1++; s1 += v; }
    }
    if (n < 400) return;
    const m = s / n, t = m / (Math.sqrt(Math.max(1e-12, s2 / n - m * m)) / Math.sqrt(n));
    if (t < 3 || m <= 0 || n1 === 0 || n1 === n || s1 <= 0 || s - s1 <= 0) return;
    const fns = parts.map((p) => p[1]);
    found.push({ label: parts.map(([l]) => l).join(' + '), f: (r) => fns.every((fn) => fn(r)), a: { n, m, t } });
  };
  for (let i = 0; i < feats.length; i++) for (let j = i + 1; j < feats.length; j++) {
    for (const x of B[feats[i]]) for (const y of B[feats[j]]) tryCombo([x, y]);
    for (let k = j + 1; k < feats.length; k++) for (const x of B[feats[i]]) for (const y of B[feats[j]]) for (const z of B[feats[k]]) tryCombo([x, y, z]);
  }
  found.sort((p, q) => q.a.t - p.a.t);
  P(`\nPattern search: ${found.length} combos made money in TRAIN (t>3, both halves, after 0.3% costs). Top 25 by TRAIN strength, then their TEST result:`);
  for (const x of found.slice(0, 25)) {
    const b = stat(test.filter(x.f), 0.002), c = stat(recent.filter(x.f), 0.002), b4 = stat(test.filter(x.f), 0.004);
    P(`  ${x.label.padEnd(80)} train ${String(x.a.n).padStart(5)} ${pct(x.a.m + 0.001)} | TEST ${String(b.n).padStart(5)} ${pct(b.m)} [${pct(b4.m)}] won ${pct(b.win, 0)} | recent ${String(c.n).padStart(4)} ${pct(c.m)}`);
  }
  const held = found.map((x) => ({ ...x, b: stat(test.filter(x.f), 0.002) })).filter((x) => x.b.n >= 100);
  P(`  Of ${held.length} train winners with 100+ TEST trades: ${held.filter((x) => x.b.m > 0).length} still positive in TEST at 0.2% costs, ${held.filter((x) => stat(test.filter(x.f), 0.004).m > 0).length} at 0.4%.`);
}
fs.writeFileSync(new URL('hourly-report.txt', DIR), out.join('\n'));
