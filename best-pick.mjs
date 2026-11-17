// TODAY'S BUY: one message at about 9:04-9:05 am with the best 1-3 stocks of the day, from every tested strategy.
// The user wants one clear answer, not many lists. Ranked by how well each strategy held up in testing:
//   1. Panic rebound, HIGH level: whole market opens -1.2% or worse, a big stock (Rs 20 cr+/day) opens -3..-5%,
//      no bad news overnight. 10 of 10 such days won (Jan 2025 - Nov 2026, small sample). Hold to 3:20 pm, stop -3%.
//   2. Gap & Go: results beat last quarter AND last year, opens +5..+20%. 98 trades over 2 years, +1.2% a trade.
//      Sell at +7% or -3%, else 3:20 pm.
//   3. Strong news (Claude-graded, morning list) and opens +5..+15%. One month: +1.2% a trade, 8 of 15 won.
//      Sell when it falls 1.5% from its best (the live radar sends SELL NOW).
// Only the top level of the day is sent: if one strategy is clearly stronger, only its stocks go out (often just 1).
// Nothing strong -> "NO BUY TODAY". The month's tests showed forced trades on other days lose about 0.4% each.
//
//   node best-pick.mjs           starts any time before 9:04, waits for pre-open prices, sends the message.
// Also scores yesterday's picks first (5-minute candles) and keeps the record for the app (row 1, news.best).
import { fetchCached, preOpen, announcements, holidays } from './src/sources.mjs';
import { categorise } from './research/categories.mjs';
import { publishNews } from './src/app-publish.mjs';

const RULE = { cost: 0.004, limitAbove: 0.005, marketPanic: -0.012, panicMinCr: 20, panicGap: [-0.05, -0.03], gapGo: [0.05, 0.2], newsGap: [0.05, 0.15], maxPicks: 3 };
const BAD_NEWS = new Set(['result', 'legal', 'rating', 'fundraise']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ist = () => new Date(Date.now() + 19800e3);
const isoOf = (d) => d.toISOString().slice(0, 10);
const secs = () => { const n = ist(); return n.getUTCHours() * 3600 + n.getUTCMinutes() * 60 + n.getUTCSeconds(); };
const today = isoOf(ist());
const pct = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
const round = (v) => Math.round(v * 20) / 20;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; };
const log = (...a) => console.log(ist().toISOString().slice(11, 19), ...a);

const DRY = process.env.BEST_DRY === '1'; // test: use whatever pre-open data NSE shows, send nothing, save nothing
const topic = DRY ? null : process.env.NTFY_TOPIC;
const notify = async (title, body, priority, tags) => {
  log(`[${title}]\n${body}`);
  if (topic) await fetch(`https://ntfy.sh/${topic}`, { method: 'POST', body, headers: { Title: title, Priority: priority, Tags: tags } }).catch(() => {});
};
const SB = !DRY && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY ? { url: `${process.env.SUPABASE_URL}/rest/v1/radar`, key: process.env.SUPABASE_SERVICE_KEY } : null;
const appRow = async () => (SB ? (await (await fetch(`${SB.url}?id=eq.1&select=payload`, { headers: { apikey: SB.key } })).json())?.[0]?.payload ?? {} : {});

const hol = await holidays().catch(() => new Set());
const isTradingDay = (iso) => { const d = new Date(iso + 'T00:00:00Z').getUTCDay(); return d !== 0 && d !== 6 && !hol.has(iso); };
if (!isTradingDay(today)) { console.log(`${today} is not a trading day.`); process.exit(0); }
const prevDay = (iso) => { let d = new Date(iso + 'T00:00:00Z'); do d = new Date(+d - 864e5); while (!isTradingDay(isoOf(d))); return isoOf(d); };

let best = (await appRow()).news?.best ?? {};
best.history ??= [];

