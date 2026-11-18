// Panic rebound (WATCH ONLY). Research (research/4-study.mjs, Jan 2025 - Nov 2026): a stock that fell 3%+ yesterday
// and opens 3-5% down again today, with no result or bad news overnight, tends to recover during the day.
// Buy in pre-open at the opening price, +7% target, -3% stop, otherwise sell at 3:20 pm. Max 3 picks, most traded first.
// Starts about 8:50 am, waits for pre-open prices (~9:04), alerts the phone, and first scores the previous picks.
import fs from 'node:fs';
import { fetchCached, preOpen, preOpenSnapshot, announcements } from './src/sources.mjs';
import { categorise } from './research/categories.mjs';
import { publishNews } from './src/app-publish.mjs';

const RULE = { panicMarket: -0.012, highMinCr: 20, yFall: -0.03, gapMax: -0.03, gapMin: -0.05, minCr: 3, maxPicks: 3, stop: 0.03, target: 0.07, limitAbove: 0.03, capitalRs: 10000 };
const BAD_NEWS = new Set(['result', 'legal', 'rating', 'fundraise']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ist = () => new Date(Date.now() + 19800e3);
const isoOf = (d) => d.toISOString().slice(0, 10);
const pct = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; };
// PANIC_SIMULATE=YYYY-MM-DD replays a past day (its real opening prices stand in for pre-open; no phone, no database).
const SIM = process.env.PANIC_SIMULATE;
const today = SIM ?? isoOf(ist());

// ---- full-market daily files (NSE archive), newest first, skipping holidays ----
async function bhav(iso) {
  const [y, m, d] = iso.split('-');
  const csv = await fetchCached(`https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${d}${m}${y}.csv`, { ttlHours: 1e7, attempts: 2 }).catch(() => null);
  if (!csv?.startsWith('SYMBOL')) return null;
  const lines = csv.trim().split(/\r?\n/), head = lines[0].split(',').map((x) => x.trim()), c = (n) => head.indexOf(n);
  // On holidays NSE serves another day's file: use it only if the date inside matches.
  const MON = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  const [fd, fm, fy] = (lines[1]?.split(',')[c('DATE1')] ?? '').trim().split('-');
  if (`${fy}-${MON[fm]}-${fd}` !== iso) return null;
  const map = new Map();
  for (const line of lines.slice(1)) {
    const p = line.split(',').map((x) => x.trim());
    if (p[c('SERIES')] !== 'EQ' && p[c('SERIES')] !== 'BE') continue;
    map.set(p[c('SYMBOL')], { prev: +p[c('PREV_CLOSE')], open: +p[c('OPEN_PRICE')], high: +p[c('HIGH_PRICE')], low: +p[c('LOW_PRICE')], close: +p[c('CLOSE_PRICE')], cr: +p[c('TURNOVER_LACS')] / 100, t2t: p[c('SERIES')] === 'BE' });
  }
  return map;
}
const sessions = []; // [{ iso, data }], newest first, before today
for (let d = new Date(Date.parse(today) - 864e5); sessions.length < 21 && Date.parse(today) - d < 50 * 864e5; d = new Date(+d - 864e5)) {
  if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
  const data = await bhav(isoOf(d));
  if (data) sessions.push({ iso: isoOf(d), data });
}
if (sessions.length < 15) throw new Error(`Only ${sessions.length} past sessions found in the NSE archive`);
const yday = sessions[0];

// ---- Supabase: row 3 keeps today's picks and the history of results ----
const sb = !SIM && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY ? { url: `${process.env.SUPABASE_URL}/rest/v1/radar`, key: process.env.SUPABASE_SERVICE_KEY } : null;
const stored = sb ? (await (await fetch(`${sb.url}?id=eq.3&select=payload`, { headers: { apikey: sb.key } })).json())?.[0]?.payload ?? {} : {};
const state = { today: stored.today ?? null, history: stored.history ?? [] };
const save = async () => {
  if (!sb) return;
  const res = await fetch(sb.url, { method: 'POST', headers: { apikey: sb.key, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ id: 3, payload: state, updated_at: new Date().toISOString() }) });
  if (!res.ok) throw new Error(`Supabase save failed: ${res.status} ${await res.text()}`);
  // the app's News tab
  const t = state.today ?? {};
  await publishNews('panic', { date: t.date, marketGap: t.marketGap, panicMorning: t.panicMorning, picks: (t.picks ?? []).map(({ symbol, tier, yRet, gap, iep, limit, stopPrice, targetPrice, result, howEnded }) => ({ symbol, tier, yRet, gap, iep, limit, stopPrice, targetPrice, result, howEnded })), history: state.history.slice(-30) });
};
const topic = SIM ? null : process.env.NTFY_TOPIC;
const notify = async (title, body, priority = 'default', tags = 'chart_with_upwards_trend') => {
  console.log(`\n[${title}]\n${body}`);
  if (topic) await fetch(`https://ntfy.sh/${topic}`, { method: 'POST', body, headers: { Title: title, Priority: priority, Tags: tags } }).catch(() => {});
};

