// WIDE SEARCH with a locked holdout. Hourly Dukascopy data (h1-download.mjs), 12 markets.
//   FIND   candidates only on 2018-03 .. 2022-12
//   PROVE  them on 2023-01 .. 2026-11, which the search never sees. Only what still works there counts.
// Families
//  A  research-backed, fixed rules (no search, judged on 2018-2026):
//     A1 Time-series momentum (Moskowitz, Ooi, Pedersen 2012): each month-end, long if the 12-month return > 0 else
//        short; hold one month. All 12 markets.
//     A2 Trend filter (Faber 2007): long when the month-end close is above its 10-month average, else flat. Long only.
//     A3 Pre-FOMC drift (Lucca & Moench 2015): buy US indices 14:00 NY the day before a Fed decision, sell 14:00 NY on
//        decision day (before the statement).
//  B  time-of-day / day-of-week: every window of 1-8 hours (NY clock, trading day starts 17:00 NY), long or short,
//     every day or one weekday only.
//  C  dip / rally rules held 1-20 days: k-day move (k = 1,2,3,5,10,20) beyond 1 / 1.5 / 2 / 2.5 normal-sized moves
//     (60-day volatility), long or short, with no filter / above / below the 200-day average; hold 1,2,3,5,10,20 days.
// Costs as in edge-lab.mjs (spread + commission + slippage), financing for every night held.
//   node --max-old-space-size=8000 wide-search.mjs
import fs from 'node:fs';

const NY = 'America/New_York';
const MK = {
  us500: { file: 'usa500idxusd', cost: 0.6, swap: 0.07, idx: true, us: true }, nas100: { file: 'usatechidxusd', cost: 2.0, swap: 0.07, idx: true, us: true },
  us30: { file: 'usa30idxusd', cost: 3.0, swap: 0.07, idx: true, us: true }, ger40: { file: 'deuidxeur', cost: 2.0, swap: 0.07, idx: true },
  jpn225: { file: 'jpnidxjpy', cost: 12, swap: 0.07, idx: true }, xauusd: { file: 'xauusd', cost: 0.5, swap: 0.07, lo: true },
  xagusd: { file: 'xagusd', cost: 0.035, swap: 0.07, lo: true }, wti: { file: 'lightcmdusd', cost: 0.05, swap: 0.07, lo: true },
  btcusd: { file: 'btcusd', costPct: 0.0006, swap: 0.18, lo: true }, eurusd: { file: 'eurusd', cost: 0.00013, swap: 0.02 },
  gbpusd: { file: 'gbpusd', cost: 0.00018, swap: 0.02 }, usdjpy: { file: 'usdjpy', cost: 0.018, swap: 0.02 },
};
const D0 = '2018-03-01', D1 = '2023-01-01', D2 = '2026-11-20';
const FOMC = ['2018-03-21', '2018-05-02', '2018-06-13', '2018-08-01', '2018-09-26', '2018-11-08', '2018-12-19',
  '2019-01-30', '2019-03-20', '2019-05-01', '2019-06-19', '2019-07-31', '2019-09-18', '2019-10-30', '2019-12-11',
  '2020-01-29', '2020-04-29', '2020-06-10', '2020-07-29', '2020-09-16', '2020-11-05', '2020-12-16',
  '2021-01-27', '2021-03-17', '2021-04-28', '2021-06-16', '2021-07-28', '2021-09-22', '2021-11-03', '2021-12-15',
  '2022-01-26', '2022-03-16', '2022-05-04', '2022-06-15', '2022-07-27', '2022-09-21', '2022-11-02', '2022-12-14',
  '2023-02-01', '2023-03-22', '2023-05-03', '2023-06-14', '2023-07-26', '2023-09-20', '2023-11-01', '2023-12-13',
  '2024-01-31', '2024-03-20', '2024-05-01', '2024-06-12', '2024-07-31', '2024-09-18', '2024-11-07', '2024-12-18',
  '2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18', '2025-07-30', '2025-09-17', '2025-10-29', '2025-12-10',
  '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28']; // scheduled meetings only (decision day)
