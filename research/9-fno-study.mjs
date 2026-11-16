// Step 9b: do big players' F&O positions predict the next day? Signals from day d's F&O close, plus day d+1's opening move
// (known at 9:08). Trade: buy at d+1 open, +7% target / 3% stop, else 3:20 pm (also: hold 3 sessions).
// Patterns chosen on TRAIN, confirmed on VALID, judged on TEST.
//   node research/9-fno-study.mjs
import fs from 'node:fs';

const DIR = new URL('../data/research/', import.meta.url);
const { days, stocks } = JSON.parse(fs.readFileSync(new URL('market.json', DIR), 'utf8'));
const funda = fs.existsSync(new URL('fundamentals.json', DIR)) ? JSON.parse(fs.readFileSync(new URL('fundamentals.json', DIR), 'utf8')) : {};
const fo = days.map((d) => { const f = new URL(`fo-days/${d}.json`, DIR); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; });
const PERIODS = { train: ['2024-03-01', '2025-03-31'], valid: ['2025-04-01', '2025-12-31'], test: ['2026-01-01', '2099-12-31'] };
const periodOf = (iso) => Object.keys(PERIODS).find((k) => iso >= PERIODS[k][0] && iso <= PERIODS[k][1]);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const pct = (v, d = 2) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%`;
console.log(`F&O data for ${fo.filter(Boolean).length} of ${days.length} days.`);

const series = {};
for (const [sym, rows] of Object.entries(stocks)) { const arr = new Array(days.length); for (const r of rows) arr[r[0]] = { prev: r[1], open: r[2], high: r[3], low: r[4], close: r[5], cr: r[6] }; series[sym] = arr; }
// market opening mood per day
const mGap = days.map((_, i) => median(Object.values(series).map((a) => a[i]).filter((t) => t && t.cr >= 2).map((t) => t.open / t.prev - 1)));

const rows = [];
for (const sym of new Set(fo.filter(Boolean).flatMap((x) => Object.keys(x)))) {
  const arr = series[sym];
  if (!arr) continue;
  for (let d = 21; d < days.length - 3; d++) {
    const F = fo[d]?.[sym], t = arr[d], n = arr[d + 1];
    if (!F || !t || !n || !F.futOI) continue;
    if (Math.abs(n.prev / t.close - 1) > 0.02) continue; // split day
    const past = []; for (let j = d - 20; j < d; j++) if (fo[j]?.[sym]) past.push(fo[j][sym]);
    if (past.length < 15) continue;
    const ret = t.close / t.prev - 1;
    const oiChg = F.futOIchg / Math.max(F.futOI - F.futOIchg, 1);
    const pcr = F.callOI ? F.putOI / F.callOI : null, pcrPrev = past.at(-1).callOI ? past.at(-1).putOI / past.at(-1).callOI : null;
    const callVolX = F.callVol / (mean(past.map((p) => p.callVol)) || 1), putVolX = F.putVol / (mean(past.map((p) => p.putVol)) || 1);
    const futVolX = F.futVol / (mean(past.map((p) => p.futVol)) || 1);
    const premium = F.futClose && F.under ? F.futClose / F.under - 1 : null;
    const premiumPrev = past.at(-1).futClose && past.at(-1).under ? past.at(-1).futClose / past.at(-1).under - 1 : null;
    const oi5 = past.length >= 5 ? F.futOI / (past.at(-5).futOI || F.futOI) - 1 : 0;
    const gap = n.open / n.prev - 1;
    // outcomes from the next session's open
    const stop = n.open * 0.97, tgt = n.open * 1.07, cost = 0.0015;
    const intradayT = (n.low <= stop ? -0.03 : n.high >= tgt ? 0.07 : n.close / n.open - 1) - cost;
    let hold3 = null; const a2 = arr[d + 2], a3 = arr[d + 3];
    if (a2 && a3) { let ex = a3.close; if (n.low <= stop) ex = stop; else if (a2.open <= stop) ex = a2.open; else if (a2.low <= stop) ex = stop; else if (a3.open <= stop) ex = a3.open; else if (a3.low <= stop) ex = stop; hold3 = ex / n.open - 1 - 0.003; }
    rows.push({
      sym, di: d + 1, day: days[d + 1], period: periodOf(days[d + 1]), sector: funda[sym]?.sector ?? 'Unknown', liq: t.cr,
      ret, oiChg, oi5, pcr, pcrChg: pcr != null && pcrPrev != null ? pcr - pcrPrev : null, callVolX, putVolX, futVolX, premium, premiumChg: premium != null && premiumPrev != null ? premium - premiumPrev : null,
      gap, mktGap: mGap[d + 1], intradayT, hold3,
    });
  }
}
console.log(`${rows.length} F&O stock-days.`, Object.fromEntries(Object.keys(PERIODS).map((p) => [p, rows.filter((r) => r.period === p).length])));

const C = {
  'LONG BUILD-UP (price +1%, OI +3%)': (r) => r.ret >= 0.01 && r.oiChg >= 0.03,
  'strong long build-up (price +2%, OI +7%)': (r) => r.ret >= 0.02 && r.oiChg >= 0.07,
  'SHORT COVERING (price +1%, OI -3%)': (r) => r.ret >= 0.01 && r.oiChg <= -0.03,
  'SHORT BUILD-UP (price -1%, OI +3%)': (r) => r.ret <= -0.01 && r.oiChg >= 0.03,
  'LONG UNWINDING (price -1%, OI -3%)': (r) => r.ret <= -0.01 && r.oiChg <= -0.03,
  'OI up 15%+ in 5 days': (r) => r.oi5 >= 0.15, 'OI down 15%+ in 5 days': (r) => r.oi5 <= -0.15,
  'call volume 3x normal': (r) => r.callVolX >= 3, 'call volume 5x normal': (r) => r.callVolX >= 5, 'put volume 3x normal': (r) => r.putVolX >= 3,
  'calls busier than puts (call x > 2 * put x)': (r) => r.callVolX > 2 * r.putVolX && r.callVolX >= 2,
  'futures volume 3x normal': (r) => r.futVolX >= 3,
  'PCR high (>1.2, fearful)': (r) => r.pcr != null && r.pcr > 1.2, 'PCR low (<0.5, greedy)': (r) => r.pcr != null && r.pcr < 0.5,
  'PCR rising 0.15+': (r) => r.pcrChg != null && r.pcrChg >= 0.15, 'PCR falling 0.15+': (r) => r.pcrChg != null && r.pcrChg <= -0.15,
  'futures premium rising': (r) => r.premiumChg != null && r.premiumChg > 0.002, 'futures at discount': (r) => r.premium != null && r.premium < -0.001,
  'opens 2%+ up': (r) => r.gap >= 0.02, 'opens 0..2% up': (r) => r.gap >= 0 && r.gap < 0.02, 'opens 0..-2%': (r) => r.gap < 0 && r.gap > -0.02, 'opens 2%+ down': (r) => r.gap <= -0.02,
  'market opening down': (r) => r.mktGap < -0.003, 'market opening up': (r) => r.mktGap > 0.003,
  'fell 3%+ that day': (r) => r.ret <= -0.03, 'rose 3%+ that day': (r) => r.ret >= 0.03,
};
const names = Object.keys(C);
const masks = Object.fromEntries(names.map((n) => [n, Uint8Array.from(rows, (r) => (C[n](r) ? 1 : 0))]));
const idx = { train: [], valid: [], test: [] };
rows.forEach((r, i) => idx[r.period]?.push(i));
function statsFor(ids, key) {
  const by = new Map();
  for (const i of ids) { const v = rows[i][key]; if (v == null) continue; (by.get(rows[i].di) ?? by.set(rows[i].di, []).get(rows[i].di)).push(v); }
  const d = [...by.values()].map(mean), all = [...by.values()].flat();
  return { n: all.length, days: d.length, avg: mean(d), win: mean(all.map((x) => (x > 0 ? 1 : 0))), t: d.length > 1 ? (mean(d) / (sd(d) || 1)) * Math.sqrt(d.length) : 0 };
}
const fmt = (s) => `n=${String(s.n).padStart(5)} ${String(s.days).padStart(3)}d day-avg ${pct(s.avg).padStart(7)} win ${pct(s.win, 0).padStart(4)}`;
const lines = [];
const log = (s = '') => { console.log(s); lines.push(s); };
for (const key of ['intradayT', 'hold3']) {
  log(`\n======== ${key === 'intradayT' ? 'Next day: buy at open, +7%/-3%, else 3:20 pm' : 'Buy next open, hold 3 sessions, 3% stop'} ========`);
  for (const p of ['train', 'valid', 'test']) log(`All F&O stocks ${p}: ${fmt(statsFor(idx[p], key))}`);
  log('Single signals (train | valid | test):');
  for (const n of names) log(`  ${n.padEnd(46)} ${['train', 'valid', 'test'].map((p) => fmt(statsFor(idx[p].filter((i) => masks[n][i]), key))).join(' | ')}`);
  const found = [];
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) for (let k = j; k < names.length; k++) {
    const combo = k === j ? [names[i], names[j]] : [names[i], names[j], names[k]];
    const tr = idx.train.filter((x) => combo.every((n) => masks[n][x]));
    if (tr.length < 50) continue;
    const a = statsFor(tr, key);
    if (a.days < 20 || a.avg <= 0.003 || a.t < 2) continue;
    const b = statsFor(idx.valid.filter((x) => combo.every((n) => masks[n][x])), key);
    if (b.days < 12 || b.avg <= 0.002) continue;
    found.push({ combo, a, b, c: statsFor(idx.test.filter((x) => combo.every((n) => masks[n][x])), key) });
  }
  found.sort((x, y) => Math.min(y.a.avg, y.b.avg) - Math.min(x.a.avg, x.b.avg));
  log(`${found.length} combinations made money in train (t>2) and valid. Top 20 (TEST only to judge):`);
  for (const f of found.slice(0, 20)) log(`  ${f.combo.join(' + ').padEnd(90)} train ${fmt(f.a)} | valid ${fmt(f.b)} | TEST ${fmt(f.c)}`);
}
fs.writeFileSync(new URL('fno-report.txt', DIR), lines.join('\n'));
