// Step 14: media headlines (Moneycontrol, ET, Business Standard, Mint...) for every liquid stock, last ~30 days, via Bing News RSS.
// Google News blocks this PC; Bing works. Bing's pubDate says "GMT" but is really US Pacific time
// (checked: Godrej-Temasek article 23:13 "GMT" = 12:43 IST, NSE filing 12:44 IST), so IST = pubDate + 13.5 h (PST, Nov).
//   node research/14-media-download.mjs [minCrPerDay=3] [pages=1,11,21]   (each Bing page adds ~14 different headlines; reruns merge)
// Output: data/research/media.json = { fetched, items: [{ symbol, ist: 'YYYY-MM-DD HH:MM', title, source }] }
import fs from 'node:fs';
import { fetchCached } from '../src/sources.mjs';

const MIN_CR = Number(process.argv[2] ?? 3);
const PAGES = (process.argv[3] ?? '1').split(',').map(Number);
const DIR = new URL('../data/research/', import.meta.url);
const OUT = new URL('media.json', DIR);
const { days, stocks } = JSON.parse(fs.readFileSync(new URL('market.json', DIR), 'utf8'));
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// company names from the NSE equity list
const csv = await fetchCached('https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv', { ttlHours: 24 * 7 });
const names = new Map();
for (const line of csv.trim().split(/\r?\n/).slice(1)) { const p = line.split(','); names.set(p[0].trim(), p[1].replace(/"/g, '').trim()); }
const clean = (n) => n.replace(/\b(limited|ltd\.?|\(india\)|india limited|corporation|company|co\.)\b/gi, ' ').replace(/[&.,()']/g, ' ').replace(/\s+/g, ' ').trim();

const last = days.length - 1;
const universe = Object.entries(stocks).filter(([sym, rows]) => {
  if (!names.has(sym)) return false;
  const recent = rows.filter((r) => r[0] > last - 20).map((r) => r[6]);
  return recent.length >= 10 && median(recent) >= MIN_CR;
}).map(([sym]) => sym);
console.log(`${universe.length} stocks trading Rs ${MIN_CR} cr+/day. Fetching Bing News (past month)...`);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const toIst = (s) => { // "Thu, 12 Nov 2026 00:13:00 GMT" (really Pacific) -> IST
  const m = /(\d+) (\w{3}) (\d{4}) (\d+):(\d+)/.exec(s ?? ''); if (!m) return null;
  const t = Date.UTC(+m[3], MON[m[2]], +m[1], +m[4], +m[5]) + 13.5 * 3600e3;
  return new Date(t).toISOString().slice(0, 16).replace('T', ' ');
};
const decode = (s) => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const old = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')).items : [];
const items = old;
const seen = new Set(old.map((x) => x.symbol + '|' + x.title));
let ok = 0, failed = 0;
for (const [k, sym] of universe.entries()) {
  const q = encodeURIComponent(`"${clean(names.get(sym))}" share`);
  for (const page of PAGES) {
  const url = `https://www.bing.com/news/search?q=${q}&format=rss&count=100&qft=interval%3d%229%22&first=${page}`;
  let xml = null;
  try { xml = await fetchCached(url, { ttlHours: 24 * 3, headers: { 'User-Agent': UA }, attempts: 3 }); } catch { failed++; }
  if (xml) {
    ok++;
    const core = clean(names.get(sym)).toLowerCase().split(' ').filter((w) => w.length > 2).slice(0, 2);
    for (const it of xml.split('<item>').slice(1)) {
      const title = decode(/<title>([\s\S]*?)<\/title>/.exec(it)?.[1] ?? '');
      const ist = toIst(/<pubDate>([^<]*)<\/pubDate>/.exec(it)?.[1]);
      const source = decode(/<News:Source>([^<]*)<\/News:Source>/i.exec(it)?.[1] ?? '');
      // keep only headlines that name the company (Bing adds loose matches)
      if (!ist || !core.every((w) => title.toLowerCase().includes(w)) || seen.has(sym + '|' + title)) continue;
      seen.add(sym + '|' + title);
      items.push({ symbol: sym, ist, title, source });
    }
  }
  }
  if ((k + 1) % 50 === 0) { console.log(`  ${k + 1}/${universe.length}, ${items.length} headlines, ${failed} failed`); fs.writeFileSync(OUT, JSON.stringify({ fetched: new Date().toISOString(), items })); }
  if (failed > 30 && ok < 10) { console.error('Bing is refusing requests. Stopping.'); break; }
}
fs.writeFileSync(OUT, JSON.stringify({ fetched: new Date().toISOString(), items }));
console.log(`Saved ${items.length} headlines for ${ok} stocks (${failed} failed).`);