const out = []; const P = (...a) => { const l = a.join(' '); console.log(l); out.push(l); };
const fmt = new Intl.DateTimeFormat('en-US', { timeZone: NY, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short' });
const cache = new Map();
const nyOf = (t) => { const hk = Math.floor(t / 3600000); let v = cache.get(hk); if (!v) { const p = Object.fromEntries(fmt.formatToParts(new Date(hk * 3600000)).map((x) => [x.type, x.value])); v = { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, wd: p.weekday }; cache.set(hk, v); } return v; };
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
function st(r) { const n = r.length; if (!n) return { n: 0, avg: NaN, t: 0, win: NaN }; const avg = mean(r), sd = Math.sqrt(r.reduce((s, x) => s + (x - avg) ** 2, 0) / Math.max(1, n - 1)); return { n, avg, t: sd > 0 ? avg / (sd / Math.sqrt(n)) : 0, win: r.filter((x) => x > 0).length / n }; }
const pc = (v, d = 3) => (Number.isFinite(v) ? (v * 100).toFixed(d) + '%' : '-');
const fs1 = (s) => `${String(s.n).padStart(4)} tr won ${pc(s.win, 0).padStart(4)} avg ${pc(s.avg).padStart(8)} t ${s.t.toFixed(2).padStart(5)}`;

// ---------- load: hourly bars -> trading days (17:00 NY roll) ----------
const DATA = {};
for (const [k, M] of Object.entries(MK)) {
  const raw = JSON.parse(fs.readFileSync(new URL(`./data/${M.file}-h1.json`, import.meta.url), 'utf8'));
  const days = []; let cur = null;
  for (const r of raw) {
    const ny = nyOf(r[0]), roll = nyOf(r[0] + 7 * 3600000), sh = (ny.hour + 7) % 24; // session hour 0 = 17:00 NY
    if (!cur || cur.date !== roll.date) { cur = { date: roll.date, wd: roll.wd, bars: new Array(24).fill(null), o: r[1], h: r[2], l: r[3], c: r[4], nyHourBar: {} }; days.push(cur); }
    cur.bars[sh] = r; cur.h = Math.max(cur.h, r[2]); cur.l = Math.min(cur.l, r[3]); cur.c = r[4]; cur.nyHourBar[ny.hour] = r;
  }
  DATA[k] = days.filter((d) => d.bars.filter(Boolean).length >= 10);
  P(`${k}: ${DATA[k].length} trading days ${DATA[k][0].date} .. ${DATA[k].at(-1).date}`);
}
const costF = (k, px) => (MK[k].costPct ?? MK[k].cost / px);
const swapN = (k, n) => (MK[k].swap / 365) * n;
const nightsBetween = (a, b) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 86400000));