// ---- 1. score the last picks with what really happened that day ----
if (state.today && state.today.date < today && !state.today.scored) {
  const day = sessions.find((s) => s.iso === state.today.date);
  if (day) {
    const lines = [];
    for (const p of state.today.picks) {
      const t = day.data.get(p.symbol);
      if (!t) continue;
      const stop = t.open * (1 - RULE.stop), tgt = p.tier === 'high' ? Infinity : t.open * (1 + RULE.target); // high tier: no target, hold to 3:20 pm
      const ret = t.low <= stop ? -RULE.stop : t.high >= tgt ? RULE.target : t.close / t.open - 1;
      Object.assign(p, { open: t.open, high: t.high, low: t.low, close: t.close, result: ret, howEnded: t.low <= stop ? 'stop' : t.high >= tgt ? 'target' : '3:20 pm' });
      lines.push(`${p.tier === 'high' ? 'HIGH ' : ''}${p.symbol}: opened ${t.open}, ${p.howEnded} -> ${pct(ret)} (pre-open showed ${p.iep})`);
    }
    state.today.scored = true;
    const done = state.today.picks.filter((p) => p.result != null);
    state.history.push({ date: state.today.date, picks: done.map(({ symbol, tier, iep, open, result, howEnded }) => ({ symbol, tier, iep, open, result, howEnded })), day: done.length ? done.reduce((s, p) => s + p.result, 0) / done.length : null });
    const all = state.history.flatMap((h) => h.picks);
    const avg = all.length ? all.reduce((s, p) => s + p.result, 0) / all.length : 0;
    if (lines.length) await notify(`Panic rebound: ${state.today.date} scorecard`, `${lines.join('\n')}\nBasket ${pct(state.history.at(-1).day)} before costs. So far: ${all.length} picks, avg ${pct(avg)}, ${all.filter((p) => p.result > 0).length} won.`, 'low', 'clipboard');
    await save();
  }
}

if (state.today?.date === today && !SIM) { console.log('Already ran today.'); process.exit(0); }

// ---- 2. wait for pre-open prices (about 9:04) ----
const nowMins = () => ist().getUTCHours() * 60 + ist().getUTCMinutes();
let pre = new Map();
if (SIM) {
  const real = await bhav(SIM);
  if (!real) throw new Error('No NSE file for ' + SIM);
  for (const [k, v] of real) pre.set(k, { iep: v.open, time: '' });
} else {
const wd = ist().getUTCDay();
if (wd === 0 || wd === 6) { console.log('Weekend, nothing to do.'); process.exit(0); }
if (nowMins() > 9 * 60 + 12) { console.log('Too late for pre-open today.'); process.exit(0); }
while (nowMins() < 9 * 60 + 4) await sleep(15000);
const nseDay = (() => { const [y, m, d] = today.split('-'); return `${d}-${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m - 1]}-${y}`; })();
for (let tries = 0; tries < 8; tries++) {
  pre = await preOpen(0).catch(() => new Map());
  if ([...pre.values()].some((p) => p.time.startsWith(nseDay))) break;
  if (nowMins() >= 9 * 60 + 8) break;
  await sleep(15000);
}
if (![...pre.values()].some((p) => p.time.startsWith(nseDay))) {
  await notify('Panic rebound: no pre-open prices', 'Could not read today\'s pre-open prices (market holiday, or the NSE website is not answering). No picks today.', 'low', 'warning');
  process.exit(0);
}
}

// ---- 3. find candidates ----
// Market mood: the typical liquid stock's opening move. -1.2% or worse = market panic morning (the high-confidence tier).
const liqOf = new Map();
for (const symbol of yday.data.keys()) liqOf.set(symbol, median(sessions.slice(0, 20).map((s) => s.data.get(symbol)?.cr ?? 0)));
const gaps = [];
for (const [symbol, y] of yday.data) { const p = pre.get(symbol); if (p?.iep && y.close && liqOf.get(symbol) >= 2) gaps.push(p.iep / y.close - 1); }
const marketGap = median(gaps);
const panicMorning = gaps.length > 200 && marketGap <= RULE.panicMarket;
console.log(`Market opening ${pct(marketGap)} (${gaps.length} stocks). ${panicMorning ? 'PANIC MORNING' : 'normal morning'}`);

