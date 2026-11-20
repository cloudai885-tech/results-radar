// GRID LAB - famous retail / forex strategies x timeframes x markets, standard settings only (no tuning).
//   node --max-old-space-size=8000 grid-lab.mjs                       discovery: 1-min data Nov 2023 - Nov 2026
//   node --max-old-space-size=8000 grid-lab.mjs all h1 2018-03-01 2023-11-01   check on UNSEEN hourly data (1H/4H/D only)
//
// TIMEFRAMES  5m / 15m / 1H INTRADAY (enter only inside the market's session window, everything closed at its end)
//             1H / 4H / Daily SWING (held overnight, pays financing)
// SESSION WINDOWS (intraday)  US indices 9:30-16:00 NY, GER40 9:00-17:30 Berlin, JPN225 9:00-15:00 Tokyo,
//             FX / metals / oil 3:00-16:00 NY (London + New York), BTC whole NY day.
// Signals are taken on a candle's CLOSE and filled at the NEXT candle's open (no look-ahead). Stops are counted before
// targets when both fall inside one candle.
// STRATEGIES (standard textbook settings)
//  EMA 9/21 cross      buy when EMA9 crosses above EMA21, sell when below (stop and reverse).
//  EMA 50/200 cross    same with 50/200 ("golden cross").
//  MACD 12/26/9        MACD line crosses its signal line (stop and reverse).
//  RSI 30/70           RSI(14) crosses back above 30 -> buy; back below 70 -> sell (stop and reverse).
//  Bollinger bounce    close below the lower band (20, 2) -> buy, exit at the middle band; mirror for sells.
//  Donchian 20/10      close above the 20-candle high -> buy, exit below the 10-candle low; mirror.
//  Inside bar          candle inside the previous one -> buy stop above / sell stop below the mother candle (next
//                      candle only), stop at the other end, target 2R.
//  Engulfing           bullish / bearish engulfing candle -> enter next open, stop beyond the 2 candles, target 2R.
//  Pivot bounce        (5m/15m) daily pivots from the previous session: touch S1 and close back above -> buy, stop S2,
//                      target P; mirror at R1. First signal of the day only.
//  ICT Silver Bullet   (5m) first Fair Value Gap formed 10:00-11:00 NY, limit entry at the gap edge until 11:00,
//                      stop beyond candle 1, target 2R, out by 16:00 NY.
//  Asian range fade    (5m, FX + gold) price breaks the 00:00-07:00 London range between 07:00 and 10:00 and a candle
//                      closes back inside -> trade back into the range, stop at the breakout extreme, target the other
//                      side of the range; out by 16:00 London.
// PASS RULE (fixed in advance, strict because ~600 tests are run): 50+ trades, t-stat >= 3, profitable in the first 2
//  years AND the last year, better than the same trades with random direction, still profitable at double costs.
//  Every PASS must then hold up on unseen 2018-2023 data before it means anything.
import fs from 'node:fs';

