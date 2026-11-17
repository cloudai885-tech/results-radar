// LIVE NEWS RADAR (paper test). The user's strategy: news comes out during market hours -> read it at once ->
// BUY NOW alert within about a minute -> SELL NOW alert as soon as the push stops (price falls 1.5% from its best).
// Also: bad news on a stock we are holding -> SELL NOW at once.
// Research (research/17-fast-news.mjs, 1-minute candles): buying 1 minute after strong news made +0.6% per trade after
// costs (sell on a 1.5% drop from the best); at 2 minutes it was ~0, at 5 minutes worse. So speed is everything.
//
//   node live-radar.mjs            runs from now until about 15:25 India time (max ~5h50 per run; GitHub starts a 2nd run)
// Env: ANTHROPIC_API_KEY (Claude reads each filing + its PDF; without it only obvious keyword news is caught),
//      NTFY_TOPIC, SUPABASE_URL, SUPABASE_SERVICE_KEY. Without Supabase the state lives in data/live-radar.json.
import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { fetchCached, announcements, holidays, mapPool } from './src/sources.mjs';
import { typeOf } from './research/news-types.mjs';
import { publishNews } from './src/app-publish.mjs';

const RULE = {
  minCr: 5, // stock must trade Rs 5 cr+ a day (else we cannot get in and out)
  minStrength: 8, // only the strongest news (1-10)
  maxBuys: 3, // per day
  maxRunUp: 0.04, // skip if it already ran 4%+ since the filing (too late)
  maxDayUp: 0.12, // skip if already up 12%+ on the day
  trail: 0.015, // sell when it falls 1.5% from its best price since the buy
  stop: 0.02, // or 2% below the buy price
  lastBuy: 1445, // no new buys after 2:45 pm
  closeAll: 1515, // sell everything at 3:15 pm
  pollSec: 30,
  maxDelaySec: 180, // research: 1 min after the news = profit, 2+ min = nothing. Older than 3 min -> no buy
  maxPdfs: 80, // per day, keeps Claude cost tiny
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ist = () => new Date(Date.now() + 19800e3);
const isoOf = (d) => d.toISOString().slice(0, 10);
const hhmmNow = () => { const n = ist(); return n.getUTCHours() * 100 + n.getUTCMinutes(); };
const today = isoOf(ist());
const pct = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; };
const log = (...a) => console.log(ist().toISOString().slice(11, 19), ...a);

// ---- phone + database (Supabase row 5) ----
const topic = process.env.NTFY_TOPIC;
const notify = async (title, body, priority = 'default', tags = 'newspaper') => {
  log(`[${title}] ${body.replace(/\n/g, ' | ')}`);
  if (topic) await fetch(`https://ntfy.sh/${topic}`, { method: 'POST', body, headers: { Title: title, Priority: priority, Tags: tags } }).catch(() => {});
};
const sb = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY ? { url: `${process.env.SUPABASE_URL}/rest/v1/radar`, key: process.env.SUPABASE_SERVICE_KEY } : null;
const LOCAL = new URL('./data/live-radar.json', import.meta.url);
async function load(id = 5) {
  if (sb) return (await (await fetch(`${sb.url}?id=eq.${id}&select=payload`, { headers: { apikey: sb.key } })).json())?.[0]?.payload ?? {};
  if (id !== 5) return {};
  return fs.existsSync(LOCAL) ? JSON.parse(fs.readFileSync(LOCAL, 'utf8')) : {};
}
let lastPublic = '';
async function save() {
  const pub = { date: state.date, trades: state.trades.map(({ symbol, px, at, newsAt, delay, why, strength, exit, ret, how, exitAt }) => ({ symbol, px, at, newsAt, delay, why, strength, exit, ret, how, exitAt })), badNews: state.badNews ?? [], graded: state.graded, history: (state.history ?? []).slice(-30) };
  const js = JSON.stringify({ ...pub, graded: 0 });
  if (js !== lastPublic) { lastPublic = js; await publishNews('live', pub); }
  if (!sb) { fs.mkdirSync(new URL('./data/', import.meta.url), { recursive: true }); fs.writeFileSync(LOCAL, JSON.stringify(state, null, 1)); return; }
  const res = await fetch(sb.url, { method: 'POST', headers: { apikey: sb.key, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ id: 5, payload: state, updated_at: new Date().toISOString() }) });
  if (!res.ok) console.warn(`Supabase save failed: ${res.status}`);
}

