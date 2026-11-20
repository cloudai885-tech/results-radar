// EDGE LAB - tests well-known, published trading strategies on 3 years of 1-minute data (Dukascopy, fx-download.mjs).
// Rules and settings are taken from the papers / the standard versions and fixed BEFORE looking at any result.
// No tuning. Each strategy is judged by the same pass rule (see VERDICT below).
//   node --max-old-space-size=8000 edge-lab.mjs            (all instruments that have data)
//   node --max-old-space-size=8000 edge-lab.mjs nas100,us30
//
// STRATEGIES
//  S1 ORB-5      Opening range breakout (Zarattini & Aziz 2023, "Can Day Trading Really Be Profitable?"). First 5-min candle
//                of the cash session: green -> buy at the next candle's open, red -> sell. Stop = other end of that candle.
//                Target 10R, else close at the session close. Indices (+ gold/silver/oil on the NY 9:30 open, outside the paper).
//  S2 Intraday momentum (Gao, Han, Li, Zhou 2018, JFE). Return from yesterday's close to 30 min after the open decides the
//                direction of a trade held over the LAST 30 minutes of the session. Indices.
//  S3 Noise-area breakout (Zarattini, Aziz, Barbon 2024, "Beat the Market"). Band = max/min(open, prev close) x (1 +/- average
//                absolute move from the open at that time of day over the last 14 days). Checked every 30 min: above the
//                band -> long, below -> short, exit when back inside, flat at the close. Indices.
//  S4 RSI(2)     Connors: close above the 200-day average and RSI(2) < 10 -> buy at the close; sell at the first close above
//                the 5-day average. Long only. Indices.
//  S5 Donchian   Turtle-style trend following on daily candles: close above the 20-day high -> long, below the 20-day low ->
//                short; exit when the close crosses the 10-day channel the other way. All instruments.
//  S6 London breakout  Asian range 00:00-07:00 London. First break of it between 07:00 and 10:00 -> trade that way, stop at
//                the other side of the range, target = 1x the range, else close at 16:00 London. EURUSD, GBPUSD, USDJPY.
//  S7 Overnight  Buy at the session close, sell at the next open (the "overnight drift"). Indices. The day leg is shown too.
//  S8 Turn of month  Buy at the close of the month's last trading day, sell at the close of the 3rd trading day. Indices.
//
// COSTS  spread + commission + slippage per round trip (below), plus an overnight financing charge for trades held overnight
//        (CFD swap, about 7% a year for indices/metals/oil, 18% for BTC, 2% for FX).
// VERDICT (fixed in advance) PASS = t-stat >= 2 AND profitable in the first 2 years AND in the last year (out-of-sample)
//        AND better than its random/placebo version AND still profitable with double costs.
//        ~45 tests are run, so about 1 lucky PASS is expected by chance: a PASS still needs a forward test.
import fs from 'node:fs';

const NY = 'America/New_York';
const ALL = {
  nas100: { file: 'usatechidxusd', idx: true, tz: NY, open: 570, close: 960, cost: 2.0, swap: 0.07 },
  us30: { file: 'usa30idxusd', idx: true, tz: NY, open: 570, close: 960, cost: 3.0, swap: 0.07 },
  us500: { file: 'usa500idxusd', idx: true, tz: NY, open: 570, close: 960, cost: 0.6, swap: 0.07 },
  ger40: { file: 'deuidxeur', idx: true, tz: 'Europe/Berlin', open: 540, close: 1050, cost: 2.0, swap: 0.07 },
  jpn225: { file: 'jpnidxjpy', idx: true, tz: 'Asia/Tokyo', open: 540, close: 900, cost: 12, swap: 0.07 },
  xauusd: { file: 'xauusd', tz: NY, open: 570, close: 960, cost: 0.5, swap: 0.07, orb: true },
  xagusd: { file: 'xagusd', tz: NY, open: 570, close: 960, cost: 0.035, swap: 0.07, orb: true },
  wti: { file: 'lightcmdusd', tz: NY, open: 570, close: 960, cost: 0.05, swap: 0.07, orb: true },
  btcusd: { file: 'btcusd', tz: NY, open: 570, close: 960, costPct: 0.0006, swap: 0.18 },
  eurusd: { file: 'eurusd', tz: NY, open: 570, close: 960, cost: 0.00013, swap: 0.02, london: true },
  gbpusd: { file: 'gbpusd', tz: NY, open: 570, close: 960, cost: 0.00018, swap: 0.02, london: true },
  usdjpy: { file: 'usdjpy', tz: NY, open: 570, close: 960, cost: 0.018, swap: 0.02, london: true },
};
const SPLIT = '2025-11-01', LAST6 = '2026-05-20', MONTHS = 36.6;
const want = process.argv[2] ? process.argv[2].split(',') : Object.keys(ALL);
const out = [], summary = [];
const P = (...a) => { const l = a.join(' '); console.log(l); out.push(l); };

