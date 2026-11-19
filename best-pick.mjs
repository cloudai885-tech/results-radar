// TODAY'S BUY: ONE message at about 9:05:30 am with the best 1-3 stocks of the day, from every tested strategy.
// NSE pre-open since Sep 7 2026: orders 9:00-9:05 (any), 9:05 until a random close between 9:08 and 9:10 (limit only),
// matching 9:10-9:12. Deciding at 9:05:30 uses prices much closer to the real open, and the user has until 9:08.
// The user wants one clear answer, not many lists. Ranked by how well each strategy held up in testing:
//   1. Panic rebound, HIGH level: whole market opens -1.2% or worse, a big stock (Rs 20 cr+/day) opens -3..-5%,
//      no bad news overnight. 10 of 10 such days won (Jan 2025 - Nov 2026, small sample). Hold to 3:20 pm, stop -3%.
//   2. Gap & Go: results beat last quarter AND last year, opens +5..+20%. 98 trades over 2 years, +1.2% a trade.
//      Nov 19 2026 (research/34): each stock gets its own levels from its usual daily range (ATR, last 14 sessions):
//      stop 1.25x ATR, target 2x ATR (typical -4.6% / +7.4%), else 3:20 pm. Beat the fixed +7%/-3% in 2025 AND 2026
//      (+0.72%/+0.57% vs +0.04%/+0.44% a trade). Without ATR data: -5% / +7%.
//   3. Strong news (Claude-graded, morning list) and opens +5..+15%. One month: +1.2% a trade, 8 of 15 won.
//      Sell when it falls 1.5% from its best (the live radar sends SELL NOW).
//   4. Bounce-back, only when 1-3 have nothing: fell 3%+ yesterday, opens -3..-5% again, no bad news (research/22
//      said +0.94% a day, but 94 of its 288 trades were T2T stocks that cannot be sold the same day. Without T2T:
//      +0.29% a day since 2025 at Rs 5 cr+/day). Nov 19 2026, user's choice (research/28): Rs 1 cr+/day, about 1,600
//      stocks instead of 1,100: +0.6% a day, a trade on ~105 of the last 125 days. Pre-open sellers are plentiful on
//      down-gap mornings (Rs 11-21 lakh waiting even in Rs 1-2 cr stocks), so a Rs 12k buy fills at the open. Risk the
//      user accepted: stocks with a 5% price band can lock at the lower circuit (~1-2 times a month a pick closes
//      locked and cannot be sold that day); the message warns on those. Needs the exact pre-open fill. Half money.
// T2T stocks (series BE) are never picked: they cannot be sold the same day (Nov 18 2026, HFCL).
//      Sell at +7% or -3%, else 3:20 pm.
// Only the top level of the day is sent: if one strategy is clearly stronger, only its stocks go out (often just 1).
// Nothing strong -> "NO BUY TODAY". The month's tests showed forced trades on other days lose about 0.4% each.
//
//   node best-pick.mjs           start it early (GitHub timers can run an hour late); it waits, decides at 9:05:30,
//                                Claude checks each pick for red flags (seconds) and sends. No CANCEL messages: the
//                                limit price itself keeps each order inside its range (Panic / Bounce-back: limit at
//                                -3% from yesterday's close, so a stock that bounces back before the open is not bought;
//                                Gap & Go / news: never above the top of the range or the circuit).
// Also scores yesterday's picks first (5-minute candles) and keeps the record for the app (row 1, news.best).
import { fetchCached, preOpen, announcements, holidays, etfList, priceBands, buyLimit } from './src/sources.mjs';
import { categorise } from './research/categories.mjs';
import { publishNews } from './src/app-publish.mjs';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

const RULE = { cost: 0.004, limitAbove: 0.03, marketPanic: -0.012, panicMinCr: 20, panicGap: [-0.05, -0.03], gapGo: [0.05, 0.2], newsGap: [0.05, 0.15], maxPicks: 3 };
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

