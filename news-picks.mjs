// News picks (WATCH ONLY, paper test). Research: research/16-grade-test.mjs (Oct 21 - Nov 16 2026).
// Stocks with STRONG GOOD overnight news, bought at 9:30 only if still above the open AND yesterday's close,
// sold on a 2% drop from the best price (or +3%), made +0.2 to +0.6% per trade after costs in both halves of the month.
//
//   node news-picks.mjs morning   (about 8:00-8:45 am) collect overnight NSE filings + media headlines, Claude grades them,
//                                 phone gets the watchlist. Also scores yesterday's buys first.
//   node news-picks.mjs preopen   (9:04-9:08 am) "first push": strong-news stocks whose pre-open price is +5..+15% -> BUY AT OPEN
//                                 (research/18-open-pull.mjs: 4/4 won, +2.8% avg selling on a 1.5% drop from the best; same idea as
//                                 Gap & Go, which held over 2 years for results). Sell on a 1.5% drop from the best price.
//   node news-picks.mjs confirm   (9:31 am) second chance: the 9:30 rule on the rest of the watchlist, BUY list (max 3).
// Env: ANTHROPIC_API_KEY (grading; without it a rough keyword grade is used), NTFY_TOPIC, SUPABASE_URL, SUPABASE_SERVICE_KEY.
// NEWS_DATE=YYYY-MM-DD runs the morning step for a past day (no phone, no database) to check it.
import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { fetchCached, announcements, holidays, preOpen } from './src/sources.mjs';
import { typeOf } from './research/news-types.mjs';
import { publishNews } from './src/app-publish.mjs';

const MODE = process.argv[2] ?? 'morning';
const RULE = { minCr: 5, maxBuys: 3, trail: 0.02, target: 0.03, stop: 0.02, maxGap: 0.05, openGapMin: 0.05, openGapMax: 0.15, openTrail: 0.015, limitAbove: 0.005 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SIM = process.env.NEWS_DATE;
const ist = () => new Date(Date.now() + 19800e3);
const isoOf = (d) => d.toISOString().slice(0, 10);
const today = SIM ?? isoOf(ist());
const pct = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; };

// ---- phone + database (Supabase row 4 keeps today's list and the history) ----
const topic = SIM ? null : process.env.NTFY_TOPIC;
const notify = async (title, body, priority = 'default', tags = 'newspaper') => {
  console.log(`\n[${title}]\n${body}`);
  if (topic) await fetch(`https://ntfy.sh/${topic}`, { method: 'POST', body, headers: { Title: title, Priority: priority, Tags: tags } }).catch(() => {});
};
const sb = !SIM && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY ? { url: `${process.env.SUPABASE_URL}/rest/v1/radar`, key: process.env.SUPABASE_SERVICE_KEY } : null;
const LOCAL = new URL('./data/news-picks.json', import.meta.url);
async function load() {
  if (sb) return (await (await fetch(`${sb.url}?id=eq.4&select=payload`, { headers: { apikey: sb.key } })).json())?.[0]?.payload ?? {};
  return fs.existsSync(LOCAL) ? JSON.parse(fs.readFileSync(LOCAL, 'utf8')) : {};
}
async function save(state) {
  if (SIM) return;
  if (!sb) { fs.mkdirSync(new URL('./data/', import.meta.url), { recursive: true }); fs.writeFileSync(LOCAL, JSON.stringify(state, null, 1)); return; }
  const res = await fetch(sb.url, { method: 'POST', headers: { apikey: sb.key, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ id: 4, payload: state, updated_at: new Date().toISOString() }) });
  if (!res.ok) throw new Error(`Supabase save failed: ${res.status} ${await res.text()}`);
  // the app's News tab: today's lists + the last 30 days of results
  const t = state.today ?? {};
  await publishNews('picks', { date: t.date, mode: t.mode, watch: (t.watch ?? []).map(({ symbol, why }) => ({ symbol, why })), bad: t.bad ?? [], openBuys: t.openBuys ?? [], buys: t.buys ?? [], preopenDone: !!t.preopenDone, confirmed: !!t.confirmed, history: (state.history ?? []).slice(-30) });
}

