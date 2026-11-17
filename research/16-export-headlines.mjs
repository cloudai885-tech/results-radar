// Step 16a: export every liquid stock-day's overnight news (prev 15:30 -> 9:15) WITHOUT any price data,
// so the news can be graded blind (good / bad / strength). Only lines with material news are kept.
//   node research/16-export-headlines.mjs <outFile.txt>   -> outFile.txt (id|symbol|headlines) + outFile-map.txt (id|date|symbol)
import fs from 'node:fs';
import { typeOf } from './news-types.mjs';
const DIR = new URL('../data/research/', import.meta.url);
const read = (f) => JSON.parse(fs.readFileSync(new URL(f, DIR), 'utf8'));
const { days, stocks } = read('market.json');
const media = read('media.json').items, nse = read('news.json').items;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const firstMedia = media.map((m) => m.ist.slice(0, 10)).sort()[Math.floor(media.length * 0.01)];
const dayIdx = new Map(days.map((d, i) => [d, i]));
const slot = (d, hm) => { if (dayIdx.has(d) && hm < '09:15') return dayIdx.get(d); if (dayIdx.has(d) && hm <= '15:30') return -1; return days.findIndex((x) => x > d); };
const by = new Map();
const add = (sym, d, hm, text) => { const i = slot(d, hm); if (i < 0 || days[i] <= firstMedia) return; const k = `${days[i]}|${sym}`; const a = by.get(k) ?? by.set(k, []).get(k); if (!a.some((x) => x.slice(0, 50) === text.slice(0, 50))) a.push(text); };
for (const m of media) add(m.symbol, m.ist.slice(0, 10), m.ist.slice(11, 16), m.title);
for (const n of nse) { const t = typeOf(n.desc, n.text); if (['routine', 'meeting', 'management', 'board-meet'].includes(t)) continue; add(n.symbol, n.time.slice(0, 10), n.time.slice(11, 16), 'NSE: ' + (n.text || n.desc).replace(/^.*?has (informed|submitted)( to)? the Exchange,? (about|regarding|that)? ?/i, '').replace(/\s+/g, ' ').slice(0, 160)); }
// liquid only (Rs 3 cr+/day median of the 20 days before)
const liqOk = (sym, d) => { const rows = stocks[sym]; if (!rows) return false; const i = dayIdx.get(d); const a = rows.filter((r) => r[0] < i && r[0] >= i - 20).map((r) => r[6]); return a.length >= 10 && median(a) >= 3; };
// drop price-reporting / generic headlines; keep only ones that carry a reason
const NOISE = /share price|stock price|price live|price today|rated (sell|hold|buy)|open interest|stocks? to (watch|buy)|in focus|\bgains? \d|\b(up|down|jumps?|surges?|falls?|slips?|rises?|declines?|soars?|rall(y|ies)) \d+(\.\d+)?%|technical|chart|check (details|share)|52-week|hits? (high|low)|what.s driving|stock (rises|falls|gains)/i;
const CAUSE = /result|profit|revenue|earnings|ebitda|\bq[1-4]\b|quarter|order|contract|\bbags?\b|\bwins?\b|secures?|award|\bL1\b|approv|usfda|\bnod\b|acqui|stake|merger|invest|fund|raise|deal|partner|tie-up|\bmou\b|buyback|bonus|split|dividend|demerger|listing|upgrade|target|brokerage|\bbuy\b|guidance|launch|plant|capacity|expan|commission|capex|govt|government|policy|tariff|\bban\b|penalty|raid|probe|resign|fraud|default|downgrade|\bloss/i;
const lines = [], map = [];
for (const [k, hs] of [...by].sort()) {
  const [d, sym] = k.split('|');
  if (d > days.at(-1) || !liqOk(sym, d)) continue;
  const good = hs.filter((h) => !NOISE.test(h) && CAUSE.test(h)).map((h) => h.slice(0, 140));
  if (!good.length) continue;
  map.push(`${lines.length}|${d}|${sym}`);
  lines.push(`${lines.length}|${sym}|${good.slice(0, 2).join(' ;; ').replace(/\|/g, '/')}`);
}
fs.writeFileSync(process.argv[2], lines.join('\n'));
fs.writeFileSync(process.argv[2].replace(/\.txt$/, '-map.txt'), map.join('\n'));
console.log(`${lines.length} stock-days with material overnight news written to ${process.argv[2]}`);