// BEST_DRY=1: run now on whatever pre-open data NSE shows, send nothing, save nothing.
// BEST_TEST=1 (GitHub test button): same, but sends the result to the phone marked TEST, and proves the Claude check works.
const TEST = process.env.BEST_TEST === '1';
const DRY = process.env.BEST_DRY === '1' || TEST;
const topic = DRY && !TEST ? null : process.env.NTFY_TOPIC;
const notify = async (title, body, priority, tags) => {
  if (TEST) { title = `TEST - ${title}`; priority = 'default'; }
  log(`[${title}]\n${body}`);
  if (topic) await fetch(`https://ntfy.sh/${topic}`, { method: 'POST', body, headers: { Title: title, Priority: priority, Tags: tags } }).catch(() => {});
};
const SB = !DRY && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY ? { url: `${process.env.SUPABASE_URL}/rest/v1/radar`, key: process.env.SUPABASE_SERVICE_KEY } : null;
const appRow = async () => (SB ? (await (await fetch(`${SB.url}?id=eq.1&select=payload`, { headers: { apikey: SB.key } })).json())?.[0]?.payload ?? {} : {});

const hol = await holidays().catch(() => new Set());
const etfs = await etfList().catch(() => new Set()); // NSE's official ETF list
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
const SEND_AT = 9 * 3600 + 5 * 60 + 30; // 9:05:30 - order entry closes at a random moment between 9:08 and 9:10
if (!DRY && secs() > 9 * 3600 + 7 * 60 + 30) { console.log('Too late for pre-open today.'); process.exit(0); }
// liquidity + overnight news while we wait
const turnover = new Map();
const yRet = new Map(); // yesterday's close vs the day before
const trueRange = new Map(); // symbol -> [{ tr, close }] newest first, for ATR (Gap & Go stop/target)
// T2T stocks (NSE series "BE"): delivery only, cannot be sold the same day -> never pick them for intraday.
// Taken from the newest bhavcopy we can read (Nov 18 2026: user got stuck holding HFCL overnight).
const t2t = new Set();
let gotLatest = false;
for (let iso = prevDay(today), n = 0; n < 20; iso = prevDay(iso), n++) {
  const [y, m, d] = iso.split('-');
  const csv = await fetchCached(`https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${d}${m}${y}.csv`, { ttlHours: 1e7, attempts: 2 }).catch(() => null);
  if (!csv?.startsWith('SYMBOL')) continue;
  const lines = csv.trim().split(/\r?\n/), head = lines[0].split(',').map((x) => x.trim()), c = (k) => head.indexOf(k);
  if (!gotLatest) { gotLatest = true; for (const line of lines.slice(1)) { const p = line.split(',').map((x) => x.trim()); if (p[c('SERIES')] === 'BE') t2t.add(p[c('SYMBOL')]); } }
  if (n === 0) for (const line of lines.slice(1)) { const p = line.split(',').map((x) => x.trim()); if ((p[c('SERIES')] === 'EQ' || p[c('SERIES')] === 'BE') && +p[c('PREV_CLOSE')] > 0) yRet.set(p[c('SYMBOL')], +p[c('CLOSE_PRICE')] / +p[c('PREV_CLOSE')] - 1); }
  for (const line of lines.slice(1)) {
    const p = line.split(',').map((x) => x.trim()); if (p[c('SERIES')] !== 'EQ' && p[c('SERIES')] !== 'BE') continue;
    const s = p[c('SYMBOL')]; (turnover.get(s) ?? turnover.set(s, []).get(s)).push(+p[c('TURNOVER_LACS')] / 100);
    const h = +p[c('HIGH_PRICE')], l = +p[c('LOW_PRICE')], pc = +p[c('PREV_CLOSE')], cl = +p[c('CLOSE_PRICE')];
    if (h > 0 && l > 0 && pc > 0) (trueRange.get(s) ?? trueRange.set(s, []).get(s)).push({ tr: Math.max(h, pc) - Math.min(l, pc), close: cl });
  }
}
const cr = new Map([...turnover].map(([s, a]) => [s, median(a)]));
// average true range of the last 14 sessions as a share of the latest close (null if not enough days)
const atrOf = (s) => { const a = trueRange.get(s); if (!a || a.length < 10) return null; const x = a.slice(0, 14); return x.reduce((t, y) => t + y.tr, 0) / x.length / a[0].close; };
const nseDay = (() => { const [y, m, d] = today.split('-'); return `${d}-${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m - 1]}-${y}`; })();
while (!DRY && secs() < SEND_AT - 8) await sleep(2000);
// read the newest lists and overnight filings right before deciding (a few seconds)
const [row, filings] = await Promise.all([appRow(), announcements(prevDay(today), today, 0).catch(() => [])]);
const badNews = new Set();
for (const a of filings) if (BAD_NEWS.has(categorise(a.desc ?? '', a.attchmntText ?? ''))) badNews.add(a.symbol);
while (!DRY && secs() < SEND_AT) await sleep(500);