// ---- trading day? ----
const hol = await holidays().catch(() => new Set());
const isTradingDay = (iso) => { const d = new Date(iso + 'T00:00:00Z').getUTCDay(); return d !== 0 && d !== 6 && !hol.has(iso); };
if (!isTradingDay(today)) { console.log(`${today} is not a trading day.`); process.exit(0); }
const TEST = process.argv[2] === 'test'; // read today's last real filings with Claude and send the grades to the phone; no trades saved
if (!TEST && hhmmNow() >= 1525) { console.log('Market is closing; nothing to do.'); process.exit(0); }

const state = await load();
if (state.date !== today) {
  if (state.date && state.trades?.length) (state.history ??= []).push({ date: state.date, trades: state.trades.map(({ symbol, ret, delay }) => ({ symbol, ret, delay })) });
  Object.assign(state, { date: today, seen: [], trades: [], badNews: [], pdfs: 0, graded: 0 });
}
const seen = new Set(state.seen);

// ---- liquid stocks (median turnover of the last 10 sessions) ----
const prevDay = (iso) => { let d = new Date(iso + 'T00:00:00Z'); do d = new Date(+d - 864e5); while (!isTradingDay(isoOf(d))); return isoOf(d); };
const turnover = new Map();
for (let iso = prevDay(today), n = 0; n < 10; iso = prevDay(iso), n++) {
  const [y, m, d] = iso.split('-');
  const csv = await fetchCached(`https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${d}${m}${y}.csv`, { ttlHours: 1e7, attempts: 2 }).catch(() => null);
  if (!csv?.startsWith('SYMBOL')) continue;
  const lines = csv.trim().split(/\r?\n/), head = lines[0].split(',').map((x) => x.trim()), c = (k) => head.indexOf(k);
  for (const line of lines.slice(1)) { const p = line.split(',').map((x) => x.trim()); if (p[c('SERIES')] === 'EQ' || p[c('SERIES')] === 'BE') (turnover.get(p[c('SYMBOL')]) ?? turnover.set(p[c('SYMBOL')], []).get(p[c('SYMBOL')])).push(+p[c('TURNOVER_LACS')] / 100); }
}
const liquid = new Map([...turnover].map(([s, a]) => [s, median(a)]).filter(([, cr]) => cr >= RULE.minCr));
log(`${liquid.size} liquid stocks. ${state.trades.length} trades so far today.`);