// ---- 1. score the last picks: filled at the open only if it opened at or below the limit ----
async function bars5(symbol, iso) {
  const p1 = Math.floor(Date.parse(iso + 'T03:30:00Z') / 1000);
  const body = await fetchCached(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol + '.NS')}?period1=${p1}&period2=${p1 + 6.5 * 3600}&interval=5m`, { ttlHours: 0.1, attempts: 3 }).catch(() => null);
  const r = body ? JSON.parse(body).chart?.result?.[0] : null;
  if (!r?.timestamp) return null;
  const q = r.indicators.quote[0];
  return r.timestamp.map((t, i) => { const d = new Date((t + 19800) * 1000); return { hhmm: d.getUTCHours() * 100 + d.getUTCMinutes(), o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] }; }).filter((b) => b.o != null && b.c != null);
}
function walk(bars, p) {
  const px = bars[0].o;
  let peak = px;
  for (const b of bars.filter((x) => x.hhmm <= 1515)) {
    const stop = p.exit === 'trail' ? Math.max(px * 0.98, peak * 0.985) : px * (1 - p.stop);
    if (b.l <= stop) return { ret: Math.min(b.o, stop) / px - 1, how: p.exit === 'trail' && stop > px * 0.98 ? 'push stopped (1.5% off its best)' : 'stop loss' };
    if (p.target && b.h >= px * (1 + p.target)) return { ret: p.target, how: `target +${p.target * 100}%` };
    peak = Math.max(peak, b.h);
  }
  const last = bars.filter((x) => x.hhmm <= 1515).at(-1);
  return { ret: last.c / px - 1, how: '3:20 pm' };
}
if (best.date && best.date < today && !best.scored && best.picks?.length) {
  const lines = [];
  for (const p of best.picks) {
    const bars = await bars5(p.symbol, best.date);
    if (!bars?.length || bars[0].hhmm !== 915) continue;
    if (bars[0].o > p.limit) { p.filled = false; lines.push(`${p.symbol}: opened ₹${bars[0].o} above your limit ₹${p.limit} - not bought`); continue; }
    const r = walk(bars, p);
    Object.assign(p, { filled: true, open: bars[0].o, result: r.ret - RULE.cost, how: r.how });
    lines.push(`${p.symbol}: bought ₹${bars[0].o}, ${r.how} -> ${pct(p.result)}`);
  }
  best.scored = true;
  best.history.push({ date: best.date, picks: best.picks.filter((p) => p.result != null).map(({ symbol, kind, result, how }) => ({ symbol, kind, result, how })) });
  const all = best.history.flatMap((h) => h.picks);
  if (lines.length) await notify(`Yesterday's buys: ${best.picks.filter((p) => p.result != null).map((p) => `${p.symbol} ${pct(p.result)}`).join(', ') || 'none filled'}`,
    `${lines.join('\n')}\n\nSo far: ${all.length} trades, ${all.filter((x) => x.result > 0).length} won, avg ${all.length ? pct(all.reduce((s, x) => s + x.result, 0) / all.length) : '-'} after charges.`, 'low', 'clipboard');
  await publishNews('best', best);
}
if (!DRY && best.date === today && best.sent) { console.log('Already sent today.'); process.exit(0); }

// ---- 2. wait for pre-open prices ----
const SEND_AT = 9 * 3600 + 4 * 60 + 40; // 9:04:40 - pre-open closes at a random moment 9:07-9:08, so this leaves ~2.5 minutes
if (!DRY && secs() > 9 * 3600 + 7 * 60 + 30) { console.log('Too late for pre-open today.'); process.exit(0); }
// liquidity + overnight news while we wait
const turnover = new Map();
for (let iso = prevDay(today), n = 0; n < 20; iso = prevDay(iso), n++) {
  const [y, m, d] = iso.split('-');
  const csv = await fetchCached(`https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${d}${m}${y}.csv`, { ttlHours: 1e7, attempts: 2 }).catch(() => null);
  if (!csv?.startsWith('SYMBOL')) continue;
  const lines = csv.trim().split(/\r?\n/), head = lines[0].split(',').map((x) => x.trim()), c = (k) => head.indexOf(k);
  for (const line of lines.slice(1)) { const p = line.split(',').map((x) => x.trim()); if (p[c('SERIES')] === 'EQ' || p[c('SERIES')] === 'BE') (turnover.get(p[c('SYMBOL')]) ?? turnover.set(p[c('SYMBOL')], []).get(p[c('SYMBOL')])).push(+p[c('TURNOVER_LACS')] / 100); }
}
const cr = new Map([...turnover].map(([s, a]) => [s, median(a)]));
const badNews = new Set();
for (const a of await announcements(prevDay(today), today, 0).catch(() => [])) if (BAD_NEWS.has(categorise(a.desc ?? '', a.attchmntText ?? ''))) badNews.add(a.symbol);
while (!DRY && secs() < SEND_AT) await sleep(5000);
const nseDay = (() => { const [y, m, d] = today.split('-'); return `${d}-${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m - 1]}-${y}`; })();
let pre = new Map();
for (let i = 0; i < 6; i++) {
  pre = await preOpen(0).catch(() => new Map());
  if ([...pre.values()].some((p) => p.time.startsWith(nseDay))) break;
  await sleep(8000);
}
if (![...pre.values()].some((p) => p.time.startsWith(nseDay))) { await notify('TODAY: no pre-open prices', 'Could not read pre-open prices from NSE (holiday, or NSE not answering). No pick today.', 'default', 'warning'); process.exit(0); }
const gapOf = (s) => { const p = pre.get(s); return p?.iep && p.prevClose ? p.iep / p.prevClose - 1 : null; };

