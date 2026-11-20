// Supply & Demand (1H zones, 5M entry) backtest - Mahin's strategy, written as exact rules.
// Data: Dukascopy 1-minute BID candles (fx-download.mjs). 5M and 1H candles are built from them; fills, stops and
// targets are walked on the 1-minute candles (if stop and target fall in the same minute, the STOP counts).
//   node --max-old-space-size=8000 fx-sd-backtest.mjs eurusd      (or xauusd)
//
// OBJECTIVE RULES (base settings fixed BEFORE looking at any result; alternatives are tested separately):
//  1H strong candle   body >= 60% of its high-low range.
//  1H swing high/low  a high above the 2 candles on each side (known only 2 candles later - no look-ahead).
//  1H strong move     2 or 3 candles in a row in one direction, at least 2 of them strong, and the move CLOSES beyond
//                     the last swing high (bullish) / swing low (bearish) known before the move started.
//  Zone               body (open-close) of the last opposite candle before the move (searched up to 3 candles back).
//                     Demand = below price (buy), supply = above (sell). Usable from the close of the move.
//  Zone life          first touch only (any later touch is ignored), and at most ZONE_DAYS old (base 5 trading days).
//  Session            entries only 8:00-11:00 New York time (first 3 hours of the NY forex session), and the zone
//                     touch must also happen inside that window. Every trade is closed by 16:00 New York.
//  5M reaction        within 6 candles (30 min) of the touch: 3 candles in a row in the trade direction, at least 2
//                     strong (body >= 60%). A 5M close beyond the far side of the zone cancels the setup.
//  Pullback           the first opposite 5M candle after the reaction (within 6 candles). If more opposite candles
//                     follow, the latest one becomes the pullback candle.
//  Entry              BUY when price breaks above the pullback candle's high (SELL: below its low), within 12 candles.
//  Stop               beyond the pullback's lowest low / highest high, plus a small buffer (10% of the 5M ATR).
//  Target             the NEXT opposing 1H zone (nearest unused supply above a buy / demand below a sell). Trade only
//                     if that gives at least 1:2. (Alternatives tested: fixed 2R / 3R, zone-or-2R.)
//  Day rules          max 2 trades a day, one at a time; stop after 2 losses in a row, at -2R ($50 at $25 a trade)
//                     or at +4R ($100). Risk per trade = 1R = $25.
//  Costs              EURUSD 1.3 pips a trade (spread ~0.5 + commission ~0.6 + slippage ~0.2);
//                     XAUUSD $0.50 an ounce a trade. Also run at half and double.
import fs from 'node:fs';

const PAIR = (process.argv[2] ?? 'eurusd').toLowerCase();
const COST = { eurusd: 0.00013, xauusd: 0.5 }[PAIR];
const PIP = { eurusd: 0.0001, xauusd: 0.1 }[PAIR];
const m1 = JSON.parse(fs.readFileSync(new URL(`./data/${PAIR}-m1.json`, import.meta.url), 'utf8'));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const r2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '-');
const out = [];
const P = (...a) => { const l = a.join(' '); console.log(l); out.push(l); };

// ---------- New York clock (handles summer/winter time) ----------
const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' });
const hourCache = new Map();
const ny = (t) => { const hk = Math.floor(t / 3600000); let v = hourCache.get(hk); if (!v) { const p = Object.fromEntries(fmt.formatToParts(new Date(hk * 3600000)).map((x) => [x.type, x.value])); v = { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 }; hourCache.set(hk, v); } return { date: v.date, min: v.hour * 60 + new Date(t).getUTCMinutes() }; };

