// Step 1: every NSE stock's daily prices + delivery, from the NSE archive (one file per trading day).
// Output: data/research/market.json = { days: [iso...], stocks: { SYMBOL: [[dayIdx, prevClose, open, high, low, close, turnoverCr, delivPct], ...] } }
import fs from 'node:fs';
import { fetchCached } from '../src/sources.mjs';

const FROM = process.argv[2] ?? '2024-01-01';
const TO = process.argv[3] ?? new Date(Date.now() + 19800e3 - 864e5).toISOString().slice(0, 10);
const OUT_DIR = new URL('../data/research/', import.meta.url);
fs.mkdirSync(OUT_DIR, { recursive: true });

const days = [];
const stocks = {};
const num = (s) => { const v = Number(String(s).trim()); return Number.isFinite(v) ? v : null; };
let d = new Date(FROM + 'T00:00:00Z');
const end = new Date(TO + 'T00:00:00Z');
let tried = 0;
for (; d <= end; d = new Date(+d + 864e5)) {
  const wd = d.getUTCDay();
  if (wd === 0 || wd === 6) continue;
  const iso = d.toISOString().slice(0, 10);
  const [y, m, dd] = iso.split('-');
  const csv = await fetchCached(`https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${dd}${m}${y}.csv`, { ttlHours: 1e7 }).catch(() => null);
  if (++tried % 50 === 0) console.log(`  ${iso}: ${days.length} trading days so far`);
  if (!csv || !csv.startsWith('SYMBOL')) continue; // holiday
  const lines = csv.trim().split(/\r?\n/);
  const head = lines[0].split(',').map((x) => x.trim());
  const c = (n) => head.indexOf(n);
  const idx = days.push(iso) - 1;
  for (const line of lines.slice(1)) {
    const p = line.split(',').map((x) => x.trim());
    if (p[c('SERIES')] !== 'EQ' && p[c('SERIES')] !== 'BE') continue;
    const row = [idx, num(p[c('PREV_CLOSE')]), num(p[c('OPEN_PRICE')]), num(p[c('HIGH_PRICE')]), num(p[c('LOW_PRICE')]), num(p[c('CLOSE_PRICE')]),
      Math.round((num(p[c('TURNOVER_LACS')]) ?? 0) / 100 * 100) / 100, num(p[c('DELIV_PER')])];
    if (row.slice(1, 6).some((v) => v == null || v <= 0)) continue;
    (stocks[p[c('SYMBOL')]] ??= []).push(row);
  }
}
fs.writeFileSync(new URL('market.json', OUT_DIR), JSON.stringify({ days, stocks }));
console.log(`Saved ${days.length} trading days, ${Object.keys(stocks).length} stocks (${days[0]} to ${days.at(-1)}).`);