const candidates = [];
for (const [symbol, y] of yday.data) {
  const p = pre.get(symbol);
  if (!p?.iep || !y.prev || y.t2t) continue; // T2T (series BE): no same-day sell, so never an intraday pick (HFCL, Nov 18 2026)
  const yRet = y.close / y.prev - 1, gap = p.iep / y.close - 1, liq = liqOf.get(symbol);
  if (gap > RULE.gapMax || gap <= RULE.gapMin + 0.0005) continue; // -5% is often the lower circuit: tested negative
  // HIGH: panic morning + big, heavily traded stock (tested on clean data: 10 of 10 days won, Jan 2025 - Nov 2026). NORMAL: fell 3%+ yesterday too (watch only).
  const tier = panicMorning && liq >= RULE.highMinCr ? 'high' : yRet <= RULE.yFall && liq >= RULE.minCr && p.iep <= RULE.capitalRs / RULE.maxPicks ? 'normal' : null;
  if (tier) candidates.push({ symbol, tier, yRet, gap, iep: p.iep, liq });
}
// overnight news check: anything filed after yesterday's close
let news = new Map(), newsChecked = !SIM;
if (!SIM) try {
  for (const a of await announcements(yday.iso, today, 0)) {
    if (!candidates.some((c) => c.symbol === a.symbol)) continue;
    const cat = categorise(a.desc ?? '', a.attchmntText ?? '');
    (news.get(a.symbol) ?? news.set(a.symbol, []).get(a.symbol)).push(cat);
  }
} catch { newsChecked = false; }
const round = (v) => Math.round(v * 20) / 20;
const choose = (tier) => candidates
  .filter((c) => c.tier === tier && !(news.get(c.symbol) ?? []).some((cat) => BAD_NEWS.has(cat)))
  .sort((a, b) => b.liq - a.liq)
  .slice(0, RULE.maxPicks)
  .map((c) => ({ ...c, limit: round(c.iep * (1 + RULE.limitAbove)), stopPrice: round(c.iep * (1 - RULE.stop)), targetPrice: tier === 'high' ? null : round(c.iep * (1 + RULE.target)), otherNews: news.get(c.symbol) ?? [] }));
const high = choose('high'), normal = high.length ? [] : choose('normal');
const picks = [...high, ...normal];
console.log(`${candidates.length} candidates, ${high.length} high, ${normal.length} normal. News ${newsChecked ? 'checked' : 'NOT checked'}.`);

state.today = { date: today, picks, marketGap, panicMorning, candidates: candidates.length, newsChecked, generated: new Date().toISOString() };
await save();
const per = RULE.capitalRs / Math.max(picks.length, 1);
const qty = (p) => (Math.floor(per / p.iep) > 0 ? `qty ${Math.floor(per / p.iep)}` : `1 share = Rs ${p.iep}, above your Rs ${Math.round(per)} per stock`);
const newsNote = newsChecked ? '' : ' (Overnight news could NOT be checked today.)';
const NL = String.fromCharCode(10);
if (high.length) {
  const body = [`Whole market opening ${pct(marketGap)}: panic morning. Past record: 10 of 10 such days won (small sample).`,
    ...high.map((p) => `${p.symbol}: opening ${pct(p.gap)}. Pre-open BUY limit Rs ${p.limit} (${qty(p)}). Stop Rs ${p.stopPrice}, sell at 3:20 pm.`),
    `Check for bad news first.${newsNote}`].join(NL);
  await notify(`HIGH CONFIDENCE: market panic, ${high.length} pick${high.length > 1 ? 's' : ''} (pre-open closes 9:07)`, body, 'min', 'green_circle'); // TODAY'S BUY (today-picks.mjs) sends it loud
} else if (normal.length) {
  const body = [...normal.map((p) => `${p.symbol}: yesterday ${pct(p.yRet)}, opening ${pct(p.gap)}. Pre-open BUY limit Rs ${p.limit} (${qty(p)}). Stop Rs ${p.stopPrice}, target Rs ${p.targetPrice}, else sell 3:20 pm.`),
    `NORMAL level: WATCH ONLY, no money.${newsNote}`].join(NL);
  await notify(`Panic rebound (watch only): ${normal.length} pick${normal.length > 1 ? 's' : ''}`, body, 'min', 'white_circle');
} else {
  await notify('Panic rebound: no picks today', `Market opening ${pct(marketGap)}. Nothing matched. No trade is a fine answer.`, 'min', 'zzz');
}

// ---- 4. save the pre-open book for future research (buy/sell quantities waiting at the auction) ----
// One snapshot now (~9:05) and one after the auction closes (~9:08:45, final opening prices). The workflow pushes
// data/preopen/ to the preopen-data branch. Never blocks the alert above.
if (!SIM) {
  try {
    const earlyAt = new Date().toISOString(), early = await preOpenSnapshot();
    while (nowMins() < 9 * 60 + 8 || (nowMins() === 9 * 60 + 8 && ist().getUTCSeconds() < 45)) await sleep(5000);
    const finalAt = new Date().toISOString(), final = await preOpenSnapshot();
    fs.mkdirSync('data/preopen', { recursive: true });
    fs.writeFileSync(`data/preopen/${today}.json`, JSON.stringify({ early: { at: earlyAt, book: early }, final: { at: finalAt, book: final } }));
    console.log(`Saved pre-open book: ${Object.keys(final).length} stocks.`);
  } catch (e) { console.log(`Pre-open book not saved: ${e.message}`); }
}