// ---------- candles ----------
function build(ms) {
  const T = [], O = [], H = [], L = [], C = [], F = [], E = []; // F/E = first / end(excl) 1-minute index
  for (let i = 0; i < m1.length; i++) {
    const b = Math.floor(m1[i][0] / ms) * ms;
    if (!T.length || T.at(-1) !== b) { T.push(b); O.push(m1[i][1]); H.push(m1[i][2]); L.push(m1[i][3]); C.push(m1[i][4]); F.push(i); E.push(i + 1); }
    else { const j = T.length - 1; if (m1[i][2] > H[j]) H[j] = m1[i][2]; if (m1[i][3] < L[j]) L[j] = m1[i][3]; C[j] = m1[i][4]; E[j] = i + 1; }
  }
  return { T, O, H, L, C, F, E, n: T.length, ms };
}
const h1 = build(3600000), m5 = build(300000);
const strong = (k, j, minBody) => { const rg = k.H[j] - k.L[j]; return rg > 0 && Math.abs(k.C[j] - k.O[j]) / rg >= minBody; };
const bull = (k, j) => k.C[j] > k.O[j], bear = (k, j) => k.C[j] < k.O[j];
// 5M ATR(14) for the stop buffer
const atr5 = new Float64Array(m5.n); { let s = 0; for (let j = 1; j < m5.n; j++) { const tr = Math.max(m5.H[j], m5.C[j - 1]) - Math.min(m5.L[j], m5.C[j - 1]); s = j < 15 ? s + tr : s + tr - (Math.max(m5.H[j - 14], m5.C[j - 15]) - Math.min(m5.L[j - 14], m5.C[j - 15])); atr5[j] = s / Math.min(j, 14); } }
// 1H EMA(50) for the optional trend filter
const ema50 = new Float64Array(h1.n); { const a = 2 / 51; ema50[0] = h1.C[0]; for (let j = 1; j < h1.n; j++) ema50[j] = a * h1.C[j] + (1 - a) * ema50[j - 1]; }
const h1IndexAt = (t) => { let lo = 0, hi = h1.n - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (h1.T[mid] + 3600000 <= t) lo = mid; else hi = mid - 1; } return lo; }; // last CLOSED 1H candle at time t

// ---------- 1H zones ----------
function zones(minBody, needBreak = true) {
  const L = 2, sh = [], sl = []; // confirmed swings: [confirmTime, price]
  for (let j = L; j < h1.n - L; j++) {
    let isH = true, isL = true;
    for (let d = 1; d <= L; d++) { if (!(h1.H[j] > h1.H[j - d] && h1.H[j] >= h1.H[j + d])) isH = false; if (!(h1.L[j] < h1.L[j - d] && h1.L[j] <= h1.L[j + d])) isL = false; }
    if (isH) sh.push([h1.T[j + L] + 3600000, h1.H[j]]);
    if (isL) sl.push([h1.T[j + L] + 3600000, h1.L[j]]);
  }
  const lastBefore = (arr, t) => { let v = null; for (let lo = 0, hi = arr.length - 1; lo <= hi;) { const mid = (lo + hi) >> 1; if (arr[mid][0] <= t) { v = arr[mid][1]; lo = mid + 1; } else hi = mid - 1; } return v; };
  const Z = [], seen = new Set();
  for (let e = 3; e < h1.n; e++) {
    for (const n of [2, 3]) {
      const s = e - n + 1; if (s < 4) continue;
      for (const dir of [1, -1]) {
        let ok = true, st = 0;
        for (let j = s; j <= e; j++) { if (dir > 0 ? !bull(h1, j) : !bear(h1, j)) ok = false; if (strong(h1, j, minBody)) st++; }
        if (!ok || st < 2) continue;
        const sw = lastBefore(dir > 0 ? sh : sl, h1.T[s]); // known before the move started
        if (needBreak && (sw == null || (dir > 0 ? h1.C[e] <= sw : h1.C[e] >= sw))) continue;
        let base = -1; for (let j = s - 1; j >= s - 3; j--) if (dir > 0 ? bear(h1, j) : bull(h1, j)) { base = j; break; }
        if (base < 0 || seen.has(`${dir}|${base}`)) continue;
        seen.add(`${dir}|${base}`);
        Z.push({ dir, top: Math.max(h1.O[base], h1.C[base]), bot: Math.min(h1.O[base], h1.C[base]), created: h1.T[e] + 3600000, base });
      }
    }
  }
  return Z.sort((a, b) => a.created - b.created);
}
const ZCACHE = new Map();