// ---- live 1-minute candles (Yahoo) ----
async function bars1(symbol) {
  const body = await fetchCached(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol + '.NS')}?range=1d&interval=1m`, { ttlHours: 0, attempts: 2 }).catch(() => null);
  const r = body ? JSON.parse(body).chart?.result?.[0] : null;
  if (!r?.timestamp) return null;
  const q = r.indicators.quote[0];
  const bars = r.timestamp.map((t, i) => { const d = new Date((t + 19800) * 1000); return { hhmm: d.getUTCHours() * 100 + d.getUTCMinutes(), o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] }; }).filter((b) => b.c != null);
  return { bars, last: r.meta?.regularMarketPrice ?? bars.at(-1)?.c, prevClose: r.meta?.previousClose ?? r.meta?.chartPreviousClose };
}

// ---- Claude reads the filing (and its PDF for results / orders / deals) ----
const GradeSchema = z.object({ grade: z.number().int().min(-1).max(2), strength: z.number().int().min(1).max(10), why: z.string() });
const PROMPT = `You are a fast intraday trader in Indian stocks. A company just filed this with the NSE, during market hours.
Decide if this news will make the stock jump in the next minutes. Read the attached PDF if any (for results, compare
profit and revenue with the same quarter last year AND the previous quarter).
grade: 2 = strongly good and NEW (results clearly beat: profit up strongly vs last year and last quarter / record / swing to profit;
  large order or contract for the company's size; major approval like USFDA; big acquisition win; bonus/buyback/split; raised guidance).
  1 = mildly good. 0 = neutral, routine, procedural, already known, or unclear.
  -1 = bad (profit down or loss, miss, penalty, raid, fraud, top resignation, order cancelled, promoter selling, plant shutdown).
strength: 1-10, how hard the price should move (10 = huge surprise for a company of this size; use 8+ only for clearly big news).
why: under 12 words, with the key number.`;
const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
async function grade(x, text, type) {
  if (!client) {
    const good = /bags?|wins?|secures?|receipt of (an? )?(order|contract|letter of award)|L1|buyback|bonus|usfda|final approval|record/i.test(text);
    const bad = /resign|penalty|fraud|raid|search operation|cancell|show cause|default/i.test(text);
    return { grade: bad ? -1 : good ? 2 : 0, strength: good ? RULE.minStrength : 1, why: '(keyword - add ANTHROPIC_API_KEY)' };
  }
  const content = [];
  if (['result', 'order', 'deal', 'approval', 'capacity', 'fundraise', 'corporate', 'press'].includes(type) && x.attchmntFile?.endsWith('.pdf') && state.pdfs < RULE.maxPdfs) {
    const res = await fetch(x.attchmntFile, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) }).catch(() => null);
    const buf = res?.ok ? Buffer.from(await res.arrayBuffer()) : null;
    if (buf && buf.length < 8e6 && buf.subarray(0, 4).toString() === '%PDF') { content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } }); state.pdfs++; }
  }
  content.push({ type: 'text', text: `${x.symbol} (${x.sm_name ?? ''}, trades ~Rs ${liquid.get(x.symbol)?.toFixed(0) ?? '?'} cr a day)\nFiling: ${x.desc}\n${text}` });
  try {
    const res = await client.messages.parse({ model: 'claude-haiku-5-5', max_tokens: 4000, output_config: { effort: 'low', format: zodOutputFormat(GradeSchema) }, system: PROMPT, messages: [{ role: 'user', content }] });
    return res.parsed_output ?? { grade: 0, strength: 1, why: `(not read: ${res.stop_reason})` };
  } catch (e) { console.warn(`Claude failed for ${x.symbol}: ${e.message}`); return { grade: 0, strength: 1, why: '(not read)' }; }
}

// stocks we are "in": today's radar buys still open + this morning's news-picks buys (for the bad-news alarm)
const morning = (await load(4).catch(() => ({})))?.today;
const morningHeld = morning?.date === today ? [...(morning.openBuys ?? []), ...(morning.buys ?? [])].map((b) => b.symbol) : [];
const open = () => state.trades.filter((t) => t.exit == null);

const MON = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
const stampOf = (s) => { const m = /(\d+)-(\w{3})-(\d{4}) (\d+):(\d+):?(\d*)/.exec(s ?? ''); return m ? { hhmm: +m[4] * 100 + +m[5], t: `${m[4].padStart(2, '0')}:${m[5]}:${m[6] || '00'}`, ms: Date.UTC(+m[3], +MON[m[2]] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)) - 19800e3 } : null; };

async function sell(t, px, how) {
  t.exit = px; t.ret = px / t.px - 1 - 0.004; t.how = how; t.exitAt = ist().toISOString().slice(11, 16);
  await notify(`SELL NOW ${t.symbol} (${how})`, `${t.symbol} ~Rs ${px.toFixed(2)}. Bought ~Rs ${t.px.toFixed(2)} at ${t.at} -> ${pct(t.ret)} after costs.`, 'urgent', 'rotating_light');
  await save();
}

if (TEST) {
  const items = (await announcements(today, today, 0).catch(() => [])).filter((x) => liquid.has(x.symbol) && !['routine', 'meeting', 'board-meet', 'management'].includes(typeOf(x.desc ?? '', x.attchmntText ?? ''))).slice(0, 6);
  const got = await mapPool(items, 6, async (x) => ({ x, g: await grade(x, (x.attchmntText || '').replace(/\s+/g, ' ').slice(0, 600), typeOf(x.desc ?? '', x.attchmntText ?? '')) }));
  const ok = !!client && got.some((r) => r.g && !r.g.why.startsWith('('));
  await notify(`TEST: ${ok ? 'Claude is reading the news' : 'Claude NOT working'} (${got.length} filings, ${state.pdfs} PDFs)`,
    got.map(({ x, g }) => `${x.symbol} ${x.an_dt.slice(12, 17)}: grade ${g.grade}, strength ${g.strength} - ${g.why}`).join('\n') +
    (ok ? '\n\nAll good. Real BUY NOW alerts come only for strength 8+ news, within 3 minutes of the filing.' : client ? '\n\nThe key is set but Claude did not answer - check the key and credits.' : '\n\nNo ANTHROPIC_API_KEY found in GitHub secrets.'), 'default', 'white_check_mark');
  process.exit(0);
}

const endAt = Math.min(1525, (() => { const n = ist(); const m = n.getUTCHours() * 60 + n.getUTCMinutes() + 345; return Math.floor(m / 60) * 100 + (m % 60); })());
let first = state.seen.length === 0;
while (hhmmNow() < endAt) {
  const loopStart = Date.now();
  // 1. new filings
  const items = await announcements(today, today, 0).catch((e) => { console.warn(`NSE: ${e.message}`); return []; });
  const fresh = items.filter((x) => x.seq_id && !seen.has(String(x.seq_id)));
  for (const x of fresh) seen.add(String(x.seq_id));
  const work = [];
  for (const x of fresh) {
    const st = stampOf(x.an_dt);
    if (!st || first || st.hhmm < 914) continue; // overnight news belongs to the morning list
    const held = open().some((t) => t.symbol === x.symbol) || morningHeld.includes(x.symbol);
    if (!liquid.has(x.symbol) && !held) continue;
    const type = typeOf(x.desc ?? '', x.attchmntText ?? '');
    if (['routine', 'meeting', 'board-meet'].includes(type) || (type === 'management' && !held)) continue;
    work.push({ x, st, type, held, text: (x.attchmntText || '').replace(/\s+/g, ' ').slice(0, 600) });
  }
  if (first) { log(`Start: ${fresh.length} filings already out today marked as seen.`); first = false; }
  if (work.length) log(`${work.length} new filings to read: ${work.map((w) => w.x.symbol).join(', ')}`);
  await mapPool(work, 6, async (w) => {
    const g = await grade(w.x, w.text, w.type);
    state.graded++;
    log(`  ${w.x.symbol} [${w.type}] grade ${g.grade} str ${g.strength}: ${g.why}`);
    // bad news on a stock we hold -> get out
    if (g.grade === -1 && w.held) {
      (state.badNews ??= []).push({ symbol: w.x.symbol, why: g.why, at: w.st.t.slice(0, 5) });
      const t = open().find((t) => t.symbol === w.x.symbol);
      const b = await bars1(w.x.symbol);
      if (t && b?.last) await sell(t, b.last, 'BAD NEWS');
      else await notify(`BAD NEWS: ${w.x.symbol} - SELL if you hold it`, `${g.why}\n${w.x.desc}`, 'urgent', 'warning');
      return;
    }
    if (g.grade !== 2 || g.strength < RULE.minStrength) return;
    // never more than 3 buys in a day, counting this morning's TODAY'S BUY
    const morningBuys = await fetch(`${process.env.SUPABASE_URL}/rest/v1/radar?id=eq.1&select=payload`, { headers: { apikey: process.env.SUPABASE_SERVICE_KEY ?? '' } })
      .then((r) => r.json()).then((j) => { const f = j?.[0]?.payload?.news?.final; return f?.date === today ? f.picks.length : 0; }).catch(() => 0);
    if (state.trades.length + morningBuys >= RULE.maxBuys || state.trades.some((t) => t.symbol === w.x.symbol) || hhmmNow() > RULE.lastBuy) { log(`  (strong, but ${hhmmNow() > RULE.lastBuy ? 'too late in the day' : 'already have enough buys'})`); return; }
    // 2. price check: buyers stepping in, not already gone
    const b = await bars1(w.x.symbol);
    if (!b?.last || !b.prevClose) return;
    const atNews = b.bars.filter((k) => k.hhmm <= w.st.hhmm).at(-1)?.c ?? b.bars[0]?.o;
    const runUp = b.last / atNews - 1, dayUp = b.last / b.prevClose - 1;
    if (runUp >= RULE.maxRunUp || dayUp >= RULE.maxDayUp) { log(`  skip ${w.x.symbol}: already ran (${pct(runUp)} since news, ${pct(dayUp)} on the day)`); return; }
    if (runUp < -0.005) { log(`  skip ${w.x.symbol}: falling after the news (${pct(runUp)}) - sellers in charge`); return; }
    const delay = Math.round((Date.now() - w.st.ms) / 1000);
    if (delay > RULE.maxDelaySec) { log(`  skip ${w.x.symbol}: news is ${delay}s old - too late`); return; }
    const t = { symbol: w.x.symbol, px: b.last, peak: b.last, at: ist().toISOString().slice(11, 16), newsAt: w.st.t, delay, why: g.why, strength: g.strength };
    state.trades.push(t);
    await notify(`BUY NOW ${t.symbol} ~Rs ${t.px.toFixed(2)} (paper test)`,
      `${g.why} (strength ${g.strength}/10)\nNews at ${w.st.t}, alert ${delay}s later. Moved ${pct(runUp)} since news, ${pct(dayUp)} today.\n` +
      `Buy now (limit ~Rs ${(t.px * 1.003).toFixed(2)}). You get a SELL NOW when it falls 1.5% from its best. Do not chase if it is already far above.`, 'urgent', 'rocket');
    await save();
  });
  // 3. watch what we hold: sell when the push stops
  for (const t of open()) {
    const b = await bars1(t.symbol);
    if (!b?.last) continue;
    const after = b.bars.filter((k) => k.hhmm >= +t.at.replace(':', ''));
    t.peak = Math.max(t.peak, b.last, ...after.map((k) => k.h));
    if (b.last <= t.px * (1 - RULE.stop)) await sell(t, b.last, 'stop loss');
    else if (b.last <= t.peak * (1 - RULE.trail)) await sell(t, b.last, `push stopped: ${RULE.trail * 100}% off its best Rs ${t.peak.toFixed(2)}`);
    else if (hhmmNow() >= RULE.closeAll) await sell(t, b.last, 'end of day');
  }
  state.seen = [...seen];
  if (fresh.length) await save();
  await sleep(Math.max(2000, RULE.pollSec * 1000 - (Date.now() - loopStart)));
}

// end of the day: scorecard
await save();
if (hhmmNow() >= 1520) {
  const done = state.trades.filter((t) => t.ret != null);
  const all = [...(state.history ?? []).flatMap((h) => h.trades), ...done].filter((t) => t.ret != null);
  await notify(`Live radar ${today}: ${done.length ? done.map((t) => `${t.symbol} ${pct(t.ret)}`).join(', ') : 'no buys'}`,
    (done.length ? done.map((t) => `${t.symbol}: news ${t.newsAt}, alert +${t.delay}s, buy ${t.px.toFixed(2)} -> ${t.exit.toFixed(2)} (${t.how}) = ${pct(t.ret)}`).join('\n') : 'No strong news with buyers today.') +
    `\nRead ${state.graded} filings today.` + (all.length ? `\nSo far: ${all.length} trades, avg ${pct(all.reduce((s, x) => s + x.ret, 0) / all.length)} after costs, ${all.filter((x) => x.ret > 0).length} won.` : ''), 'low', 'clipboard');
}