// ---- 3. candidates from every strategy ----
const row = await appRow();
const cands = [];
const add = (symbol, kind, score, why, rule) => {
  const p = pre.get(symbol), gap = gapOf(symbol);
  if (!p?.iep || gap == null) return;
  cands.push({ symbol, kind, score, why, gap, iep: p.iep, limit: round(p.iep * (1 + RULE.limitAbove)), ...rule });
};
// 1. panic rebound, HIGH level only (the normal level did not hold up)
const marketGap = median([...pre.keys()].filter((s) => (cr.get(s) ?? 0) >= 2).map(gapOf).filter((g) => g != null));
if (marketGap <= RULE.marketPanic) {
  for (const s of pre.keys()) {
    const g = gapOf(s);
    if (g == null || g > RULE.panicGap[1] || g <= RULE.panicGap[0] + 0.0005 || (cr.get(s) ?? 0) < RULE.panicMinCr || badNews.has(s)) continue;
    add(s, 'Panic rebound', 95 + Math.min(4, cr.get(s) / 500), `whole market panicking (${pct(marketGap)}), big stock opening ${pct(g)} - these bounce back`, { exit: 'fixed', stop: 0.03, target: null });
  }
}
// 2. gap & go (results list made the evening before / 8:30 am)
const gg = row.gapgo?.date === today ? row.gapgo : null;
for (const c of gg?.candidates ?? []) {
  if (c.status !== 'watch' && c.status !== 'go') continue;
  const g = gapOf(c.symbol);
  if (g == null || g < RULE.gapGo[0] || g >= RULE.gapGo[1] || (cr.get(c.symbol) ?? 0) < 5) continue;
  add(c.symbol, 'Gap & Go', 85 + Math.min(5, Math.min(c.qoq, c.yoy) * 5), `result: profit ${pct(c.qoq)} vs last quarter, ${pct(c.yoy)} vs last year; opening ${pct(g)}`, { exit: 'fixed', stop: 0.03, target: 0.07 });
}
// 3. strong news (Claude-graded morning list)
const np = row.news?.picks?.date === today ? row.news.picks : null;
for (const w of np?.watch ?? []) {
  const g = gapOf(w.symbol);
  if (g == null || g < RULE.newsGap[0] || g > RULE.newsGap[1] || (cr.get(w.symbol) ?? 0) < 5) continue;
  add(w.symbol, 'Strong news', 72 + Math.min(3, (cr.get(w.symbol) ?? 0) / 100), `${w.why}; opening ${pct(g)}`, { exit: 'trail', stop: 0.02, target: null });
}

// ---- 4. choose: best first, one per stock, only the top level of the day ----
const seen = new Set();
const ranked = cands.sort((a, b) => b.score - a.score).filter((c) => !seen.has(c.symbol) && seen.add(c.symbol));
// Very strong = Panic rebound HIGH or Gap & Go (score 85+). If any very strong stock exists, send only those (up to 3,
// panic first, then Gap & Go). Only when there is none do strong-news stocks go out (up to 3, most traded first).
const veryStrong = ranked.some((c) => c.score >= 85);
const picks = ranked.filter((c) => !veryStrong || c.score >= 85).slice(0, RULE.maxPicks);
log(`market ${pct(marketGap)}, ${cands.length} candidates: ${ranked.map((c) => `${c.symbol}(${c.kind} ${c.score.toFixed(0)})`).join(', ') || 'none'}`);

const sellText = (p) => p.exit === 'trail' ? `when it falls 1.5% from its best (you get SELL NOW), or at ₹${p.stopPrice}` : `${p.targetPrice ? `UP at ₹${p.targetPrice} or ` : ''}DOWN at ₹${p.stopPrice}, else at 3:20 pm`;
best = { ...best, date: today, picks: picks.map(({ symbol, kind, why, gap, iep, limit, exit, stop, target, score }) => ({ symbol, kind, why, gap, iep, limit, exit, stop, target, level: score >= 85 ? 3 : 2, stopPrice: round(iep * (1 - stop)), targetPrice: target ? round(iep * (1 + target)) : null })).map((p) => ({ ...p, sell: sellText(p) })), marketGap, sent: true, scored: false, generated: new Date().toISOString() };
if (!DRY) { await publishNews('best', best); await publishNews('final', { date: today, sent: true, picks: best.picks }); }
const out = best.picks;
if (out.length) {
  await notify(`BUY TODAY: ${out.map((p) => p.symbol).join(', ')} (before 9:07)`,
    out.map((p, i) => `${i + 1}. ${p.symbol} - ${p.kind}\n   ${p.why}\n   BUY: limit ₹${p.limit} in pre-open NOW\n   SELL ${p.sell}`).join('\n\n') +
    `\n\n${out.length > 1 ? `Split your money equally (${out.length} stocks). ` : ''}Intraday only. If it opens above your limit, you are not filled - do not chase.`, 'urgent', 'rocket');
} else {
  await notify('NO BUY TODAY', `Nothing strong this morning (market opening ${pct(marketGap)}). Not trading is the winning move today - forced trades lost money in testing.\nDuring the day the live radar may still send BUY NOW on fresh news.`, 'default', 'zzz');
}