// ---------- local clock (any time zone, summer/winter time handled) ----------
const fmts = {}, cache = new Map();
function loc(t, tz) {
  const hk = Math.floor(t / 3600000), key = tz + hk;
  let v = cache.get(key);
  if (!v) {
    const f = (fmts[tz] ??= new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' }));
    const p = Object.fromEntries(f.formatToParts(new Date(hk * 3600000)).map((x) => [x.type, x.value]));
    v = { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 }; cache.set(key, v);
  }
  return { date: v.date, min: v.hour * 60 + (Math.floor(t / 60000) % 60) };
}
const rngOf = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

// ---------- stats ----------
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
function stats(tr) {
  const r = tr.map((x) => x.pct), n = r.length;
  if (!n) return { n: 0 };
  const avg = mean(r), sd = Math.sqrt(r.reduce((s, x) => s + (x - avg) ** 2, 0) / Math.max(1, n - 1));
  const gw = r.filter((x) => x > 0).reduce((s, x) => s + x, 0), gl = -r.filter((x) => x < 0).reduce((s, x) => s + x, 0);
  let cum = 0, peak = 0, dd = 0; for (const x of r) { cum += x; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); }
  const Rs = tr.filter((x) => x.R != null).map((x) => x.R);
  return { n, win: r.filter((x) => x > 0).length / n, avg, t: sd > 0 ? avg / (sd / Math.sqrt(n)) : 0, pf: gl > 0 ? gw / gl : Infinity, total: cum, dd, avgR: Rs.length ? mean(Rs) : null, avg2x: avg - mean(tr.map((x) => x.costPct)) };
}
const sub = (tr, f) => stats(tr.filter(f));
const pc = (v, d = 3) => (Number.isFinite(v) ? (v * 100).toFixed(d) + '%' : '-');
function report(name, inst, tr, placebo) {
  const a = stats(tr), is = sub(tr, (x) => x.date < SPLIT), oos = sub(tr, (x) => x.date >= SPLIT), l6 = sub(tr, (x) => x.date >= LAST6);
  const pl = placebo ? stats(placebo) : null;
  const pass = a.n >= 30 && a.t >= 2 && is.avg > 0 && oos.avg > 0 && (!pl || a.avg > pl.avg) && a.avg2x > 0;
  const years = {}; for (const x of tr) (years[x.date.slice(0, 4)] ??= []).push(x);
  if (!a.n) { P(`  ${name.padEnd(26)} ${inst.padEnd(7)} no trades`); return; }
  P(`  ${name.padEnd(26)} ${inst.padEnd(7)} ${String(a.n).padStart(4)} tr (${(a.n / MONTHS).toFixed(1)}/mo) | won ${pc(a.win, 0).padStart(4)} | avg ${pc(a.avg).padStart(8)}${a.avgR != null ? ` (${a.avgR.toFixed(2)}R)` : ''} | t ${a.t.toFixed(2).padStart(5)} | PF ${a.pf.toFixed(2)} | total ${pc(a.total, 1)} | maxDD ${pc(a.dd, 1)} | first 2y ${pc(is.avg)} (${is.n}) | last 1y ${pc(oos.avg)} (${oos.n}) | last 6m ${pc(l6.avg)} (${l6.n}) | placebo ${pl ? pc(pl.avg) : '-'} | 2x cost ${pc(a.avg2x)} | ${pass ? 'PASS' : 'fail'}`);
  P(`      by year: ${Object.entries(years).map(([y, v]) => { const s = stats(v); return `${y} ${pc(s.avg)} (${s.n}, won ${pc(s.win, 0)})`; }).join(' | ')}`);
  summary.push({ strategy: name, inst, ...a, isAvg: is.avg, isN: is.n, oosAvg: oos.avg, oosN: oos.n, l6Avg: l6.avg, l6N: l6.n, placebo: pl?.avg ?? null, pass, years: Object.fromEntries(Object.entries(years).map(([y, v]) => [y, stats(v)])) });
}

