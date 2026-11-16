// Step 10b: when big players buy or sell in bulk/block deals, what happens next?
// Deals are published after the close on day d, so we buy at day d+1's open and hold 1, 3, 5 or 10 sessions (8% stop).
// Input: data/research/deals.json (from the deals-data branch: history.json.gz, unzipped) and market.json.
//   node research/10-deals-study.mjs
import fs from 'node:fs';

const DIR = new URL('../data/research/', import.meta.url);
const deals = JSON.parse(fs.readFileSync(new URL('deals.json', DIR), 'utf8'));
const { days, stocks } = JSON.parse(fs.readFileSync(new URL('market.json', DIR), 'utf8'));
const PERIODS = { train: ['2024-01-01', '2025-03-31'], valid: ['2025-04-01', '2025-12-31'], test: ['2026-01-01', '2099-12-31'] };
const periodOf = (iso) => Object.keys(PERIODS).find((k) => iso >= PERIODS[k][0] && iso <= PERIODS[k][1]);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const pct = (v, d = 2) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%`;
const dayIdx = new Map(days.map((d, i) => [d, i]));
const series = {};
for (const [sym, rows] of Object.entries(stocks)) { const arr = new Array(days.length); for (const r of rows) arr[r[0]] = { prev: r[1], open: r[2], high: r[3], low: r[4], close: r[5], cr: r[6], deliv: r[7] }; series[sym] = arr; }

// who is the client? rough groups from the name
const typeOf = (name) => {
  const n = name.toUpperCase();
  if (/MUTUAL FUND|\bMF\b|ASSET MANAGEMENT|\bAMC\b/.test(n)) return 'mutual fund';
  if (/INSURANCE|\bLIC\b|LIFE INSURANCE/.test(n)) return 'insurance';
  if (/FUND|PLC|\bLP\b|L\.P\.|MAURITIUS|SINGAPORE|CAYMAN|INTERNATIONAL|GLOBAL|INVESTMENTS? (LTD|LIMITED|PTE)|BNP|GOLDMAN|MORGAN|SOCIETE|CITIGROUP|NOMURA|UBS|BOFA|JP ?MORGAN/.test(n)) return 'foreign/institution';
  if (/TRADING|FINSOL|BROKING|SECURITIES|STOCK|CAPITAL MARKETS|COMMODIT|VENTURES|FINVEST|ENTERPRISE|HOLDINGS|PRIVATE LIMITED|PVT|LLP/.test(n)) return 'trading firm';
  return 'individual';
};

// one row per (stock, day): net big-player flow, ignoring clients who bought AND sold the same stock that day (day traders)
const byKey = new Map();
for (const d of deals) { const k = `${d.symbol}|${d.date}`; (byKey.get(k) ?? byKey.set(k, []).get(k)).push(d); }
const rows = [];
for (const [k, list] of byKey) {
  const [sym, date] = k.split('|');
  const i = dayIdx.get(date), arr = series[sym];
  if (i == null || !arr?.[i] || i < 25 || i + 11 >= days.length) continue;
  const clientSides = new Map();
  for (const d of list) { const s = clientSides.get(d.client) ?? new Set(); s.add(d.side); clientSides.set(d.client, s); }
  const real = list.filter((d) => clientSides.get(d.client).size === 1);
  if (!real.length) continue;
  const val = (d) => d.qty * d.price / 1e7; // Rs crore
  const buyVal = real.filter((d) => d.side === 'BUY').reduce((s, d) => s + val(d), 0), sellVal = real.filter((d) => d.side === 'SELL').reduce((s, d) => s + val(d), 0);
  const t = arr[i];
  const hist = []; for (let j = i - 1; j >= 0 && hist.length < 20; j--) if (arr[j]) hist.push(arr[j]);
  const liq = median(hist.map((x) => x.cr));
  if (liq < 1) continue;
  const n = arr[i + 1];
  if (!n || Math.abs(n.prev / t.close - 1) > 0.02) continue;
  const buyers = real.filter((d) => d.side === 'BUY'), sellers = real.filter((d) => d.side === 'SELL');
  const r = {
    sym, date, period: periodOf(date), di: i + 1, liq,
    net: buyVal - sellVal, netVsDay: (buyVal - sellVal) / (t.cr || 1), kinds: new Set(real.map((d) => d.kind)),
    buyerTypes: new Set(buyers.map((d) => typeOf(d.client))), sellerTypes: new Set(sellers.map((d) => typeOf(d.client))),
    dayRet: t.close / t.prev - 1, closeVsDeal: buyers.length ? t.close / (buyers.reduce((s, d) => s + d.price * d.qty, 0) / buyers.reduce((s, d) => s + d.qty, 0)) - 1 : null,
    runUp20: hist.length >= 20 ? t.close / hist[19].close - 1 : 0, gap: n.open / n.prev - 1,
  };
  const entry = n.open;
  for (const h of [1, 3, 5, 10]) {
    let out = null, seen = 0;
    for (let j = i + 1; j < days.length; j++) {
      const x = arr[j]; if (!x) continue; seen++;
      if (seen > 1 && x.open <= entry * 0.92) { out = x.open / entry - 1; break; }
      if (x.low <= entry * 0.92) { out = -0.08; break; }
      if (seen === h) { out = x.close / entry - 1; break; }
    }
    r[`d${h}`] = out == null ? null : out - (h === 1 ? 0.0015 : 0.004);
  }
  rows.push(r);
}
console.log(`${deals.length} deals -> ${rows.length} stock-days with big-player deals.`, Object.fromEntries(Object.keys(PERIODS).map((p) => [p, rows.filter((r) => r.period === p).length])));

const C = {
  'net BUY by big players': (r) => r.net > 0, 'net SELL by big players': (r) => r.net < 0,
  'net buy > 20% of the day\'s trading': (r) => r.netVsDay > 0.2, 'net sell > 20% of the day\'s trading': (r) => r.netVsDay < -0.2,
  'mutual fund bought': (r) => r.buyerTypes.has('mutual fund'), 'insurance bought': (r) => r.buyerTypes.has('insurance'), 'foreign/institution bought': (r) => r.buyerTypes.has('foreign/institution'),
  'individual bought': (r) => r.buyerTypes.has('individual'), 'trading firm bought': (r) => r.buyerTypes.has('trading firm'),
  'mutual fund sold': (r) => r.sellerTypes.has('mutual fund'), 'foreign/institution sold': (r) => r.sellerTypes.has('foreign/institution'), 'promoter-like individual sold': (r) => r.sellerTypes.has('individual'),
  'block deal': (r) => r.kinds.has('block'), 'bulk deal': (r) => r.kinds.has('bulk'),
  'stock rose 5%+ on deal day': (r) => r.dayRet >= 0.05, 'stock fell on deal day': (r) => r.dayRet < 0,
  'closed above buyers\' price': (r) => r.closeVsDeal != null && r.closeVsDeal > 0.01, 'closed below buyers\' price': (r) => r.closeVsDeal != null && r.closeVsDeal < -0.01,
  'ran up 20%+ before': (r) => r.runUp20 >= 0.2, 'opens up next day': (r) => r.gap > 0.005, 'opens down next day': (r) => r.gap < -0.005,
  'big stock (Rs 20 cr+/day)': (r) => r.liq >= 20, 'small stock (< Rs 5 cr/day)': (r) => r.liq < 5,
};
const lines = [];
const log = (s = '') => { console.log(s); lines.push(s); };
const statsFor = (list, key) => { const by = new Map(); for (const r of list) { if (r[key] == null) continue; (by.get(r.di) ?? by.set(r.di, []).get(r.di)).push(r[key]); } const d = [...by.values()].map(mean), all = [...by.values()].flat(); return { n: all.length, days: d.length, avg: mean(d), win: mean(all.map((x) => (x > 0 ? 1 : 0))), t: d.length > 1 ? mean(d) / (sd(d) || 1) * Math.sqrt(d.length) : 0 }; };
const fmt = (s) => `n=${String(s.n).padStart(5)} avg ${pct(s.avg).padStart(7)} win ${pct(s.win, 0).padStart(4)}`;
for (const key of ['d1', 'd3', 'd5', 'd10']) {
  log(`\n======== Buy next open, hold ${key.slice(1)} session(s) (8% stop) ========`);
  for (const p of ['train', 'valid', 'test']) log(`All deal stocks ${p}: ${fmt(statsFor(rows.filter((r) => r.period === p), key))}`);
  for (const [n, f] of Object.entries(C)) log(`  ${n.padEnd(40)} ${['train', 'valid', 'test'].map((p) => fmt(statsFor(rows.filter((r) => r.period === p && f(r)), key))).join(' | ')}`);
  const names = Object.keys(C), found = [];
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) for (let k = j; k < names.length; k++) {
    const combo = k === j ? [names[i], names[j]] : [names[i], names[j], names[k]];
    const f = (r) => combo.every((n) => C[n](r));
    const a = statsFor(rows.filter((r) => r.period === 'train' && f(r)), key);
    if (a.n < 40 || a.avg <= 0.005 || a.t < 2) continue;
    const b = statsFor(rows.filter((r) => r.period === 'valid' && f(r)), key);
    if (b.n < 25 || b.avg <= 0.003) continue;
    found.push({ combo, a, b, c: statsFor(rows.filter((r) => r.period === 'test' && f(r)), key) });
  }
  found.sort((x, y) => Math.min(y.a.avg, y.b.avg) - Math.min(x.a.avg, x.b.avg));
  log(`${found.length} combinations made money in train (t>2) and valid. Top 15 (TEST only to judge):`);
  for (const f of found.slice(0, 15)) log(`  ${f.combo.join(' + ').padEnd(90)} train ${fmt(f.a)} | valid ${fmt(f.b)} | TEST ${fmt(f.c)}`);
}
fs.writeFileSync(new URL('deals-report.txt', DIR), lines.join('\n'));
