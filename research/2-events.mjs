// Step 2: NSE announcement history, one company at a time (a whole day of all companies is too big for NSE to answer).
// Companies come from research/symbols.txt (stocks trading Rs 2 cr+ a day). Runs on GitHub Actions; NSE blocks some home networks.
// Output: data/research/events.json = [{ symbol, time: 'YYYY-MM-DD HH:MM', desc, text, cat }]
import fs from 'node:fs';
import { nseJson, mapPool } from '../src/sources.mjs';
import { categorise } from './categories.mjs';

const FROM = process.argv[2] || '2024-01-01';
const TO = process.argv[3] || new Date(Date.now() + 19800e3).toISOString().slice(0, 10);
const OUT = new URL('../data/research/events.json', import.meta.url);
fs.mkdirSync(new URL('../data/research/', import.meta.url), { recursive: true });
const symbols = fs.readFileSync(new URL('./symbols.txt', import.meta.url), 'utf8').split(/\s+/).filter(Boolean);
const nse = (iso) => iso.split('-').reverse().join('-');
const MON = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
const parseTime = (s) => { const m = /(\d+)-(\w{3})-(\d{4}) (\d+):(\d+)/.exec(s ?? ''); return m ? `${m[3]}-${MON[m[2]]}-${m[1].padStart(2, '0')} ${m[4].padStart(2, '0')}:${m[5]}` : null; };

// Year-long windows keep each answer small.
const windows = [];
for (let y = Number(FROM.slice(0, 4)); y <= Number(TO.slice(0, 4)); y++) {
  const a = `${y}-01-01` < FROM ? FROM : `${y}-01-01`, b = `${y}-12-31` > TO ? TO : `${y}-12-31`;
  windows.push([a, b]);
}
// Quick check first, so a blocked network fails in about a minute instead of hours.
const probe = await nseJson(`corporate-announcements?index=equities&symbol=RELIANCE&from_date=01-10-2025&to_date=31-10-2025`, 0, { timeoutMs: 45000, attempts: 2 }).catch((e) => String(e));
if (!Array.isArray(probe)) { console.error('NSE is not answering (test request failed):', probe); process.exit(1); }
console.log(`NSE answers (test: ${probe.length} RELIANCE announcements in Oct 2025). Fetching ${symbols.length} companies...`);

const all = [];
let ok = 0, failed = 0;
await mapPool(symbols, 1, async (symbol, i) => {
  for (const [a, b] of windows) {
    const list = await nseJson(`corporate-announcements?index=equities&symbol=${encodeURIComponent(symbol)}&from_date=${nse(a)}&to_date=${nse(b)}`, 1e7, { timeoutMs: 90000, attempts: 3 }).catch(() => null);
    if (!Array.isArray(list)) { failed++; continue; }
    ok++;
    for (const x of list) {
      const time = parseTime(x.an_dt);
      if (!time) continue;
      const text = (x.attchmntText ?? '').slice(0, 300);
      all.push({ symbol, time, desc: x.desc ?? '', text, cat: categorise(x.desc ?? '', text) });
    }
  }
  if (ok === 0 && failed >= 15) { console.error('NSE is not answering at all. Stopping early.'); process.exit(1); }
}, (done, total) => { if (done % 50 === 0) console.log(`  ${done}/${total} companies, ${all.length} announcements, ${failed} failed requests`); });
fs.writeFileSync(OUT, JSON.stringify(all));
const counts = {};
for (const e of all) counts[e.cat] = (counts[e.cat] ?? 0) + 1;
console.log(`Saved ${all.length} announcements (${failed} failed requests).`, counts);