// ---- trading calendar ----
const hol = await holidays().catch(() => new Set());
const isTradingDay = (iso) => { const d = new Date(iso + 'T00:00:00Z').getUTCDay(); return d !== 0 && d !== 6 && !hol.has(iso); };
const prevTradingDay = (iso) => { let d = new Date(iso + 'T00:00:00Z'); do d = new Date(+d - 864e5); while (!isTradingDay(isoOf(d))); return isoOf(d); };
if (!isTradingDay(today)) { console.log(`${today} is not a trading day.`); process.exit(0); }

// ---- 5-minute bars from Yahoo for one stock-day ----
async function bars5(symbol, iso) {
  const p1 = Math.floor(Date.parse(iso + 'T03:30:00Z') / 1000), p2 = p1 + 6.5 * 3600;
  const body = await fetchCached(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol + '.NS')}?period1=${p1}&period2=${p2}&interval=5m`, { ttlHours: 0.02, attempts: 3 }).catch(() => null);
  const r = body ? JSON.parse(body).chart?.result?.[0] : null;
  if (!r?.timestamp) return null;
  const q = r.indicators.quote[0];
  const out = r.timestamp.map((t, i) => { const d = new Date((t + 19800) * 1000); return { hhmm: d.getUTCHours() * 100 + d.getUTCMinutes(), o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] }; }).filter((b) => b.o != null && b.c != null);
  return { bars: out, prevClose: r.meta?.chartPreviousClose ?? r.meta?.previousClose };
}
// Walk the bars after the buy: stop, trailing stop from the best price, optional target, else 3:20 pm.
function walk(bars, fromHhmm, px, trail = RULE.trail, target = RULE.target) {
  let peak = px;
  for (const b of bars.filter((x) => x.hhmm >= fromHhmm && x.hhmm <= 1515)) {
    const stop = Math.max(px * (1 - RULE.stop), peak * (1 - trail));
    if (b.l <= stop) return { ret: Math.min(b.o, stop) / px - 1, how: stop > px * (1 - RULE.stop) ? `sellers came (${trail * 100}% off the high)` : 'stop' };
    if (target && b.h >= px * (1 + target)) return { ret: target, how: `target +${target * 100}%` };
    peak = Math.max(peak, b.h);
  }
  const last = bars.filter((x) => x.hhmm <= 1515).at(-1);
  return last ? { ret: last.c / px - 1, how: '3:20 pm' } : null;
}

const state = await load(); // in NEWS_DATE mode there is no database, so this reads the local test file and never saves
state.history ??= [];

if (MODE === 'preopen') {
  // ---------------- 9:04-9:08 am: the first push. Strong news + buyers rushing in at the auction ----------------
  if (state.today?.date !== today) { console.log('No watchlist for today (morning step did not run).'); process.exit(0); }
  if (state.today.preopenDone) { console.log('Pre-open step already done today.'); process.exit(0); }
  const mins = () => { const n = ist(); return n.getUTCHours() * 60 + n.getUTCMinutes(); };
  if (!SIM && mins() > 9 * 60 + 12) { console.log('Too late for pre-open today.'); process.exit(0); }
  while (!SIM && mins() < 9 * 60 + 4) await sleep(15000);
  const nseDay = (() => { const [y, m, d] = today.split('-'); return `${d}-${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m - 1]}-${y}`; })();
  let pre = new Map();
  for (let tries = 0; tries < 10; tries++) {
    pre = await preOpen(0).catch(() => new Map());
    const fresh = [...pre.values()].some((p) => p.time.startsWith(nseDay));
    if (fresh && mins() >= 9 * 60 + 6) break; // later in the auction = closer to the real opening price
    if (mins() >= 9 * 60 + 8) break;
    await sleep(15000);
  }
  const opens = state.today.watch.map((p) => { const q = pre.get(p.symbol); return q?.iep && q.prevClose ? { ...p, iep: q.iep, prevClose: q.prevClose, gap: q.iep / q.prevClose - 1 } : null; })
    .filter((p) => p && p.gap >= RULE.openGapMin && p.gap <= RULE.openGapMax).sort((a, b) => b.cr - a.cr).slice(0, RULE.maxBuys);
  const round = (x) => Math.round(x * 20) / 20;
  state.today.preopenDone = true;
  state.today.openBuys = opens.map(({ symbol, why, iep, gap }) => ({ symbol, why, iep, gap, limit: round(iep * (1 + RULE.limitAbove)) }));
  await save(state);
  if (opens.length) await notify(`News picks: BUY AT OPEN ${opens.map((p) => p.symbol).join(', ')} (paper test)`,
    opens.map((p) => `${p.symbol}: pre-open Rs ${p.iep} (${pct(p.gap)}) -> limit buy Rs ${round(p.iep * (1 + RULE.limitAbove))}. ${p.why}`).join('\n') +
    `\n\nPlace the limit buy NOW (before 9:08). SELL as soon as it falls 1.5% from its best price after you buy. If it opens above your limit, you are not filled: do not chase.`, 'urgent', 'rocket');
  else console.log('No strong-news stock is +5..+15% in pre-open today.');
  process.exit(0);
}

if (MODE === 'confirm') {
  // ---------------- 9:31 am: which watchlist stocks are still holding up? ----------------
  if (state.today?.date !== today) { console.log('No watchlist for today (morning step did not run).'); process.exit(0); }
  if (state.today.confirmed) { console.log('Already confirmed today.'); process.exit(0); }
  const now = ist(); const hhmm = now.getUTCHours() * 100 + now.getUTCMinutes();
  if (!SIM && hhmm < 930) { console.log('Too early: the 9:30 check needs the 9:25-9:30 bar.'); process.exit(0); }
  const checked = [];
  const boughtAtOpen = new Set((state.today.openBuys ?? []).map((b) => b.symbol));
  for (const p of state.today.watch.filter((x) => !boughtAtOpen.has(x.symbol))) {
    const d = await bars5(p.symbol, today);
    const open = d?.bars.find((b) => b.hhmm === 915)?.o, at930 = d?.bars.find((b) => b.hhmm === 925)?.c;
    if (!open || !at930 || !d.prevClose) { checked.push({ ...p, ok: false, note: 'no price data' }); continue; }
    const gap = open / d.prevClose - 1;
    const ok = at930 > open && at930 > d.prevClose && gap < RULE.maxGap;
    checked.push({ ...p, open, at930, prevClose: d.prevClose, gap, ok, note: ok ? '' : at930 <= open ? 'below its open' : at930 <= d.prevClose ? 'below yesterday' : 'opened too high' });
  }
  // the ones that opened least up first (news not priced in yet), then the most traded
  const buys = checked.filter((p) => p.ok).sort((a, b) => a.gap - b.gap || b.cr - a.cr).slice(0, RULE.maxBuys);
  state.today.confirmed = true;
  state.today.buys = buys.map(({ symbol, why, at930, gap, open, prevClose }) => ({ symbol, why, buy: at930, gap, open, prevClose }));
  await save(state);
  const skipped = checked.filter((p) => !p.ok).map((p) => `${p.symbol} (${p.note})`).join(', ');
  if (!buys.length) await notify('News picks: no buy today', `None of today's strong-news stocks held above its open and yesterday's close at 9:30.${skipped ? `\nSkipped: ${skipped}` : ''}`, 'low', 'zzz');
  else await notify(`News picks: BUY ${buys.map((b) => b.symbol).join(', ')} (paper test)`,
    buys.map((b) => `${b.symbol} ~Rs ${b.at930.toFixed(2)} (opened ${pct(b.gap)}): ${b.why}`).join('\n') +
    `\n\nSELL when it falls 2% from its highest price after you buy, or at +3%. Never hold past 3:20 pm.${skipped ? `\nSkipped: ${skipped}` : ''}`, 'high', 'moneybag');
  process.exit(0);
}

// ---------------- morning ----------------
if (!SIM && state.today?.date === today) { console.log('Morning list already sent today.'); process.exit(0); }
// 1. score yesterday's buys (what the rule would have made)
const last = state.today;
if (last && last.date < today && (last.buys?.length || last.openBuys?.length) && !last.scored) {
  const lines = [];
  // open buys: filled at the real opening price only if it opened at or below the limit
  for (const b of last.openBuys ?? []) {
    const d = await bars5(b.symbol, last.date);
    const open = d?.bars.find((x) => x.hhmm === 915)?.o;
    if (!open) continue;
    if (open > b.limit) { lines.push(`${b.symbol} (open buy): opened Rs ${open} above limit Rs ${b.limit} -> not filled`); continue; }
    const r = walk(d.bars, 915, open, RULE.openTrail, 0);
    if (!r) continue;
    b.result = r.ret - 0.004; b.how = r.how;
    lines.push(`${b.symbol} (open buy): ${r.how} -> ${pct(b.result)}`);
  }
  for (const b of last.buys ?? []) {
    const d = await bars5(b.symbol, last.date);
    const r = d && walk(d.bars, 930, b.buy);
    if (!r) continue;
    b.result = r.ret - 0.004; b.how = r.how; // after ~0.4% costs
    lines.push(`${b.symbol}: ${r.how} -> ${pct(b.result)}`);
  }
  last.scored = true;
  const done = [...(last.openBuys ?? []), ...(last.buys ?? [])].filter((b) => b.result != null);
  state.history.push({ date: last.date, buys: done.map(({ symbol, result, how }) => ({ symbol, result, how })) });
  const all = state.history.flatMap((h) => h.buys);
  if (lines.length) await notify(`News picks: ${last.date} scorecard`, `${lines.join('\n')}\nSo far: ${all.length} buys, avg ${pct(all.reduce((s, x) => s + x.result, 0) / all.length)} after costs, ${all.filter((x) => x.result > 0).length} won.`, 'low', 'clipboard');
}

// 2. liquid stocks and their names (NSE daily files of the last 10 sessions)
async function bhav(iso) {
  const [y, m, d] = iso.split('-');
  const csv = await fetchCached(`https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${d}${m}${y}.csv`, { ttlHours: 1e7, attempts: 2 }).catch(() => null);
  if (!csv?.startsWith('SYMBOL')) return null;
  const lines = csv.trim().split(/\r?\n/), head = lines[0].split(',').map((x) => x.trim()), c = (n) => head.indexOf(n);
  const map = new Map();
  for (const line of lines.slice(1)) { const p = line.split(',').map((x) => x.trim()); if (p[c('SERIES')] === 'EQ' || p[c('SERIES')] === 'BE') map.set(p[c('SYMBOL')], +p[c('TURNOVER_LACS')] / 100); }
  return map;
}
const turnover = new Map();
for (let iso = prevTradingDay(today), n = 0; n < 10; iso = prevTradingDay(iso), n++) {
  const m = await bhav(iso);
  if (m) for (const [s, cr] of m) (turnover.get(s) ?? turnover.set(s, []).get(s)).push(cr);
}
const liquid = new Map([...turnover].map(([s, a]) => [s, median(a)]).filter(([, cr]) => cr >= RULE.minCr));
const eq = await fetchCached('https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv', { ttlHours: 24 * 7 });
const names = new Map(eq.trim().split(/\r?\n/).slice(1).map((l) => { const p = l.split(','); return [p[0].trim(), p[1].replace(/"/g, '').trim()]; }));
console.log(`${liquid.size} stocks trade Rs ${RULE.minCr} cr+/day.`);

// 3. overnight news: NSE filings since yesterday 3:30 pm + media headlines (Bing News, last 24 h)
const yday = prevTradingDay(today);
const fromStamp = `${yday} 15:30`, toStamp = `${today} 09:15`;
const news = new Map(); // symbol -> [text]
const add = (sym, text) => { if (!liquid.has(sym)) return; const a = news.get(sym) ?? news.set(sym, []).get(sym); if (!a.some((x) => x.slice(0, 50) === text.slice(0, 50))) a.push(text.slice(0, 160)); };
const MON = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
for (const x of await announcements(yday, today, 0.1).catch(() => [])) {
  const m = /(\d+)-(\w{3})-(\d{4}) (\d+):(\d+)/.exec(x.an_dt ?? ''); if (!m) continue;
  const stamp = `${m[3]}-${MON[m[2]]}-${m[1].padStart(2, '0')} ${m[4].padStart(2, '0')}:${m[5]}`;
  if (stamp < fromStamp || stamp > toStamp) continue;
  const t = typeOf(x.desc ?? '', x.attchmntText ?? '');
  if (['routine', 'meeting', 'management', 'board-meet'].includes(t)) continue;
  add(x.symbol, 'NSE: ' + (x.attchmntText || x.desc || '').replace(/^.*?has (informed|submitted)( to)? the Exchange,? (about|regarding|that)? ?/i, '').replace(/\s+/g, ' '));
}
const clean = (n) => n.replace(/\b(limited|ltd\.?|\(india\)|india limited|corporation|company|co\.)\b/gi, ' ').replace(/[&.,()']/g, ' ').replace(/\s+/g, ' ').trim();
const decode = (s) => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'");
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const NOISE = /share price|stock price|price live|price today|rated (sell|hold|buy)|open interest|stocks? to (watch|buy)|in focus|technical|chart|52-week|hits? (high|low)|\b(up|down|jumps?|surges?|falls?|slips?|rises?|declines?|soars?) \d+(\.\d+)?%/i;
let bingOk = 0;
const syms = [...liquid.keys()].filter((s) => names.has(s));
for (const sym of syms) {
  const q = encodeURIComponent(`"${clean(names.get(sym))}" share`);
  // qft interval 7 = past 24 hours. Bing's pubDate says GMT but is US Pacific: IST = +13.5 h (checked against NSE filing times).
  const xml = await fetchCached(`https://www.bing.com/news/search?q=${q}&format=rss&count=50&qft=interval%3d%227%22`, { ttlHours: 0.5, headers: { 'User-Agent': UA }, attempts: 2 }).catch(() => null);
  if (!xml) continue;
  bingOk++;
  const core = clean(names.get(sym)).toLowerCase().split(' ').filter((w) => w.length > 2).slice(0, 2);
  for (const it of xml.split('<item>').slice(1)) {
    const title = decode(/<title>([\s\S]*?)<\/title>/.exec(it)?.[1] ?? '');
    const m = /(\d+) (\w{3}) (\d{4}) (\d+):(\d+)/.exec(/<pubDate>([^<]*)<\/pubDate>/.exec(it)?.[1] ?? ''); if (!m) continue;
    const istTime = new Date(Date.UTC(+m[3], +MON[m[2]] - 1, +m[1], +m[4], +m[5]) + 13.5 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
    if (istTime < fromStamp || istTime > toStamp || NOISE.test(title) || !core.every((w) => title.toLowerCase().includes(w))) continue;
    add(sym, title);
  }
}
console.log(`Bing answered for ${bingOk}/${syms.length} stocks. ${news.size} stocks have overnight news.`);