const NY = 'America/New_York';
const MK = {
  nas100: { file: 'usatechidxusd', tz: NY, wo: 570, wc: 960, cost: 2.0, swap: 0.07 },
  us30: { file: 'usa30idxusd', tz: NY, wo: 570, wc: 960, cost: 3.0, swap: 0.07 },
  us500: { file: 'usa500idxusd', tz: NY, wo: 570, wc: 960, cost: 0.6, swap: 0.07 },
  ger40: { file: 'deuidxeur', tz: 'Europe/Berlin', wo: 540, wc: 1050, cost: 2.0, swap: 0.07 },
  jpn225: { file: 'jpnidxjpy', tz: 'Asia/Tokyo', wo: 540, wc: 900, cost: 12, swap: 0.07 },
  xauusd: { file: 'xauusd', tz: NY, wo: 180, wc: 960, cost: 0.5, swap: 0.07, fade: true },
  xagusd: { file: 'xagusd', tz: NY, wo: 180, wc: 960, cost: 0.035, swap: 0.07 },
  wti: { file: 'lightcmdusd', tz: NY, wo: 180, wc: 960, cost: 0.05, swap: 0.07 },
  btcusd: { file: 'btcusd', tz: NY, wo: 0, wc: 1440, costPct: 0.0006, swap: 0.18 },
  eurusd: { file: 'eurusd', tz: NY, wo: 180, wc: 960, cost: 0.00013, swap: 0.02, fade: true },
  gbpusd: { file: 'gbpusd', tz: NY, wo: 180, wc: 960, cost: 0.00018, swap: 0.02, fade: true },
  usdjpy: { file: 'usdjpy', tz: NY, wo: 180, wc: 960, cost: 0.018, swap: 0.02, fade: true },
};
const CONFIGS = [
  { name: '5m intraday', tf: 5, intra: true }, { name: '15m intraday', tf: 15, intra: true }, { name: '1H intraday', tf: 60, intra: true },
  { name: '1H swing', tf: 60, intra: false }, { name: '4H swing', tf: 240, intra: false }, { name: 'Daily swing', tf: 'D', intra: false },
];
const argMk = process.argv[2] && process.argv[2] !== 'all' ? process.argv[2].split(',') : Object.keys(MK);
const SRC = process.argv[3] ?? 'm1', FROM = process.argv[4] ?? '0000', TO = process.argv[5] ?? '9999';
const VALID = SRC === 'h1';
const SPLIT = '2025-11-01', LAST6 = '2026-05-20';
const out = [], results = [];
const P = (...a) => { const l = a.join(' '); console.log(l); out.push(l); };

// ---------- clock ----------
const fmts = {}, cache = new Map();
function loc(t, tz) {
  const hk = Math.floor(t / 3600000), key = tz + hk; let v = cache.get(key);
  if (!v) { const f = (fmts[tz] ??= new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' })); const p = Object.fromEntries(f.formatToParts(new Date(hk * 3600000)).map((x) => [x.type, x.value])); v = { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 }; cache.set(key, v); }
  return { date: v.date, min: v.hour * 60 + (Math.floor(t / 60000) % 60) };
}
const dayNum = (t) => Date.parse(loc(t + 7 * 3600000, NY).date) / 86400000; // trading day (rolls at 17:00 NY)
const rngOf = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);

// ---------- indicators ----------
const ema = (a, n) => { const o = new Float64Array(a.length), k = 2 / (n + 1); o[0] = a[0]; for (let i = 1; i < a.length; i++) o[i] = a[i] * k + o[i - 1] * (1 - k); return o; };
const smaStd = (a, n) => { const m = new Float64Array(a.length).fill(NaN), s = new Float64Array(a.length).fill(NaN); for (let i = n - 1; i < a.length; i++) { let x = 0, x2 = 0; for (let j = i - n + 1; j <= i; j++) { x += a[j]; x2 += a[j] * a[j]; } m[i] = x / n; s[i] = Math.sqrt(Math.max(0, x2 / n - m[i] * m[i])); } return [m, s]; };
const rsiOf = (a, n = 14) => { const o = new Float64Array(a.length).fill(NaN); let g = 0, l = 0; for (let i = 1; i < a.length; i++) { const ch = a[i] - a[i - 1], up = Math.max(ch, 0), dn = Math.max(-ch, 0); if (i <= n) { g += up / n; l += dn / n; } else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; } if (i >= n) o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } return o; };

// ---------- stats ----------
function stats(tr) {
  const r = tr.map((x) => x.pct), n = r.length; if (!n) return { n: 0 };
  const avg = mean(r), sd = Math.sqrt(r.reduce((s, x) => s + (x - avg) ** 2, 0) / Math.max(1, n - 1));
  const gw = r.filter((x) => x > 0).reduce((s, x) => s + x, 0), gl = -r.filter((x) => x < 0).reduce((s, x) => s + x, 0);
  return { n, win: r.filter((x) => x > 0).length / n, avg, t: sd > 0 ? avg / (sd / Math.sqrt(n)) : 0, pf: gl > 0 ? gw / gl : 99, total: r.reduce((s, x) => s + x, 0), avg2x: avg - mean(tr.map((x) => x.costPct)) };
}
const pc = (v, d = 3) => (Number.isFinite(v) ? (v * 100).toFixed(d) + '%' : '-');