// ---------- the strategy ----------
const FN = {}; const fn = (k) => { FN[k] = (FN[k] ?? 0) + 1; };
const BASE = { minBody: 0.6, zoneDays: 5, react: 6, pull: 6, entryWin: 12, target: 'zone', minRR: 2, fvg: false, win: [480, 660], trend: false, cost: COST, minStop: 0, placebo: null, noBreak: true, needBreak: true, reactMode: 'two' };
// concept test: same idea, looser settings -> enough trades to judge whether the zones beat random
const LOOSE = { minBody: 0.5, zoneDays: 10, react: 12, win: [180, 660], needBreak: false, target: 'fixed2R' };
function run(cfg) {
  const c = { ...BASE, ...cfg };
  const zk = `${c.minBody}|${c.needBreak}`; if (!ZCACHE.has(zk)) ZCACHE.set(zk, zones(c.minBody, c.needBreak));
  const allZ = ZCACHE.get(zk).map((z) => ({ ...z, used: false }));
  const life = c.zoneDays * 24 * 3600000 * 7 / 5; // trading days -> calendar time
  const trades = [];
  let zi = 0, active = [], setups = [], day = null, ds = null, busyUntil = 0;
  let seed = c.placebo?.seed ?? 1; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let j = 20; j < m5.n; j++) {
    const t = m5.T[j], clk = ny(t);
    if (clk.date !== day) { day = clk.date; ds = { n: 0, R: 0, lossRun: 0, stop: false }; setups = []; }
    while (zi < allZ.length && allZ[zi].created <= t) active.push(allZ[zi++]);
    // every untouched zone up to 60 days old stays on the chart (as a TARGET); only zones within `life` can be TRADED
    active = active.filter((z) => !z.used && t - z.created <= 60 * 24 * 3600000);
    const inWin = clk.min >= c.win[0] && clk.min < c.win[1];
    const canTrade = inWin && !ds.stop && t >= busyUntil;
    // zone touches: first touch only
    for (const z of active) {
      const touched = z.dir > 0 ? m5.L[j] <= z.top : m5.H[j] >= z.bot;
      if (!touched) continue;
      z.used = true;
      if (t - z.created > life) continue; fn('1 first touch (any hour)');
      if (!inWin) continue; fn('2 first touch inside the window');
      if (!canTrade) continue; fn('3 day rules allow');
      if (c.trend) { const k = h1IndexAt(t); if (z.dir > 0 ? h1.C[k] < ema50[k] : h1.C[k] > ema50[k]) continue; }
      setups.push({ z, dir: c.placebo?.flip ? -z.dir : z.dir, touch: j, stage: 'react', run: 0, st: 0, fvg: false });
    }
    if (!canTrade) { if (!inWin) setups = []; continue; }
    // advance setups on this closed 5M candle
    let entered = null;
    for (const s of setups) {
      if (s.dead) continue;
      const d = s.dir, up = d > 0;
      const beyond = c.noBreak ? false : up ? m5.C[j] < s.z.bot : m5.C[j] > s.z.top; // closed through the zone (my addition, not his rule)
      if (s.stage === 'react') {
        if (beyond || j - s.touch >= c.react + 3) { s.dead = true; continue; }
        const dirC = up ? bull(m5, j) : bear(m5, j), strC = dirC && strong(m5, j, c.minBody);
        if (dirC) { s.run++; if (strC) s.st++; if (j >= 2 && (up ? m5.H[j - 2] < m5.L[j] : m5.L[j - 2] > m5.H[j])) s.fvg = true; }
        else { s.run = 0; s.st = 0; s.fvg = false; }
        s.srun = strC ? (s.srun ?? 0) + 1 : 0; // strong candles in a row
        // required: 2 strong candles in a row in the trade direction. 'three' = his ideal (3 in a row, 2+ strong)
        const reacted = c.reactMode === 'three' ? s.run >= 3 && s.st >= 2 : s.srun >= 2;
        if (reacted && (!c.fvg || s.fvg)) { s.stage = 'pull'; s.reactEnd = j; fn('4 strong 5M reaction'); }
        continue;
      }
      if (s.stage === 'pull') {
        if (j - s.reactEnd > c.pull) { s.dead = true; continue; }
        if (up ? bear(m5, j) : bull(m5, j)) { s.stage = 'armed'; s.pbHi = m5.H[j]; s.pbLo = m5.L[j]; s.trig = up ? m5.H[j] : m5.L[j]; s.armedAt = j; fn('5 pullback candle'); }
        continue;
      }
      if (s.stage === 'armed') {
        if (j - s.armedAt > c.entryWin || beyond) { s.dead = true; continue; }
        const stopPx = up ? s.pbLo - 0.1 * atr5[j] : s.pbHi + 0.1 * atr5[j];
        // walk the minutes of this candle: trigger first, or the pullback extends / stop level is hit first
        let fill = null;
        for (let i = m5.F[j]; i < m5.E[j]; i++) {
          const [, o, h, l] = m1[i];
          if (up ? l <= stopPx : h >= stopPx) break;
          if (up ? h > s.trig : l < s.trig) { fill = { i, px: up ? Math.max(s.trig, o) : Math.min(s.trig, o) }; break; }
        }
        if (fill) { entered = { s, fill, stopPx }; break; }
        if (up ? bear(m5, j) : bull(m5, j)) { s.trig = up ? m5.H[j] : m5.L[j]; s.pbLo = Math.min(s.pbLo, m5.L[j]); s.pbHi = Math.max(s.pbHi, m5.H[j]); }
        else { s.pbLo = Math.min(s.pbLo, m5.L[j]); s.pbHi = Math.max(s.pbHi, m5.H[j]); }
      }
    }
    setups = setups.filter((s) => !s.dead);
    if (!entered) continue; fn('6 entry triggered');
    // ---- a trade ----
    const { s, fill, stopPx } = entered, d = s.dir, px = fill.px, risk = Math.abs(px - stopPx);
    setups = [];
    if (!(risk > 0) || risk < c.minStop) continue;
    let tgt = null;
    const opp = active.filter((z) => z.dir === -d && !z.used && z.created <= t && (d > 0 ? z.bot > px : z.top < px)).sort((a, b) => (d > 0 ? a.bot - b.bot : b.top - a.top))[0];
    const zoneT = opp ? (d > 0 ? opp.bot : opp.top) : null, zoneRR = zoneT != null ? Math.abs(zoneT - px) / risk : 0;
    if (c.target === 'zone') { if (!opp) { fn('7a skipped: no opposing zone'); continue; } if (zoneRR < c.minRR) { fn('7b skipped: zone under 2R'); continue; } tgt = zoneT; fn('8 TRADE'); }
    else if (c.target === 'zoneOr2R') tgt = zoneRR >= 2 ? zoneT : px + d * 2 * risk;
    else tgt = px + d * Number(c.target.replace(/\D/g, '')) * risk; // 'fixed2R' / 'fixed3R'
    // walk the minutes until stop / target / 16:00 New York
    let exitPx = null, how = 'time', exitT = null;
    for (let i = fill.i; i < m1.length; i++) {
      const [tm, o, h, l, cl] = m1[i], k2 = ny(tm);
      if (k2.date !== day || k2.min >= 960) { exitPx = m1[i - 1][4]; exitT = m1[i - 1][0]; break; }
      const sameAsEntry = i === fill.i;
      if (d > 0 ? l <= stopPx : h >= stopPx) { exitPx = sameAsEntry ? stopPx : d > 0 ? Math.min(stopPx, o) : Math.max(stopPx, o); how = 'stop'; exitT = tm; break; }
      if (!sameAsEntry && (d > 0 ? h >= tgt : l <= tgt)) { exitPx = tgt; how = 'target'; exitT = tm; break; }
    }
    if (exitPx == null) continue;
    const R = (d * (exitPx - px) - c.cost) / risk;
    trades.push({ date: day, t: m1[fill.i][0], dir: d, px, stop: stopPx, tgt, risk, R, how, rr: Math.abs(tgt - px) / risk });
    busyUntil = exitT + 1;
    ds.n++; ds.R += R; ds.lossRun = R <= 0 ? ds.lossRun + 1 : 0;
    if (ds.n >= 2 || ds.lossRun >= 2 || ds.R <= -2 || ds.R >= 4) ds.stop = true;
  }
  return trades;
}