// 4. grade the news (Claude reads it like a trader; same scale as the research)
const GradeSchema = z.object({ grades: z.array(z.object({ symbol: z.string(), grade: z.number().int().min(-1).max(2), why: z.string() })) });
const PROMPT = `You grade overnight news for Indian listed companies, before the market opens, for a short-term trader.
For each line (SYMBOL | headlines) give one grade:
 2 = strongly good and new for THIS company: a clear beat (profit up strongly vs last quarter and last year, record quarter, swing to profit), a large order or contract for the company's size, a major deal/stake purchase by a big investor, bonus/buyback/split, a key regulatory approval (e.g. USFDA), raised guidance, a big brokerage upgrade.
 1 = mildly good: modest growth, small orders, routine positive updates, brokerage "buy" with normal upside.
 0 = neutral, unclear, routine, only a results date or call schedule, a story only about the share price moving, or not about this Indian company (same-name foreign firms, sports, people).
 -1 = bad: profit fall or loss, miss, downgrade, promoter or big fund selling, penalty, raid, fraud, fire, resignation of top people, order cancelled.
Keep "why" under 12 words. Return every symbol given.`;
let graded = [];
const lines = [...news].map(([s, a]) => `${s} | ${a.slice(0, 4).join(' ;; ')}`);
if (process.env.ANTHROPIC_API_KEY && lines.length) {
  const client = new Anthropic();
  for (let i = 0; i < lines.length; i += 120) {
    const chunk = lines.slice(i, i + 120);
    // Claude Haiku 5.5: headline grading is a simple classification job, and it keeps the cost near Rs 15 a month.
    const res = await client.messages.parse({
      model: 'claude-haiku-5-5',
      max_tokens: 16000,
      output_config: { effort: 'medium', format: zodOutputFormat(GradeSchema) },
      system: PROMPT,
      messages: [{ role: 'user', content: chunk.join('\n') }],
    });
    if (res.stop_reason === 'refusal' || !res.parsed_output) { console.warn(`Grading chunk ${i} failed (${res.stop_reason}); using keyword grades for it.`); graded.push(...chunk.map(keywordGrade)); continue; }
    graded.push(...res.parsed_output.grades);
  }
} else {
  console.warn('No ANTHROPIC_API_KEY: using rough keyword grades (weaker than reading the news).');
  graded = lines.map(keywordGrade);
}
function keywordGrade(line) {
  const [symbol, text] = line.split(' | ');
  const good = /profit (jumps|surges|doubles|triples|soars)|record|swings? to profit|bags?|wins?|secures?|L1|buyback|bonus|usfda|approval|raises guidance|upgrade/i.test(text);
  const bad = /falls?|drops?|plunges?|loss|downgrade|penalty|raid|fraud|resign|sells? stake|cancel/i.test(text);
  return { symbol, grade: bad ? -1 : good ? 2 : 0, why: '(keyword grade)' };
}

