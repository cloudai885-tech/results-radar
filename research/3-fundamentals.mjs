// Step 3: quarterly numbers (Screener) for every NSE stock that trades at least MIN_CR crore a day.
// About 3 s per page, so the first run of ~1,500 stocks takes 1.5-3 hours; later runs use the cache.
// Output: data/research/fundamentals.json = { SYMBOL: { sector, industry, mcap, pe, q: {ord: {sales, pat, opm, oi, pbt}}, h: {ord: {fii, dii, promoter, holders}} } }
import fs from 'node:fs';
import { fundamentals, mapPool } from '../src/sources.mjs';

const MIN_CR = Number(process.argv[2] ?? 2);
const DIR = new URL('../data/research/', import.meta.url);
const { days, stocks } = JSON.parse(fs.readFileSync(new URL('market.json', DIR), 'utf8'));
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; };
const recent = days.length - 250;
const symbols = Object.entries(stocks)
  .filter(([, rows]) => median(rows.filter((r) => r[0] >= recent).map((r) => r[6])) >= MIN_CR)
  .map(([s]) => s);
console.log(`${symbols.length} stocks trade at least Rs ${MIN_CR} cr a day.`);

const out = {};
let missing = 0;
await mapPool(symbols, 2, async (symbol) => {
  const f = await fundamentals(symbol, 24 * 60).catch(() => null);
  if (!f) { missing++; return; }
  const q = {}, h = {};
  for (const [o, v] of f.quarters) q[o] = { sales: v.sales, pat: v.pat, opm: v.opm, oi: v.otherIncome, pbt: v.pbt };
  for (const [o, v] of f.holdings) h[o] = v;
  out[symbol] = { sector: f.classification.sector, industry: f.classification.industry, mcap: f.marketCapCr, pe: f.pe, q, h };
}, (done, total) => { if (done % 100 === 0) console.log(`  ${done}/${total}`); });
fs.writeFileSync(new URL('fundamentals.json', DIR), JSON.stringify(out));
console.log(`Saved ${Object.keys(out).length} companies (${missing} without Screener data).`);