// ---------- per-instrument work ----------
for (const key of want) {
  const I = ALL[key]; if (!I) continue;
  const path = new URL(`./data/${I.file}-m1.json`, import.meta.url);
  if (!fs.existsSync(path)) { P(`\n### ${key}: no data file, skipped`); continue; }
  const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
  const N = raw.length, T = new Float64Array(N), O = new Float64Array(N), H = new Float64Array(N), L = new Float64Array(N), C = new Float64Array(N);
  for (let i = 0; i < N; i++) { const r = raw[i]; T[i] = r[0]; O[i] = r[1]; H[i] = r[2]; L[i] = r[3]; C[i] = r[4]; }
  const cost = (px) => (I.costPct ? px * I.costPct : I.cost);
  const swapN = (nights) => (I.swap / 365) * nights;
  P(`\n### ${key.toUpperCase()} (${I.file}) ${N.toLocaleString()} 1-min candles ${new Date(T[0]).toISOString().slice(0, 10)} .. ${new Date(T[N - 1]).toISOString().slice(0, 10)} | price ${C[N - 1]} | cost ${I.costPct ? I.costPct * 100 + '%' : I.cost} a trade (${pc(cost(C[N - 1]) / C[N - 1])})`);

  function sessions(tz, open, close) {
    const mins = new Int16Array(N), days = []; let cur = null;
    for (let i = 0; i < N; i++) {
      const { date, min } = loc(T[i], tz); mins[i] = min;
      if (min < open || min >= close) continue;
      if (!cur || cur.date !== date) { cur = { date, s: i, e: i + 1 }; days.push(cur); } else cur.e = i + 1;
    }
    return { mins, days: days.filter((d) => mins[d.s] <= open + 2 && mins[d.e - 1] >= close - 10 && d.e - d.s > (close - open) * 0.6) };
  }
  const firstAt = (S, d, m) => { for (let j = d.s; j < d.e; j++) if (S.mins[j] >= m) return j; return -1; };
  // walk 1-min candles from k: stop counted first; gap through a level fills at the open
  function walk(k, e, dir, entry, stop, tgt) {
    for (let j = k; j < e; j++) {
      if (dir > 0) { if (L[j] <= stop) return Math.min(O[j], stop); if (tgt != null && H[j] >= tgt) return Math.max(O[j], tgt); }
      else { if (H[j] >= stop) return Math.max(O[j], stop); if (tgt != null && L[j] <= tgt) return Math.min(O[j], tgt); }
    }
    return C[e - 1];
  }
  const mk = (date, dir, entry, exit, nights = 0, risk = null) => {
    const net = (exit - entry) * dir - cost(entry);
    return { date, dir, entry, exit, pct: net / entry - swapN(nights), R: risk ? net / risk : null, costPct: cost(entry) / entry + swapN(nights) };
  };

  const S = sessions(I.tz, I.open, I.close);
  P(`  sessions: ${S.days.length} full days (${I.tz} ${Math.floor(I.open / 60)}:${String(I.open % 60).padStart(2, '0')}-${Math.floor(I.close / 60)}:${String(I.close % 60).padStart(2, '0')})`);

  // S1 ORB
  if (I.idx || I.orb) {
    const orb = (mode, rng) => {
      const tr = [];
      for (const d of S.days) {
        let k = d.s, h = -Infinity, l = Infinity, c = NaN; const o = O[d.s];
        while (k < d.e && S.mins[k] < I.open + 5) { h = Math.max(h, H[k]); l = Math.min(l, L[k]); c = C[k]; k++; }
        if (k >= d.e || c === o) continue;
        let dir = c > o ? 1 : -1; if (mode === 'random') dir = rng() < 0.5 ? 1 : -1;
        const entry = O[k], stop = dir > 0 ? l : h, R = (entry - stop) * dir; if (!(R > 0)) continue;
        tr.push(mk(d.date, dir, entry, walk(k, d.e, dir, entry, stop, entry + dir * 10 * R), 0, R));
      }
      return tr;
    };
    const rng = rngOf(7), pl = []; for (let r = 0; r < 20; r++) pl.push(...orb('random', rng));
    report('S1 ORB-5' + (I.idx ? '' : ' (NY 9:30)'), key, orb('real'), pl);
  }

  if (I.idx) {
    // S2 intraday momentum
    const im = (mode, rng) => {
      const tr = [];
      for (let i = 1; i < S.days.length; i++) {
        const d = S.days[i], pcl = C[S.days[i - 1].e - 1];
        const k30 = firstAt(S, d, I.open + 30), kE = firstAt(S, d, I.close - 30); if (k30 < 1 || kE < 0) continue;
        const sig = C[k30 - 1] / pcl - 1; if (!sig) continue;
        let dir = sig > 0 ? 1 : -1; if (mode === 'random') dir = rng() < 0.5 ? 1 : -1;
        tr.push(mk(d.date, dir, O[kE], C[d.e - 1]));
      }
      return tr;
    };
    { const rng = rngOf(11), pl = []; for (let r = 0; r < 20; r++) pl.push(...im('random', rng)); report('S2 Intraday momentum', key, im('real'), pl); }

    // S3 noise-area breakout
    const cps = []; for (let m = I.open + 30; m <= I.close - 30; m += 30) cps.push(m);
    const moves = S.days.map((d) => cps.map((m) => { const k = firstAt(S, d, m); return k > d.s ? Math.abs(C[k - 1] / O[d.s] - 1) : NaN; }));
    const na = (mode, rng) => {
      const tr = [];
      for (let i = 15; i < S.days.length; i++) {
        const d = S.days[i], op = O[d.s], pcl = C[S.days[i - 1].e - 1];
        let pos = 0, ent = 0;
        for (let c = 0; c < cps.length; c++) {
          const sig = mean(moves.slice(i - 14, i).map((v) => v[c]).filter(Number.isFinite)); const k = firstAt(S, d, cps[c]); if (k <= d.s || !Number.isFinite(sig)) continue;
          const p = C[k - 1], ub = Math.max(op, pcl) * (1 + sig), lb = Math.min(op, pcl) * (1 - sig);
          if (pos === 1 && p < ub) { tr.push(mk(d.date, pos * (mode === 'flip' ? -1 : 1), ent, O[k])); pos = 0; }
          if (pos === -1 && p > lb) { tr.push(mk(d.date, pos * (mode === 'flip' ? -1 : 1), ent, O[k])); pos = 0; }
          if (pos === 0 && p > ub) { pos = 1; ent = O[k]; } else if (pos === 0 && p < lb) { pos = -1; ent = O[k]; }
        }
        if (pos) tr.push(mk(d.date, pos * (mode === 'flip' ? -1 : 1), ent, C[d.e - 1]));
      }
      return tr;
    };
    report('S3 Noise-area breakout', key, na('real'), na('flip'));
  }

  // daily candles: indices = cash session; others = day ending 17:00 New York
  let D;
  if (I.idx) D = S.days.map((d) => { let h = -Infinity, l = Infinity; for (let j = d.s; j < d.e; j++) { h = Math.max(h, H[j]); l = Math.min(l, L[j]); } return { date: d.date, o: O[d.s], h, l, c: C[d.e - 1], t: T[d.e - 1] }; });
  else {
    D = []; let cur = null, cnt = 0;
    for (let i = 0; i < N; i++) {
      const { date } = loc(T[i] + 7 * 3600000, NY);
      if (!cur || cur.date !== date) { if (cur && cnt > 300) D.push(cur); cur = { date, o: O[i], h: H[i], l: L[i], c: C[i], t: T[i] }; cnt = 0; }
      else { cur.h = Math.max(cur.h, H[i]); cur.l = Math.min(cur.l, L[i]); cur.c = C[i]; cur.t = T[i]; }
      cnt++;
    }
    if (cur && cnt > 300) D.push(cur);
  }
  const nights = (a, b) => Math.max(1, Math.round((D[b].t - D[a].t) / 86400000));
  // long-only placebo: random entry days with the same holding lengths
  const holdPlacebo = (tr, holds, runs = 50) => { const rng = rngOf(3), pl = []; for (let r = 0; r < runs; r++) for (const h of holds) { const a = Math.floor(rng() * (D.length - h - 1)); pl.push(mk(D[a].date, 1, D[a].c, D[a + h].c, nights(a, a + h))); } return pl; };

  if (I.idx) {
    // S4 RSI(2)
    const rsi = new Float64Array(D.length); { let g = 0, l = 0; for (let i = 1; i < D.length; i++) { const ch = D[i].c - D[i - 1].c; g = i === 1 ? Math.max(ch, 0) : (g + Math.max(ch, 0)) / 2; l = i === 1 ? Math.max(-ch, 0) : (l + Math.max(-ch, 0)) / 2; rsi[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
    const sma = (i, n) => { let s = 0; for (let j = i - n + 1; j <= i; j++) s += D[j].c; return s / n; };
    const tr = [], holds = [];
    for (let i = 200; i < D.length; i++) {
      if (!(D[i].c > sma(i, 200) && rsi[i] < 10)) continue;
      let j = i + 1; while (j < D.length && !(D[j].c > sma(j, 5))) j++;
      if (j >= D.length) break;
      tr.push(mk(D[i].date, 1, D[i].c, D[j].c, nights(i, j))); holds.push(j - i); i = j;
    }
    report('S4 RSI(2) pullback', key, tr, holdPlacebo(tr, holds));
  }

  // S5 Donchian 20/10
  {
    const dch = (mode, rng) => {
      const tr = [];
      for (let i = 20; i < D.length; i++) {
        let hi = -Infinity, lo = Infinity; for (let j = i - 20; j < i; j++) { hi = Math.max(hi, D[j].h); lo = Math.min(lo, D[j].l); }
        let dir = D[i].c > hi ? 1 : D[i].c < lo ? -1 : 0; if (!dir) continue;
        if (mode === 'random') dir = rng() < 0.5 ? 1 : -1;
        let j = i + 1;
        for (; j < D.length; j++) { let h10 = -Infinity, l10 = Infinity; for (let q = j - 10; q < j; q++) { h10 = Math.max(h10, D[q].h); l10 = Math.min(l10, D[q].l); } if (dir > 0 ? D[j].c < l10 : D[j].c > h10) break; }
        if (j >= D.length) j = D.length - 1;
        tr.push(mk(D[i].date, dir, D[i].c, D[j].c, nights(i, j))); i = j;
      }
      return tr;
    };
    const rng = rngOf(5), pl = []; for (let r = 0; r < 20; r++) pl.push(...dch('random', rng));
    report('S5 Donchian 20/10 trend', key, dch('real'), pl);
  }

  if (I.idx) {
    // S7 overnight vs day
    const on = [], day = [], holds = [];
    for (let i = 1; i < S.days.length; i++) { const a = S.days[i - 1], b = S.days[i]; on.push(mk(b.date, 1, C[a.e - 1], O[b.s], Math.max(1, Math.round((T[b.s] - T[a.e - 1]) / 86400000)))); }
    for (const d of S.days) day.push(mk(d.date, 1, O[d.s], C[d.e - 1]));
    report('S7 Overnight hold (long)', key, on, null);
    report('   (same, day session long)', key, day, null);
    // S8 turn of month
    const tom = [], th = [];
    for (let i = 0; i + 3 < D.length; i++) if (D[i].date.slice(0, 7) !== D[i + 1].date.slice(0, 7)) { tom.push(mk(D[i].date, 1, D[i].c, D[i + 3].c, nights(i, i + 3))); th.push(3); }
    report('S8 Turn of month', key, tom, holdPlacebo(tom, th));
  }

  // S6 London breakout
  if (I.london) {
    const LS = sessions('Europe/London', 0, 960);
    const lb = (mode, rng) => {
      const tr = [];
      for (const d of LS.days) {
        let rh = -Infinity, rl = Infinity, k = d.s;
        while (k < d.e && LS.mins[k] < 420) { rh = Math.max(rh, H[k]); rl = Math.min(rl, L[k]); k++; }
        if (k >= d.e || !(rh > rl)) continue;
        for (; k < d.e && LS.mins[k] < 600; k++) {
          const up = H[k] >= rh, dn = L[k] <= rl; if (!up && !dn) continue; if (up && dn) break;
          let dir = up ? 1 : -1; const entry = up ? Math.max(O[k], rh) : Math.min(O[k], rl), rg = rh - rl;
          if (mode === 'random') dir = rng() < 0.5 ? 1 : -1;
          const R = mode === 'random' ? Math.abs(entry - (up ? rl : rh)) : (entry - (dir > 0 ? rl : rh)) * dir; if (!(R > 0)) break;
          tr.push(mk(d.date, dir, entry, walk(k + 1, d.e, dir, entry, entry - dir * R, entry + dir * rg), 0, R)); break;
        }
      }
      return tr;
    };
    const rng = rngOf(9), pl = []; for (let r = 0; r < 20; r++) pl.push(...lb('random', rng));
    report('S6 London breakout', key, lb('real'), pl);
  }
}

P('\n=== PASSED (all rules) ===');
for (const s of summary.filter((x) => x.pass)) P(`  ${s.strategy} ${s.inst}: ${s.n} trades, avg ${pc(s.avg)}, t ${s.t.toFixed(2)}, first 2y ${pc(s.isAvg)}, last 1y ${pc(s.oosAvg)}, last 6m ${pc(s.l6Avg)}`);
if (!summary.some((x) => x.pass)) P('  none');
fs.mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
const tag = process.argv[2] ? '-' + process.argv[2].replace(/,/g, '_') : '';
fs.writeFileSync(new URL(`./results/edge-lab${tag}-report.txt`, import.meta.url), out.join('\n'));
fs.writeFileSync(new URL(`./results/edge-lab${tag}-summary.json`, import.meta.url), JSON.stringify(summary, null, 1));