// 5. watchlist: strong good news only
const bySym = new Map(graded.map((g) => [g.symbol, g]));
const watch = [...news].map(([symbol, a]) => ({ symbol, cr: liquid.get(symbol), grade: bySym.get(symbol)?.grade ?? 0, why: bySym.get(symbol)?.why ?? '', headline: a[0] }))
  .filter((p) => p.grade === 2).sort((a, b) => b.cr - a.cr);
const bad = [...news].map(([symbol]) => bySym.get(symbol)).filter((g) => g?.grade === -1).map((g) => g.symbol);
state.today = { date: today, watch, bad, graded: graded.length, mode: process.env.ANTHROPIC_API_KEY ? 'claude' : 'keyword' };
await save(state);
await notify(`News picks ${today}: ${watch.length} strong-news stocks to watch`,
  (watch.length ? watch.slice(0, 15).map((p) => `${p.symbol}: ${p.why}`).join('\n') : 'No strong good news overnight.') +
  `\n\nDo NOT buy at 9:15. At 9:31 you get the BUY list: only those still above their open AND yesterday's close.` +
  (bad.length ? `\nBad news (avoid): ${bad.slice(0, 12).join(', ')}` : '') + (state.today.mode === 'keyword' ? '\n(keyword grading - add ANTHROPIC_API_KEY for real reading)' : ''), 'default', 'newspaper');