async function freshPreOpen() {
  for (let i = 0; i < 8; i++) {
    const pre = await preOpen(0).catch(() => new Map());
    if ([...pre.values()].some((p) => p.time.startsWith(nseDay))) return pre;
    await sleep(5000);
  }
  return null;
}
const bands = await priceBands(); // circuit limits, so the buy limit is never above the upper circuit
// ---- 3. candidates from every strategy, for one set of pre-open prices ----
function choose(pre) {
  const gapOf = (s) => { const p = pre.get(s); return p?.iep && p.prevClose ? p.iep / p.prevClose - 1 : null; };
  const cands = [];
  const add = (symbol, kind, score, why, rule) => {
    const p = pre.get(symbol), gap = gapOf(symbol);
    if (!p?.iep || gap == null || t2t.has(symbol) || etfs.has(symbol)) return; // companies only: no ETFs (SILVERBEES etc.)
    // the limit keeps the order inside the strategy's range, so no CANCEL message is needed if the price moves before 9:10
    const tick = (v) => Math.floor(v * 20 + 1e-6) / 20;
    const down = kind === 'Panic rebound' || kind === 'Bounce-back';
    const top = kind === 'Gap & Go' ? RULE.gapGo[1] : RULE.newsGap[1];
    const limit = down ? tick(p.prevClose * (1 + RULE.panicGap[1])) : Math.min(buyLimit(p.iep, p.prevClose, bands.get(symbol), RULE.limitAbove), tick(p.prevClose * (1 + top)));
    cands.push({ symbol, kind, score, why, gap, iep: p.iep, limit, ...rule });
  };
  // 1. panic rebound, HIGH level only (the normal level did not hold up)
  const marketGap = median([...pre.keys()].filter((s) => (cr.get(s) ?? 0) >= 2).map(gapOf).filter((g) => g != null && g !== 0)); // 0 exactly = no pre-open trade yet (~15% of stocks), it would pull the reading toward 0
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
    add(c.symbol, 'Gap & Go', 85 + Math.min(5, Math.min(c.qoq, c.yoy) * 5), `result: profit ${pct(c.qoq)} vs last quarter, ${pct(c.yoy)} vs last year; opening ${pct(g)}`, (() => { const a = atrOf(c.symbol); return a ? { exit: 'fixed', stop: Math.min(0.08, Math.max(0.02, 1.25 * a)), target: Math.min(0.15, Math.max(0.04, 2 * a)), atr: a } : { exit: 'fixed', stop: 0.05, target: 0.07 }; })());
  }
  // 4. bounce-back (research/22: fell 3%+ yesterday, opens -3..-5% again, no bad news, Rs 5 cr+/day; +0.94% a day on days with
  //    no other pick, positive in every half-year since 2025). Only with a PRE-OPEN fill: 1% worse entry = no edge.
  for (const [s2, q] of pre) {
    const g = gapOf(s2), y = yRet.get(s2);
    if (g == null || y == null || y > -0.03 || g > -0.03 || g <= -0.0495 || (cr.get(s2) ?? 0) < 1 || badNews.has(s2)) continue;
    add(s2, 'Bounce-back', 60 + Math.min(3, (cr.get(s2) ?? 0) / 100), `fell ${pct(y)} yesterday, opening ${pct(g)} again, no bad news - these usually bounce`, { exit: 'fixed', stop: 0.03, target: 0.07 });
  }
  // 3. strong news (Claude-graded morning list)
  const np = row.news?.picks?.date === today ? row.news.picks : null;
  for (const w of np?.watch ?? []) {
    const g = gapOf(w.symbol);
    if (g == null || g < RULE.newsGap[0] || g > RULE.newsGap[1] || (cr.get(w.symbol) ?? 0) < 5) continue;
    add(w.symbol, 'Strong news', 72 + Math.min(3, (cr.get(w.symbol) ?? 0) / 100), `${w.why}; opening ${pct(g)}`, { exit: 'trail', stop: 0.02, target: null });
  }
  const seen = new Set();
  const ranked = cands.sort((a, b) => b.score - a.score).filter((c) => !seen.has(c.symbol) && seen.add(c.symbol));
  return { marketGap, ranked };
}
// Only the top level present goes out (up to 3): very strong = Panic rebound HIGH / Gap & Go (85+), then strong news (70+),
// then bounce-back (60+, half money) on days with nothing else.
const tierOf = (score) => (score >= 85 ? 3 : score >= 70 ? 2 : 1);
const pickFrom = (ranked) => { const top = Math.max(0, ...ranked.map((c) => tierOf(c.score))); return ranked.filter((c) => tierOf(c.score) === top); };