// ======================= A: research-backed =======================
P('\n================ A. RESEARCH-BACKED RULES (fixed, judged on Mar 2018 - Nov 2026) ================');
const monthEnds = (k) => { const d = DATA[k], m = []; for (let i = 0; i < d.length; i++) if (i === d.length - 1 || d[i + 1].date.slice(0, 7) !== d[i].date.slice(0, 7)) m.push(d[i]); return m; };
{ // A1 TSMOM
  const all = []; P('A1 Time-series momentum (12-month signal, hold 1 month), per market: 2018-2022 | 2023-2026');
  for (const k of Object.keys(MK)) {
    const me = monthEnds(k), r = []; let prevDir = 0;
    for (let i = 12; i < me.length - 1; i++) {
      if (me[i].date < D0) { prevDir = Math.sign(me[i].c / me[i - 12].c - 1); continue; }
      const dir = Math.sign(me[i].c / me[i - 12].c - 1) || 1;
      const g = dir * (me[i + 1].c / me[i].c - 1), c = dir !== prevDir ? costF(k, me[i].c) * (prevDir ? 2 : 1) : 0;
      r.push({ date: me[i].date, pct: g - c - swapN(k, nightsBetween(me[i].date, me[i + 1].date)) }); prevDir = dir;
    }
    all.push(...r);
    P(`  ${k.padEnd(7)} ${fs1(st(r.filter((x) => x.date < D1).map((x) => x.pct)))} | ${fs1(st(r.filter((x) => x.date >= D1).map((x) => x.pct)))}`);
  }
  P(`  ALL 12  ${fs1(st(all.filter((x) => x.date < D1).map((x) => x.pct)))} | ${fs1(st(all.filter((x) => x.date >= D1).map((x) => x.pct)))}   (per market-month)`);
}
{ // A2 Faber
  P('A2 Trend filter (above 10-month average -> hold, else cash), long only. avg per month | buy & hold | worst month / max drawdown, 2018-2026');
  for (const k of Object.keys(MK).filter((k) => MK[k].idx || MK[k].lo)) {
    const me = monthEnds(k), rs = [], bh = [];
    for (let i = 10; i < me.length - 1; i++) {
      if (me[i].date < D0) continue;
      const sma = mean(me.slice(i - 9, i + 1).map((x) => x.c)), ret = me[i + 1].c / me[i].c - 1;
      bh.push(ret); rs.push(me[i].c > sma ? ret - swapN(k, 30) - costF(k, me[i].c) / 3 : 0);
    }
    const dd = (a) => { let e = 1, pk = 1, m = 0; for (const x of a) { e *= 1 + x; pk = Math.max(pk, e); m = Math.min(m, e / pk - 1); } return [e - 1, m]; };
    const [tf, tdd] = dd(rs), [tb, bdd] = dd(bh);
    P(`  ${k.padEnd(7)} filter: total ${pc(tf, 0).padStart(6)} maxDD ${pc(tdd, 0).padStart(5)} | buy&hold: total ${pc(tb, 0).padStart(6)} maxDD ${pc(bdd, 0).padStart(5)}`);
  }
}
{ // A3 pre-FOMC drift
  P('A3 Pre-FOMC drift: long 14:00 NY day before -> 14:00 NY decision day. Other 14:00->14:00 days = comparison');
  for (const k of ['us500', 'nas100', 'us30']) {
    const d = DATA[k], idx = new Map(d.map((x, i) => [x.date, i])), f = [], other = [];
    for (let i = 1; i < d.length; i++) {
      const a = d[i - 1].nyHourBar[14], b = d[i].nyHourBar[14]; if (!a || !b || d[i].date < D0) continue;
      const r = b[1] / a[1] - 1 - costF(k, a[1]);
      (FOMC.includes(d[i].date) ? f : other).push({ date: d[i].date, pct: r });
    }
    P(`  ${k.padEnd(7)} FOMC 2018-22 ${fs1(st(f.filter((x) => x.date < D1).map((x) => x.pct)))} | 2023-26 ${fs1(st(f.filter((x) => x.date >= D1).map((x) => x.pct)))} | other days ${pc(mean(other.map((x) => x.pct)))}`);
    void idx;
  }
}