// ---------- placebo: same session, same trade shape, but random time and random direction ----------
function placebo(cfg, ref, seeds = 20) {
  const res = [];
  const stopDist = ref.map((t) => t.risk), rrs = ref.map((t) => t.rr);
  const days = [...new Set(ref.map((t) => t.date))];
  const perDay = ref.length / Math.max(1, days.length);
  const byDay = new Map(); for (let j = 0; j < m5.n; j++) { const k = ny(m5.T[j]); if (k.min >= cfg.win[0] && k.min < cfg.win[1]) (byDay.get(k.date) ?? byDay.set(k.date, []).get(k.date)).push(j); }
  const allDays = [...byDay.keys()];
  for (let sd = 1; sd <= seeds; sd++) {
    let seed = sd * 7919; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (const dd of allDays) {
      if (rnd() > ref.length / allDays.length / Math.max(1, Math.ceil(perDay))) continue;
      const bars = byDay.get(dd), j = bars[Math.floor(rnd() * bars.length)], d = rnd() < 0.5 ? 1 : -1;
      const risk = stopDist[Math.floor(rnd() * stopDist.length)], rr = rrs[Math.floor(rnd() * rrs.length)];
      const i0 = m5.E[j], px = m1[i0]?.[1]; if (px == null) continue;
      const stopPx = px - d * risk, tgt = px + d * rr * risk;
      let exitPx = null;
      for (let i = i0; i < m1.length; i++) { const [tm, o, h, l] = m1[i], k2 = ny(tm); if (k2.date !== dd || k2.min >= 960) { exitPx = m1[i - 1][4]; break; } if (d > 0 ? l <= stopPx : h >= stopPx) { exitPx = i === i0 ? stopPx : d > 0 ? Math.min(stopPx, o) : Math.max(stopPx, o); break; } if (i > i0 && (d > 0 ? h >= tgt : l <= tgt)) { exitPx = tgt; break; } }
      if (exitPx != null) res.push({ date: dd, R: (d * (exitPx - px) - cfg.cost) / risk });
    }
  }
  return res;
}

