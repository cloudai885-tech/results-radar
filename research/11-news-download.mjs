// Step 11: every NSE company announcement, one calendar day at a time (all companies per request).
// NSE answers this from home networks again since the Nov 2026 cookie fix. Merges into the existing file, so reruns only fetch new days.
//   node research/11-news-download.mjs [from=2024-01-01] [to=today]
// Output: data/research/news.json = [{ symbol, time: 'YYYY-MM-DD HH:MM:SS', desc, text, cat }]
import fs from 'node:fs';
import { nseJson } from '../src/sources.mjs';
import { categorise } from './categories.mjs';

const FROM = process.argv[2] || '2024-01-01';
const TO = process.argv[3] || new Date(Date.now() + 19800e3).toISOString().slice(0, 10);
const OUT = new URL('../data/research/' + (process.env.OUT ?? 'news.json'), import.meta.url);
const MON = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
const parseTime = (s) => { const m = /(\d+)-(\w{3})-(\d{4}) (\d+):(\d+):(\d+)/.exec(s ?? ''); return m ? `${m[3]}-${MON[m[2]]}-${m[1].padStart(2, '0')} ${m[4].padStart(2, '0')}:${m[5]}:${m[6]}` : null; };

const old = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { days: {}, items: [] };
const done = new Set(Object.keys(old.days));
const today = new Date(Date.now() + 19800e3).toISOString().slice(0, 10);
const items = old.items;
let failed = 0;
for (let d = new Date(FROM + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= TO; d.setUTCDate(d.getUTCDate() + 1)) {
  const iso = d.toISOString().slice(0, 10);
  if (done.has(iso) && iso < today) continue;
  const nse = iso.split('-').reverse().join('-');
  const list = await nseJson(`corporate-announcements?index=equities&from_date=${nse}&to_date=${nse}`, iso < today ? 1e7 : 0.25, { timeoutMs: 90000, attempts: 3 }).catch(() => null);
  if (!Array.isArray(list)) { failed++; console.warn(`  ${iso} failed`); if (failed > 20) break; continue; }
  for (let k = items.length - 1; k >= 0; k--) if (items[k].time.startsWith(iso)) items.splice(k, 1);
  for (const x of list) {
    const time = parseTime(x.an_dt);
    if (!time || !x.symbol) continue;
    const text = (x.attchmntText ?? '').slice(0, 400);
    items.push({ symbol: x.symbol, time, desc: x.desc ?? '', text, cat: categorise(x.desc ?? '', text) });
  }
  old.days[iso] = list.length;
  if (d.getUTCDate() === 1) { console.log(`  ${iso}: ${items.length} announcements so far`); fs.writeFileSync(OUT, JSON.stringify(old)); }
}
fs.writeFileSync(OUT, JSON.stringify(old));
console.log(`Saved ${items.length} announcements over ${Object.keys(old.days).length} days (${failed} failed days).`);