// ======================= B / C: search on 2018-2022, prove on 2023-2026 =======================
const found = { B: [], C: [] }; let testedB = 0, testedC = 0;
for (const k of Object.keys(MK)) {
  const d = DATA[k];
  // ---- B: hour windows ----
  for (const wdf of [null, 'Mon', 'Tue', 'Wed', 'Thu', 'Fri']) for (let s = 0; s < 24; s++) for (let L = 1; L <= 8 && s + L <= 24; L++) {
    const disc = [], hold = [];
    for (const x of d) {
      if (wdf && x.wd !== wdf) continue; const a = x.bars[s], b = x.bars[s + L - 1]; if (!a || !b || x.date < D0) continue;
      const g = b[4] / a[1] - 1; (x.date < D1 ? disc : hold).push(g);
    }
    if (disc.length < 150) continue;
    for (const dir of [1, -1]) {
      testedB++;
      const c = costF(k, d.at(-1).c), sd = st(disc.map((g) => dir * g - c));
      if (sd.t >= 3) found.B.push({ k, rule: `${dir > 0 ? 'LONG' : 'SHORT'} ${String((s + 17) % 24).padStart(2, '0')}:00-${String((s + L + 17) % 24).padStart(2, '0')}:00 NY${wdf ? ' ' + wdf : ''}`, disc: sd, hold: st(hold.map((g) => dir * g - c)), hold2x: st(hold.map((g) => dir * g - 2 * c)) });
    }
  }
  // ---- C: dip / rally rules ----
  const c = d.map((x) => x.c), n = d.length, lr = c.map((v, i) => (i ? Math.log(v / c[i - 1]) : 0));
  const vol = new Float64Array(n).fill(NaN); for (let i = 61; i < n; i++) { let s = 0, s2 = 0; for (let j = i - 59; j <= i; j++) { s += lr[j]; s2 += lr[j] * lr[j]; } vol[i] = Math.sqrt(Math.max(1e-12, s2 / 60 - (s / 60) ** 2)); }
  const sma200 = new Float64Array(n).fill(NaN); { let s = 0; for (let i = 0; i < n; i++) { s += c[i]; if (i >= 200) s -= c[i - 200]; if (i >= 199) sma200[i] = s / 200; } }
  for (const K of [1, 2, 3, 5, 10, 20]) for (const Z of [1, 1.5, 2, 2.5]) for (const side of ['dip', 'rally']) for (const dir of [1, -1]) for (const filt of ['none', 'above200', 'below200']) for (const Hd of [1, 2, 3, 5, 10, 20]) {
    testedC++;
    const disc = [], hold = [];
    for (let i = 201; i < n - Hd - 1; i++) {
      if (d[i].date < D0 || !Number.isFinite(vol[i])) continue;
      const z = Math.log(c[i] / c[i - K]) / (vol[i] * Math.sqrt(K));
      if (side === 'dip' ? z > -Z : z < Z) continue;
      if (filt === 'above200' && !(c[i] > sma200[i])) continue; if (filt === 'below200' && !(c[i] < sma200[i])) continue;
      const e = d[i + 1].o, x = d[i + Hd].c; // enter next day's open, exit at the close Hd days after the signal day
      const r = dir * (x / e - 1) - costF(k, e) - swapN(k, nightsBetween(d[i + 1].date, d[i + Hd].date));
      (d[i].date < D1 ? disc : hold).push({ r, c2: r - costF(k, e) });
      i += Hd; // no overlapping trades
    }
    if (disc.length < 30) continue;
    const sd = st(disc.map((x) => x.r));
    if (sd.t >= 3) found.C.push({ k, rule: `${dir > 0 ? 'BUY' : 'SELL'} after ${K}-day ${side} > ${Z} normal moves, ${filt}, hold ${Hd}d`, disc: sd, hold: st(hold.map((x) => x.r)), hold2x: st(hold.map((x) => x.c2)) });
  }
}
for (const [fam, title, tested] of [['B', 'B. TIME-OF-DAY / DAY-OF-WEEK', testedB], ['C', 'C. DIP / RALLY RULES, HOLD 1-20 DAYS', testedC]]) {
  const f = found[fam], ok = f.filter((x) => x.hold.n >= 20 && x.hold.avg > 0 && x.hold.t >= 2 && x.hold2x.avg > 0);
  P(`\n================ ${title} ================`);
  P(`  rules tested: ${tested} | strong on 2018-2022 (t >= 3): ${f.length} | ALSO worked 2023-2026 (t >= 2, profit at 2x cost): ${ok.length} (about ${(f.length * 0.023).toFixed(1)} expected by luck if nothing is real)`);
  P('  candidates found on 2018-2022, and what happened on unseen 2023-2026 (top 30 by 2018-2022 strength):');
  for (const x of [...f].sort((a, b) => b.disc.t - a.disc.t).slice(0, 30)) P(`   ${x.k.padEnd(7)} ${x.rule.padEnd(58)} 2018-22: ${fs1(x.disc)} | 2023-26: ${fs1(x.hold)} ${x.hold.avg > 0 && x.hold.t >= 2 && x.hold2x.avg > 0 ? '<= HELD UP' : ''}`);
  if (ok.length) { P('  ALL that held up:'); for (const x of ok.sort((a, b) => b.hold.t - a.hold.t)) P(`   ${x.k.padEnd(7)} ${x.rule.padEnd(58)} 2018-22: ${fs1(x.disc)} | 2023-26: ${fs1(x.hold)} | 2x cost ${pc(x.hold2x.avg)}`); }
  fs.writeFileSync(new URL(`./results/wide-search-${fam}.json`, import.meta.url), JSON.stringify(f, null, 1));
}
fs.writeFileSync(new URL('./results/wide-search-report.txt', import.meta.url), out.join('\n'));