// ---------- reporting ----------
function stats(T) {
  if (!T.length) return null;
  const w = T.filter((t) => t.R > 0), l = T.filter((t) => t.R <= 0);
  const gw = w.reduce((s, t) => s + t.R, 0), gl = -l.reduce((s, t) => s + t.R, 0);
  let eq = 0, pk = 0, dd = 0, run = 0, maxRun = 0;
  for (const t of T) { eq += t.R; pk = Math.max(pk, eq); dd = Math.min(dd, eq - pk); run = t.R <= 0 ? run + 1 : 0; maxRun = Math.max(maxRun, run); }
  const mon = new Map(); for (const t of T) mon.set(t.date.slice(0, 7), (mon.get(t.date.slice(0, 7)) ?? 0) + t.R);
  const mv = [...mon.values()];
  return { n: T.length, won: w.length / T.length, pf: gl > 0 ? gw / gl : Infinity, exp: mean(T.map((t) => t.R)), avgW: mean(w.map((t) => t.R)), avgL: mean(l.map((t) => t.R)), totR: eq, dd, maxRun, months: mv.length, green: mv.filter((v) => v > 0).length, perMonth: T.length / Math.max(1, mv.length) };
}
const line = (lab, T) => { const s = stats(T); if (!s) return P(`  ${lab.padEnd(34)} no trades`); P(`  ${lab.padEnd(34)} ${String(s.n).padStart(4)} tr (${s.perMonth.toFixed(1)}/mo) | won ${(s.won * 100).toFixed(0).padStart(3)}% | PF ${r2(s.pf).padStart(5)} | expectancy ${r2(s.exp).padStart(5)}R | avg win ${r2(s.avgW)}R loss ${r2(s.avgL)}R | total ${r2(s.totR).padStart(6)}R ($${Math.round(s.totR * 25)}) | max DD ${r2(s.dd)}R | lose streak ${s.maxRun} | green months ${s.green}/${s.months}`); };