for (const mk of argMk) {
  const M = MK[mk]; if (!M) continue;
  const path = new URL(`./data/${M.file}-${SRC}.json`, import.meta.url);
  if (!fs.existsSync(path)) { P(`${mk}: no ${SRC} data`); continue; }
  let raw = JSON.parse(fs.readFileSync(path, 'utf8'));
  const fromT = Date.parse(FROM) || 0, toT = Date.parse(TO) || Infinity;
  // keep 400 days before FROM so slow indicators (EMA200 on daily) are warmed up
  raw = raw.filter((r) => r[0] >= fromT - 400 * 86400000 && r[0] < toT);
  const cost = (px) => (M.costPct ? px * M.costPct : M.cost);
  P(`\n### ${mk.toUpperCase()} ${raw.length.toLocaleString()} ${SRC} candles ${new Date(raw[0][0]).toISOString().slice(0, 10)} .. ${new Date(raw.at(-1)[0]).toISOString().slice(0, 10)}`);

  function resample(tf) {
    const T = [], O = [], H = [], L = [], C = []; let key = null;
    for (const r of raw) {
      const k = tf === 'D' ? dayNum(r[0]) : Math.floor(r[0] / (tf * 60000));
      if (k !== key) { key = k; T.push(r[0]); O.push(r[1]); H.push(r[2]); L.push(r[3]); C.push(r[4]); }
      else { const j = T.length - 1; if (r[2] > H[j]) H[j] = r[2]; if (r[3] < L[j]) L[j] = r[3]; C[j] = r[4]; }
    }
    return { T, O, H, L, C, n: T.length, tf };
  }

  for (const cfg of CONFIGS) {
    if (VALID && cfg.tf !== 'D' && cfg.tf < 60) continue;
    const B = resample(cfg.tf), { T, O, H, L, C, n } = B, tfMin = cfg.tf === 'D' ? 1440 : cfg.tf;
    // session window per candle
    const day = new Array(n), mins = new Int16Array(n), inWin = new Uint8Array(n), lastWin = new Uint8Array(n);
    for (let i = 0; i < n; i++) { const l = loc(T[i], M.tz); day[i] = l.date; mins[i] = l.min; inWin[i] = cfg.intra && l.min >= M.wo && l.min + tfMin <= M.wc ? 1 : 0; }
    for (let i = 0; i < n; i++) lastWin[i] = inWin[i] && (i === n - 1 || !inWin[i + 1] || day[i + 1] !== day[i]) ? 1 : 0;
    const inRange = (t) => t >= fromT && t < toT;
    const mkTrade = (i0, dir, entry, exit, tExit) => {
      const nights = cfg.intra ? 0 : Math.max(0, dayNum(tExit) - dayNum(T[i0]));
      const c = cost(entry) / entry, sw = (M.swap / 365) * nights;
      return { date: new Date(T[i0]).toISOString().slice(0, 10), gross: ((exit - entry) * dir) / entry, pct: ((exit - entry) * dir) / entry - c - sw, costPct: c + sw };
    };

    // --- type A: signal machines (stop and reverse / exit rules) ---
    function runA(sig) {
      const tr = []; let pos = 0, ent = 0, ei = 0;
      for (let i = 1; i < n - 1; i++) {
        if (cfg.intra && pos && lastWin[i]) { if (inRange(T[ei])) tr.push(mkTrade(ei, pos, ent, C[i], T[i])); pos = 0; continue; }
        const s = sig(i); if (!s) continue; const j = i + 1;
        if ((pos > 0 && (s.xl || s.e < 0)) || (pos < 0 && (s.xs || s.e > 0))) { if (inRange(T[ei])) tr.push(mkTrade(ei, pos, ent, O[j], T[j])); pos = 0; }
        if (!pos && s.e && (!cfg.intra || (inWin[j] && !lastWin[j]))) { pos = s.e; ent = O[j]; ei = j; }
      }
      return tr;
    }
    // --- type B: bracket trades (entry, stop, target) ---
    function walk(j0, dir, stop, tgt) {
      for (let j = j0; j < n; j++) {
        if (dir > 0) { if (L[j] <= stop) return [Math.min(O[j], stop), j]; if (H[j] >= tgt) return [Math.max(O[j], tgt), j]; }
        else { if (H[j] >= stop) return [Math.max(O[j], stop), j]; if (L[j] <= tgt) return [Math.min(O[j], tgt), j]; }
        if (cfg.intra && lastWin[j]) return [C[j], j];
      }
      return [C[n - 1], n - 1];
    }
    const ok = (j) => j < n && (!cfg.intra || (inWin[j] && !lastWin[j]));
    const cl = C;
    const e9 = ema(cl, 9), e21 = ema(cl, 21), e50 = ema(cl, 50), e200 = ema(cl, 200);
    const e12 = ema(cl, 12), e26 = ema(cl, 26), macd = e12.map((v, i) => v - e26[i]), msig = ema(macd, 9);
    const rsi = rsiOf(cl, 14), [mid, sd] = smaStd(cl, 20);
    const cross = (a, b, i) => (a[i - 1] <= b[i - 1] && a[i] > b[i] ? 1 : a[i - 1] >= b[i - 1] && a[i] < b[i] ? -1 : 0);
    const hh = (i, k) => { let m = -Infinity; for (let j = i - k; j < i; j++) m = Math.max(m, H[j]); return m; };
    const ll = (i, k) => { let m = Infinity; for (let j = i - k; j < i; j++) m = Math.min(m, L[j]); return m; };

    const S = {};
    S['EMA 9/21 cross'] = () => runA((i) => (i < 21 ? null : { e: cross(e9, e21, i) }));
    S['EMA 50/200 cross'] = () => runA((i) => (i < 200 ? null : { e: cross(e50, e200, i) }));
    S['MACD 12/26/9'] = () => runA((i) => (i < 35 ? null : { e: cross(macd, msig, i) }));
    S['RSI 30/70'] = () => runA((i) => (i < 15 ? null : { e: rsi[i - 1] < 30 && rsi[i] >= 30 ? 1 : rsi[i - 1] > 70 && rsi[i] <= 70 ? -1 : 0 }));
    S['Bollinger bounce'] = () => runA((i) => (i < 20 ? null : { e: C[i] < mid[i] - 2 * sd[i] ? 1 : C[i] > mid[i] + 2 * sd[i] ? -1 : 0, xl: C[i] >= mid[i], xs: C[i] <= mid[i] }));
    S['Donchian 20/10'] = () => runA((i) => (i < 21 ? null : { e: C[i] > hh(i, 20) ? 1 : C[i] < ll(i, 20) ? -1 : 0, xl: C[i] < ll(i, 10), xs: C[i] > hh(i, 10) }));
    S['Inside bar'] = () => {
      const tr = [];
      for (let i = 2; i < n - 2; i++) {
        if (!(H[i] < H[i - 1] && L[i] > L[i - 1])) continue; const j = i + 1; if (!ok(j)) continue;
        const up = H[j] >= H[i - 1], dn = L[j] <= L[i - 1]; if (up === dn) continue;
        const dir = up ? 1 : -1, entry = up ? Math.max(O[j], H[i - 1]) : Math.min(O[j], L[i - 1]), stop = up ? L[i - 1] : H[i - 1], R = (entry - stop) * dir; if (!(R > 0)) continue;
        const [x, k] = cfg.intra && lastWin[j] ? [C[j], j] : walk(j + 1, dir, stop, entry + dir * 2 * R);
        if (inRange(T[j])) tr.push(mkTrade(j, dir, entry, x, T[k])); i = k;
      }
      return tr;
    };
    S['Engulfing'] = () => {
      const tr = [];
      for (let i = 2; i < n - 2; i++) {
        const bu = C[i - 1] < O[i - 1] && C[i] > O[i] && O[i] <= C[i - 1] && C[i] >= O[i - 1];
        const be = C[i - 1] > O[i - 1] && C[i] < O[i] && O[i] >= C[i - 1] && C[i] <= O[i - 1];
        if (!bu && !be) continue; const j = i + 1; if (!ok(j)) continue;
        const dir = bu ? 1 : -1, entry = O[j], stop = bu ? Math.min(L[i], L[i - 1]) : Math.max(H[i], H[i - 1]), R = (entry - stop) * dir; if (!(R > 0)) continue;
        const [x, k] = walk(j, dir, stop, entry + dir * 2 * R);
        if (inRange(T[j])) tr.push(mkTrade(j, dir, entry, x, T[k])); i = k;
      }
      return tr;
    };
    if (cfg.intra && (cfg.tf === 5 || cfg.tf === 15)) S['Pivot bounce'] = () => {
      // previous session high / low / close from the in-window candles
      const sess = new Map(); for (let i = 0; i < n; i++) if (inWin[i]) { const s = sess.get(day[i]); if (!s) sess.set(day[i], { h: H[i], l: L[i], c: C[i] }); else { s.h = Math.max(s.h, H[i]); s.l = Math.min(s.l, L[i]); s.c = C[i]; } }
      const days = [...sess.keys()], prev = new Map(days.map((d, k) => [d, sess.get(days[k - 1])]));
      const tr = []; let done = '';
      for (let i = 1; i < n - 1; i++) {
        if (!inWin[i] || done === day[i]) continue; const p = prev.get(day[i]); if (!p) continue; const j = i + 1; if (!ok(j) || day[j] !== day[i]) continue;
        const Pv = (p.h + p.l + p.c) / 3, S1 = 2 * Pv - p.h, R1 = 2 * Pv - p.l, S2 = Pv - (p.h - p.l), R2 = Pv + (p.h - p.l);
        let dir = 0; if (L[i] <= S1 && C[i] > S1) dir = 1; else if (H[i] >= R1 && C[i] < R1) dir = -1; if (!dir) continue;
        const entry = O[j], stop = dir > 0 ? S2 : R2, tgt = Pv; if ((entry - stop) * dir <= 0 || (tgt - entry) * dir <= 0) continue;
        const [x, k] = walk(j, dir, stop, tgt); done = day[i];
        if (inRange(T[j])) tr.push(mkTrade(j, dir, entry, x, T[k])); i = k;
      }
      return tr;
    };
    if (cfg.intra && cfg.tf === 5) S['ICT Silver Bullet (FVG)'] = () => {
      const nyM = new Int16Array(n), nyD = new Array(n); for (let i = 0; i < n; i++) { const l = loc(T[i], NY); nyM[i] = l.min; nyD[i] = l.date; }
      const tr = []; let done = '';
      for (let i = 2; i < n - 1; i++) {
        if (nyM[i - 2] < 600 || nyM[i] >= 660 || nyD[i] !== nyD[i - 2] || done === nyD[i]) continue;
        const bu = L[i] > H[i - 2], be = H[i] < L[i - 2]; if (!bu && !be) continue; done = nyD[i];
        const dir = bu ? 1 : -1, lim = bu ? L[i] : H[i], stop = bu ? L[i - 2] : H[i - 2];
        for (let j = i + 1; j < n && nyD[j] === nyD[i] && nyM[j] < 660; j++) {
          if (dir > 0 ? L[j] <= lim : H[j] >= lim) {
            const entry = dir > 0 ? Math.min(O[j], lim) : Math.max(O[j], lim), R = (entry - stop) * dir; if (!(R > 0)) break;
            // walk to target / stop, out by 16:00 NY
            let x = C[n - 1], k = n - 1;
            for (let q = j + 1; q < n; q++) {
              if (dir > 0) { if (L[q] <= stop) { x = Math.min(O[q], stop); k = q; break; } if (H[q] >= entry + 2 * R) { x = Math.max(O[q], entry + 2 * R); k = q; break; } }
              else { if (H[q] >= stop) { x = Math.max(O[q], stop); k = q; break; } if (L[q] <= entry - 2 * R) { x = Math.min(O[q], entry - 2 * R); k = q; break; } }
              if (nyD[q] !== nyD[j] || nyM[q] + 5 >= 960) { x = nyD[q] !== nyD[j] ? C[q - 1] : C[q]; k = q; break; }
            }
            if (inRange(T[j])) tr.push(mkTrade(j, dir, entry, x, T[k])); i = k; break;
          }
        }
      }
      return tr;
    };
    if (cfg.intra && cfg.tf === 5 && M.fade) S['Asian range fade'] = () => {
      const lM = new Int16Array(n), lD = new Array(n); for (let i = 0; i < n; i++) { const l = loc(T[i], 'Europe/London'); lM[i] = l.min; lD[i] = l.date; }
      const tr = [];
      for (let i = 0; i < n; i++) {
        if (lM[i] !== 0) continue; const d = lD[i]; let rh = -Infinity, rl = Infinity, k = i;
        for (; k < n && lD[k] === d && lM[k] < 420; k++) { rh = Math.max(rh, H[k]); rl = Math.min(rl, L[k]); }
        let up = false, dn = false, ext = 0;
        for (; k < n - 1 && lD[k] === d && lM[k] < 600; k++) {
          if (!up && !dn) { if (H[k] > rh) { up = true; ext = H[k]; } else if (L[k] < rl) { dn = true; ext = L[k]; } }
          else if (up) ext = Math.max(ext, H[k]); else ext = Math.min(ext, L[k]);
          if ((up && C[k] < rh) || (dn && C[k] > rl)) {
            const dir = up ? -1 : 1, j = k + 1, entry = O[j], stop = ext, tgt = up ? rl : rh;
            if ((entry - stop) * dir <= 0 || (tgt - entry) * dir <= 0) break;
            let x = C[n - 1], q = j;
            for (; q < n; q++) {
              if (dir > 0) { if (L[q] <= stop) { x = Math.min(O[q], stop); break; } if (H[q] >= tgt) { x = Math.max(O[q], tgt); break; } }
              else { if (H[q] >= stop) { x = Math.max(O[q], stop); break; } if (L[q] <= tgt) { x = Math.min(O[q], tgt); break; } }
              if (lD[q] !== d || lM[q] + 5 >= 960) { x = lD[q] !== d ? C[q - 1] : C[q]; break; }
            }
            if (inRange(T[j])) tr.push(mkTrade(j, dir, entry, x, T[Math.min(q, n - 1)])); i = q; break;
          }
        }
      }
      return tr;
    };

    for (const [name, fn] of Object.entries(S)) {
      const tr = fn(), a = stats(tr);
      if (!a.n) { results.push({ market: mk, config: cfg.name, strategy: name, n: 0 }); continue; }
      const rng = rngOf(17), pl = []; for (let r = 0; r < 20; r++) for (const x of tr) { const s = rng() < 0.5 ? 1 : -1; pl.push(s * x.gross - x.costPct); }
      const is = stats(tr.filter((x) => x.date < SPLIT)), oos = stats(tr.filter((x) => x.date >= SPLIT)), l6 = stats(tr.filter((x) => x.date >= LAST6));
      const plAvg = mean(pl);
      const pass = VALID ? a.n >= 30 && a.t >= 2 && a.avg > plAvg && a.avg2x > 0
        : a.n >= 50 && a.t >= 3 && is.avg > 0 && oos.avg > 0 && a.avg > plAvg && a.avg2x > 0;
      const years = {}; for (const x of tr) (years[x.date.slice(0, 4)] ??= []).push(x);
      results.push({ market: mk, config: cfg.name, strategy: name, ...a, isAvg: is.avg, oosAvg: oos.avg, l6Avg: l6.avg, placebo: plAvg, pass, years: Object.fromEntries(Object.entries(years).map(([y, v]) => [y, +(stats(v).avg * 100).toFixed(3)])) });
    }
    const mine = results.filter((r) => r.market === mk && r.config === cfg.name && r.n);
    P(`  ${cfg.name.padEnd(13)} ${mine.map((r) => `${r.strategy.split(' ')[0]} ${pc(r.avg)}${r.pass ? '*' : ''}`).join(' | ')}`);
  }
}

