// Step 2: every NSE company announcement, day by day, with its exact filing time and a category.
// The NSE website must answer (it blocks some networks for a while; GitHub Actions usually works).
// Output: data/research/events.json = [{ symbol, time: 'YYYY-MM-DD HH:MM', desc, text, cat }]
import fs from 'node:fs';
import { announcements } from '../src/sources.mjs';

const FROM = process.argv[2] ?? '2024-01-01';
const TO = process.argv[3] ?? new Date(Date.now() + 19800e3).toISOString().slice(0, 10);
const OUT = new URL('../data/research/events.json', import.meta.url);
fs.mkdirSync(new URL('../data/research/', import.meta.url), { recursive: true });

// Rough categories from the subject and the one-line summary. Order matters: first match wins.
export const CATEGORIES = [
  ['result', /financial result|integrated filing- financial|outcome of board meeting.*result|results? for the (quarter|period)/i],
  ['order', /order|contract|award|letter of (award|intent)|\bLoA\b|\bLoI\b|bagged|secured|empanel/i],
  ['approval', /usfda|us fda|\bEIR\b|approval from|anda|drug|patent|license|licence/i],
  ['buyback', /buy ?back/i],
  ['bonus-split', /bonus|split|sub-division/i],
  ['dividend', /dividend/i],
  ['acquisition', /acqui|merger|amalgamation|takeover|stake|joint venture|\bJV\b|strategic/i],
  ['fundraise', /qip|preferential|rights issue|fund rais|warrants|ncd|debenture|allotment/i],
  ['rating', /credit rating|rating/i],
  ['management', /resign|appoint|cessation|director|ceo|cfo|managing/i],
  ['legal', /penalty|litigation|search|raid|show cause|sebi order|income tax|gst|fraud|default|insolvency/i],
  ['meeting', /analyst|investor meet|earnings call|conference call|press release|presentation/i],
];
export const categorise = (desc, text) => {
  const s = `${desc} ${text}`;
  for (const [c, re] of CATEGORIES) if (re.test(s)) return c;
  return 'other';
};

const MON = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
const parseTime = (s) => { const m = /(\d+)-(\w{3})-(\d{4}) (\d+):(\d+)/.exec(s ?? ''); return m ? `${m[3]}-${MON[m[2]]}-${m[1].padStart(2, '0')} ${m[4].padStart(2, '0')}:${m[5]}` : null; };

const all = [];
for (let d = new Date(FROM + 'T00:00:00Z'); d <= new Date(TO + 'T00:00:00Z'); d = new Date(+d + 864e5)) {
  const iso = d.toISOString().slice(0, 10);
  const list = (await announcements(iso, iso, 1e7).catch(() => null)) ?? []; // cached forever: the past does not change
  for (const a of list) {
    const time = parseTime(a.an_dt);
    if (!time || !a.symbol) continue;
    const text = (a.attchmntText ?? '').slice(0, 300);
    all.push({ symbol: a.symbol, time, desc: a.desc ?? '', text, cat: categorise(a.desc ?? '', text) });
  }
  if (d.getUTCDate() === 1) console.log(`  ${iso}: ${all.length} announcements so far`);
}
fs.writeFileSync(OUT, JSON.stringify(all));
const counts = {};
for (const e of all) counts[e.cat] = (counts[e.cat] ?? 0) + 1;
console.log(`Saved ${all.length} announcements.`, counts);