const IS_END = '2025-11-01';
P(`===== ${PAIR.toUpperCase()} - Supply & Demand 1H zones / 5M entry =====`);
P(`Data: ${new Date(m1[0][0]).toISOString().slice(0, 10)} .. ${new Date(m1.at(-1)[0]).toISOString().slice(0, 10)} | ${m1.length.toLocaleString()} 1-min candles -> ${m5.n.toLocaleString()} 5M, ${h1.n.toLocaleString()} 1H | cost ${PAIR === 'eurusd' ? (COST / PIP).toFixed(1) + ' pips' : '$' + COST} a trade | 1R = $25`);
const zb = zones(0.6); P(`1H zones found (base): ${zb.length} (${zb.filter((z) => z.dir > 0).length} demand, ${zb.filter((z) => z.dir < 0).length} supply)`);

const funnel = (lab, cfg) => { for (const k in FN) delete FN[k]; run(cfg); P(`FUNNEL ${lab}: ` + Object.entries(FN).sort().map(([k, v]) => `${k}: ${v}`).join(' | ')); };
funnel('base rules, 3 years', {});
funnel('if the window were 3:00-15:00 NY', { win: [180, 900] });
funnel('if strong body were 50%', { minBody: 0.5 });
funnel('WITHOUT my zone-break cancel', { noBreak: true });
funnel('WITHOUT zone-break cancel, reaction within 12', { noBreak: true, react: 12 });
if (process.env.FUNNEL) process.exit(0);
P('\n--- 1. BASE RULES (as written, settings fixed before testing) ---');
const base = run({});
line('all 3 years', base);
line('in-sample  Nov 2023 - Oct 2025', base.filter((t) => t.date < IS_END));
line('out-of-sample Nov 2025 - Nov 2026', base.filter((t) => t.date >= IS_END));
for (const y of ['2023', '2024', '2025', '2026']) { const T = base.filter((t) => t.date.startsWith(y)); if (T.length) line(`  ${y}`, T); }
const bs = stats(base);
if (bs) {
  P(`  exits: ${Object.entries(base.reduce((a, t) => ((a[t.how] = (a[t.how] ?? 0) + 1), a), {})).map(([k, v]) => `${k} ${v}`).join(', ')} | buys ${base.filter((t) => t.dir > 0).length}, sells ${base.filter((t) => t.dir < 0).length}`);
  const sd = base.map((t) => t.risk / PIP).sort((a, b) => a - b);
  P(`  stop size (${PAIR === 'eurusd' ? 'pips' : 'x $0.10'}): median ${sd[Math.floor(sd.length / 2)].toFixed(1)}, smallest 10% under ${sd[Math.floor(sd.length * 0.1)].toFixed(1)} | cost as a share of the stop: median ${r2(COST / (sd[Math.floor(sd.length / 2)] * PIP))}R`);
  line('buys only', base.filter((t) => t.dir > 0)); line('sells only', base.filter((t) => t.dir < 0));
}

P('\n--- 2. DOES THE ZONE MATTER? (placebo: random time in the same window, random direction, same stop sizes and R:R) ---');
if (base.length) { const pl = placebo({ ...BASE }, base); line('random placebo (20 runs)', pl); line('same signals, OPPOSITE direction', run({ placebo: { flip: true } })); }