// ---------- summary ----------
const R = results.filter((r) => r.n);
P(`\n=== ${VALID ? `VALIDATION ${FROM}..${TO}` : 'DISCOVERY Nov 2023 - Nov 2026'}: ${R.length} tests ===`);
const strategies = [...new Set(R.map((r) => r.strategy))], configs = CONFIGS.map((c) => c.name).filter((c) => R.some((r) => r.config === c));
P('\nMarkets in profit after costs / markets tested (passes in brackets):');
P('  ' + 'strategy'.padEnd(26) + configs.map((c) => c.padStart(14)).join(''));
for (const s of strategies) P('  ' + s.padEnd(26) + configs.map((c) => { const v = R.filter((r) => r.strategy === s && r.config === c); if (!v.length) return '-'.padStart(14); const p = v.filter((r) => r.pass).length; return `${v.filter((r) => r.avg > 0).length}/${v.length}${p ? ` (${p})` : ''}`.padStart(14); }).join(''));
P('\nAverage win rate / average result per trade, all markets:');
for (const s of strategies) P('  ' + s.padEnd(26) + configs.map((c) => { const v = R.filter((r) => r.strategy === s && r.config === c); if (!v.length) return '-'.padStart(18); const n = v.reduce((a, r) => a + r.n, 0); return `${(v.reduce((a, r) => a + r.win * r.n, 0) / n * 100).toFixed(0)}% ${pc(v.reduce((a, r) => a + r.avg * r.n, 0) / n, 3)}`.padStart(18); }).join(''));
P('\nTop 25 by t-stat:');
for (const r of [...R].sort((a, b) => b.t - a.t).slice(0, 25)) P(`  ${r.pass ? 'PASS' : '    '} ${r.strategy.padEnd(24)} ${r.config.padEnd(13)} ${r.market.padEnd(7)} ${String(r.n).padStart(5)} tr won ${pc(r.win, 0).padStart(4)} avg ${pc(r.avg).padStart(8)} t ${r.t.toFixed(2).padStart(5)} PF ${r.pf.toFixed(2)} | first 2y ${pc(r.isAvg)} last 1y ${pc(r.oosAvg)} last 6m ${pc(r.l6Avg)} | random ${pc(r.placebo)} | 2x cost ${pc(r.avg2x)}`);
P('\nPASSED:'); const ps = R.filter((r) => r.pass); if (!ps.length) P('  none');
for (const r of ps) P(`  ${r.strategy} | ${r.config} | ${r.market}: ${r.n} trades, won ${pc(r.win, 0)}, avg ${pc(r.avg)}, t ${r.t.toFixed(2)}, years ${JSON.stringify(r.years)}`);
const tag = VALID ? `-valid` : '';
fs.writeFileSync(new URL(`./results/grid-lab${tag}-report.txt`, import.meta.url), out.join('\n'));
fs.writeFileSync(new URL(`./results/grid-lab${tag}-results.json`, import.meta.url), JSON.stringify(results, null, 1));