// ---- 4. Claude double-checks each pick in seconds: any red flag in the news? ----
const VerdictSchema = z.object({ verdict: z.enum(['BUY', 'AVOID']), reason: z.string() });
const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
async function headlines(symbol) {
  const xml = await fetch(`https://www.bing.com/news/search?q=${encodeURIComponent(`"${symbol}" share`)}&format=rss&count=15&qft=interval%3d%227%22`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(4000) }).then((r) => r.text()).catch(() => '');
  return xml.split('<item>').slice(1, 9).map((it) => (/<title>([\s\S]*?)<\/title>/.exec(it)?.[1] ?? '').replace(/<!\[CDATA\[|\]\]>|&quot;|&amp;|&#39;/g, ' ').trim()).filter(Boolean);
}
async function claudeCheck(c) {
  if (!client) return { verdict: 'BUY', reason: 'not checked (no Claude key)' };
  const nse = filings.filter((a) => a.symbol === c.symbol).slice(0, 8).map((a) => `- ${a.an_dt}: ${(a.attchmntText || a.desc || '').replace(/\s+/g, ' ').slice(0, 220)}`);
  const news = await headlines(c.symbol);
  const ask = client.messages.parse({
    model: 'claude-haiku-5-5', max_tokens: 2000, output_config: { effort: 'low', format: zodOutputFormat(VerdictSchema) },
    system: 'You are the last safety check before an intraday buy at the 9:15 open on the NSE. Say AVOID only for a clear red flag in the news: fraud, raid, default, auditor or CEO/CFO exit, regulator ban or penalty, results actually weak or misread, promoter or big holder selling, pledge, order cancelled, or the reason given for the buy is wrong. Otherwise say BUY. reason: under 12 words.',
    messages: [{ role: 'user', content: `${c.symbol} - strategy: ${c.kind}. Why: ${c.why}\nNSE filings since yesterday:\n${nse.join('\n') || '(none)'}\nNews headlines, last 24 h:\n${news.map((h) => `- ${h}`).join('\n') || '(none)'}` }],
  });
  const res = await Promise.race([ask, sleep(15000).then(() => null)]).catch(() => null);
  return res?.parsed_output ?? { verdict: 'BUY', reason: 'Claude did not answer in time - not checked' };
}

// ---- 5. decide at 9:05:30 and send (no follow-up CANCEL messages) ----
let pre = await freshPreOpen();
if (!pre) { await notify('TODAY: no pre-open prices', 'Could not read pre-open prices from NSE (holiday, or NSE not answering). No pick today.', 'default', 'warning'); process.exit(0); }
let { marketGap, ranked } = choose(pre);
const checks = new Map(await Promise.all(pickFrom(ranked).slice(0, RULE.maxPicks + 2).map(async (c) => [c.symbol, await claudeCheck(c)])));
const avoided = [...checks].filter(([, v]) => v.verdict === 'AVOID');
const picks = pickFrom(ranked).filter((c) => checks.get(c.symbol)?.verdict !== 'AVOID').slice(0, RULE.maxPicks);
log(`market ${pct(marketGap)}, candidates: ${ranked.map((c) => `${c.symbol}(${c.kind} ${c.score.toFixed(0)})`).join(', ') || 'none'}; Claude avoided: ${avoided.map(([s, v]) => `${s} (${v.reason})`).join(', ') || 'none'}`);

const sellText = (p) => p.exit === 'trail' ? `when it falls 1.5% from its best (you get SELL NOW), or at ₹${p.stopPrice}` : `${p.targetPrice ? `UP at ₹${p.targetPrice} or ` : ''}DOWN at ₹${p.stopPrice}, else at 3:20 pm`;
best = { ...best, date: today, cancelled: [], picks: picks.map(({ symbol, kind, why, gap, iep, limit, exit, stop, target, score, atr }) => ({ symbol, kind, why, gap, iep, limit, exit, stop, target, atr, level: tierOf(score), check: checks.get(symbol)?.reason, stopPrice: round(iep * (1 - stop)), targetPrice: target ? round(iep * (1 + target)) : null })).map((p) => ({ ...p, sell: sellText(p) })), avoided: avoided.map(([s, v]) => ({ symbol: s, reason: v.reason })), marketGap, sent: true, scored: false, generated: new Date().toISOString() };
const publish = async () => { if (!DRY) { await publishNews('best', best); await publishNews('final', { date: today, sent: true, picks: best.picks }); } };
await publish();
const out = best.picks;
const avoidNote = avoided.length ? `\n\nClaude removed: ${avoided.map(([s, v]) => `${s} (${v.reason})`).join('; ')}` : '';
if (out.length) {
  await notify(`BUY TODAY: ${out.map((p) => p.symbol).join(', ')} (place before 9:08)`,
    out.map((p, i) => `${i + 1}. ${p.symbol} - ${p.kind}\n   ${p.why}\n   Claude check: ${p.check}\n   BUY: limit ₹${p.limit} in pre-open NOW${p.level === 1 ? ' (HALF your usual money; only in pre-open, never after 9:15)' : ''}${bands.get(p.symbol) != null && bands.get(p.symbol) <= 0.05 ? `
   ⚠ ${Math.round(bands.get(p.symbol) * 100)}% circuit stock: it can lock at the lower circuit (₹${round(p.iep / (1 + p.gap) * (1 - bands.get(p.symbol)))}) and then you cannot sell that day` : ''}\n   SELL ${p.sell}${p.atr ? `\n   (levels fit this stock: it usually moves ~${(p.atr * 100).toFixed(1)}% a day, so stop -${(p.stop * 100).toFixed(1)}%, target +${(p.target * 100).toFixed(1)}%)` : ''}`).join('\n\n') +
    `\n\n${out.length > 1 ? `Split your money equally (${out.length} stocks). ` : ''}Intraday only. Place LIMIT orders before 9:08 (after 9:05 NSE takes only limit orders). The limit is the protection: if the price moves out of range before the open, the order simply does not fill - no cancel needed. Bought above the pre-open price? Keep the same stop distance (in %) below YOUR buy price. Not bought by 9:15? Cancel the order - never buy later.${avoidNote}`, 'urgent', 'rocket');
} else if (TEST && ranked.length + [...pre.keys()].length) {
  const sample = [...pre.entries()].filter(([s]) => (cr.get(s) ?? 0) >= 20).map(([s, q]) => ({ symbol: s, kind: 'test', why: `opened ${pct(q.iep / q.prevClose - 1)} today`, g: q.iep / q.prevClose - 1 })).sort((a, b) => b.g - a.g)[0];
  const v = sample ? await claudeCheck(sample) : null;
  await notify('NO BUY TODAY (test)', `Nothing strong in today's pre-open (market ${pct(marketGap)}).
Claude check test on ${sample?.symbol}: ${v?.verdict} - ${v?.reason}`, 'default', 'zzz');
} else {
  await notify('NO BUY TODAY', `Nothing strong this morning (market opening ${pct(marketGap)}). Not trading is the winning move today - forced trades lost money in testing.\nDuring the day the live radar may still send BUY NOW on fresh news.${avoidNote}`, 'default', 'zzz');
}