P('\n--- 2b. CONCEPT TEST: same idea, looser settings, so there are enough trades to judge ---');
P('  (body 50%, zone life 10 days, reaction within 12 candles, London+NY 3:00-11:00 NY, no swing-break needed, fixed 2R target)');
const loose = run(LOOSE);
line('concept: all 3 years', loose);
line('concept: in-sample', loose.filter((t) => t.date < IS_END));
line('concept: out-of-sample', loose.filter((t) => t.date >= IS_END));
for (const y of ['2023', '2024', '2025', '2026']) { const T = loose.filter((t) => t.date.startsWith(y)); if (T.length) line(`  ${y}`, T); }
if (loose.length) { line('concept: random placebo (20 runs)', placebo({ ...BASE, ...LOOSE }, loose)); line('concept: OPPOSITE direction', run({ ...LOOSE, placebo: { flip: true } })); }
line('concept with zone targets (>=2R)', run({ ...LOOSE, target: 'zone' }));
line('concept, NY 8-11 only', run({ ...LOOSE, win: [480, 660] }));
line('concept, with swing-break rule', run({ ...LOOSE, needBreak: true }));
line('concept, zero costs (edge before costs)', run({ ...LOOSE, cost: 0 }));

P('\n--- 3. COSTS ---');
line('half costs', run({ cost: COST / 2 })); line('base costs', base); line('double costs', run({ cost: COST * 2 })); line('zero costs (not realistic)', run({ cost: 0 }));

P('\n--- 4. ONE CHANGE AT A TIME vs base (all 3 years | out-of-sample only) ---');
const VAR = [
  ['target fixed 2R', { target: 'fixed2R' }], ['target fixed 3R', { target: 'fixed3R' }], ['target zone, else 2R', { target: 'zoneOr2R' }],
  ['FVG required', { fvg: true }], ['1H trend filter (EMA50)', { trend: true }], ['reaction = 3 in a row (his ideal)', { reactMode: 'three' }],
  ['strong body 50%', { minBody: 0.5 }], ['strong body 70%', { minBody: 0.7 }],
  ['zone life 2 days', { zoneDays: 2 }], ['zone life 10 days', { zoneDays: 10 }],
  ['reaction within 3 candles', { react: 3 }], ['reaction within 12 candles', { react: 12 }],
  ['window 9:30-12:30 NY', { win: [570, 750] }], ['window 7:00-11:00 NY', { win: [420, 660] }], ['London+NY 3:00-11:00 NY', { win: [180, 660] }],
  [`min stop ${PAIR === 'eurusd' ? '5 pips' : '$3'}`, { minStop: PAIR === 'eurusd' ? 0.0005 : 3 }],
  [`min stop ${PAIR === 'eurusd' ? '8 pips' : '$5'}`, { minStop: PAIR === 'eurusd' ? 0.0008 : 5 }],
];
line('BASE', base);
for (const [lab, cfg] of VAR) { const T = run(cfg); const a = stats(T), o = stats(T.filter((t) => t.date >= IS_END)); P(`  ${lab.padEnd(34)} ${a ? `${String(a.n).padStart(4)} tr won ${(a.won * 100).toFixed(0)}% PF ${r2(a.pf)} exp ${r2(a.exp)}R total ${r2(a.totR)}R` : 'no trades'} | OOS ${o ? `${o.n} tr exp ${r2(o.exp)}R PF ${r2(o.pf)}` : 'none'}`); }

P('\n--- 5. WALK-FORWARD (choose settings on the past 12 months, trade the next 3 months, repeat) ---');
const GRID = [];
for (const minBody of [0.5, 0.6, 0.7]) for (const zoneDays of [2, 5, 10]) for (const react of [3, 6, 12]) for (const target of ['zone', 'zoneOr2R', 'fixed2R']) for (const fvg of [false, true]) for (const win of [[480, 660], [180, 660]]) for (const needBreak of [true, false]) GRID.push({ minBody, zoneDays, react, target, fvg, win, needBreak });
const runs = GRID.map((g) => ({ g, T: run(g) }));
P(`  ${GRID.length} setting combinations`);
const wf = [];
for (let q = new Date('2024-11-01T00:00:00Z'); q < new Date('2026-11-20T00:00:00Z'); q = new Date(Date.UTC(q.getUTCFullYear(), q.getUTCMonth() + 3, 1))) {
  const ts = q.toISOString().slice(0, 10), te = new Date(Date.UTC(q.getUTCFullYear(), q.getUTCMonth() + 3, 1)).toISOString().slice(0, 10), tr0 = new Date(Date.UTC(q.getUTCFullYear() - 1, q.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const scored = runs.map((r) => { const tr = r.T.filter((t) => t.date >= tr0 && t.date < ts); return { r, n: tr.length, exp: tr.length ? mean(tr.map((t) => t.R)) : -9 }; }).filter((x) => x.n >= 15).sort((a, b) => b.exp - a.exp);
  if (!scored.length) { P(`  ${ts}: no setting had 15+ trades in its training year`); continue; }
  const best = scored[0], test = best.r.T.filter((t) => t.date >= ts && t.date < te);
  wf.push(...test);
  const st = stats(test);
  P(`  train ${tr0}..${ts} best: body ${best.r.g.minBody} life ${best.r.g.zoneDays}d react ${best.r.g.react} ${best.r.g.target}${best.r.g.fvg ? ' FVG' : ''}${best.r.g.needBreak ? '' : ' no-swing-break'} win ${best.r.g.win[0] === 480 ? 'NY 8-11' : 'London+NY 3-11'} (train ${best.n} tr, ${r2(best.exp)}R) -> NEXT 3 MONTHS: ${st ? `${st.n} tr, ${r2(st.exp)}R, total ${r2(st.totR)}R` : 'no trades'}`);
}
line('WALK-FORWARD combined (honest result)', wf.sort((a, b) => a.t - b.t));
const bestAll = runs.map((r) => ({ r, s: stats(r.T) })).filter((x) => x.s && x.s.n >= 40).sort((a, b) => b.s.exp - a.s.exp);
P(`  For comparison - the single best setting over ALL 3 years (looks great, but it was picked by looking at the answers):`);
if (bestAll[0]) line(`  body ${bestAll[0].r.g.minBody} life ${bestAll[0].r.g.zoneDays}d react ${bestAll[0].r.g.react} ${bestAll[0].r.g.target}${bestAll[0].r.g.fvg ? ' FVG' : ''}${bestAll[0].r.g.needBreak ? '' : ' no-swing-break'} ${bestAll[0].r.g.win[0] === 480 ? 'NY 8-11' : 'London+NY 3-11'}`, bestAll[0].r.T);
P(`  Settings with a positive expectancy over 3 years: ${runs.filter((r) => { const s = stats(r.T); return s && s.n >= 40 && s.exp > 0; }).length} of ${runs.filter((r) => (stats(r.T)?.n ?? 0) >= 40).length} (40+ trades)`);

P('\n--- 6. MONTH BY MONTH (base rules, in R) ---');
const mon = new Map(); for (const t of base) mon.set(t.date.slice(0, 7), (mon.get(t.date.slice(0, 7)) ?? 0) + t.R);
P('  ' + [...mon].map(([m, v]) => `${m} ${v >= 0 ? '+' : ''}${v.toFixed(1)}`).join(' | '));
fs.mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL(`./results/${PAIR}-sd-report.txt`, import.meta.url), out.join('\n'));
fs.writeFileSync(new URL(`./results/${PAIR}-sd-trades.csv`, import.meta.url), ['date,time_utc,direction,entry,stop,target,result_R,exit', ...base.map((t) => `${t.date},${new Date(t.t).toISOString().slice(11, 16)},${t.dir > 0 ? 'BUY' : 'SELL'},${t.px},${t.stop.toFixed(5)},${t.tgt.toFixed(5)},${t.R.toFixed(2)},${t.how}`)].join('\n'));
fs.writeFileSync(new URL(`./results/${PAIR}-sd-summary.json`, import.meta.url), JSON.stringify({ base: stats(base), oos: stats(base.filter((t) => t.date >= IS_END)), is: stats(base.filter((t) => t.date < IS_END)), wf: stats(wf), months: [...mon] }));
