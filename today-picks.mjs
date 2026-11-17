// TODAY'S BUY: one simple message at about 9:05 am. It takes the three tested morning strategies, ranks them by how
// strong their past record is, and sends at most 3 stocks (only the strongest level present, so a lone strong pick
// stays alone). No strong signal = "No buy today": forcing weak picks lost money in every test (research/19, 20).
//   Very strong: Panic rebound HIGH (market panic morning; 10 of 10 days won, small sample)
//                Gap & Go GO (results beat both quarters, opens +5..+20%; tested 2 years)
//   Strong:      News + pre-open +5..+15% (one month: +1.2% avg per trade)
//   Medium:      Panic rebound normal (fell 3%+ yesterday, opens -3..-5%)
// The live radar adds BUY NOW during the day, but never more than 3 buys in a day in total.
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, NTFY_TOPIC. Reads what the other morning jobs wrote to the app row.
import { holidays } from './src/sources.mjs';
import { publishNews } from './src/app-publish.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ist = () => new Date(Date.now() + 19800e3);
const today = ist().toISOString().slice(0, 10);
const secs = () => { const n = ist(); return n.getUTCHours() * 3600 + n.getUTCMinutes() * 60 + n.getUTCSeconds(); };
const pct = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
const rs = (v) => `Rs ${Math.round(v * 20) / 20}`;
const topic = process.env.NTFY_TOPIC;
const notify = async (title, body, priority, tags) => {
  console.log(`[${title}]\n${body}\n`);
  if (topic) await fetch(`https://ntfy.sh/${topic}`, { method: 'POST', body, headers: { Title: title, Priority: priority, Tags: tags } }).catch(() => {});
};
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) throw new Error('Needs SUPABASE_URL and SUPABASE_SERVICE_KEY');
const readApp = async () => (await (await fetch(`${url}/rest/v1/radar?id=eq.1&select=payload`, { headers: { apikey: key } })).json())?.[0]?.payload ?? {};

const d = new Date(today + 'T00:00:00Z').getUTCDay();
if (d === 0 || d === 6 || (await holidays().catch(() => new Set())).has(today)) { console.log('Not a trading day.'); process.exit(0); }
if (secs() > 9 * 3600 + 7 * 60) { console.log('Too late: pre-open is over.'); process.exit(0); }
{ const p = await readApp(); if (p.news?.final?.date === today && p.news.final.sent) { console.log('Already sent today.'); process.exit(0); } }

function collect(p) {
  const all = [];
  const g = p.gapgo?.date === today && p.gapgo.preOpenReady ? p.gapgo : null;
  for (const c of g?.candidates ?? []) if (c.status === 'go' && c.openPrice)
    all.push({ symbol: c.symbol, level: 3, kind: 'Gap & Go', why: `Results beat last quarter (${pct(c.qoq ?? 0)}) and last year (${pct(c.yoy ?? 0)}), opening ${pct(c.gap)}`,
      limit: Math.round(c.openPrice * 1.01 * 20) / 20, stop: c.stopPrice, target: c.targetPrice, sell: `Sell UP at ${rs(c.targetPrice)}, sell DOWN at ${rs(c.stopPrice)}, else 3:20 pm` });
  const pr = p.news?.panic?.date === today ? p.news.panic : null;
  for (const x of pr?.picks ?? []) all.push({ symbol: x.symbol, level: x.tier === 'high' ? 3 : 1, kind: x.tier === 'high' ? 'Panic rebound HIGH' : 'Panic rebound',
    why: x.tier === 'high' ? `Whole market panicking (${pct(pr.marketGap)}), big stock opening ${pct(x.gap)}: usually bounces` : `Fell ${pct(x.yRet)} yesterday, opening ${pct(x.gap)} again, no bad news`,
    limit: x.limit, stop: x.stopPrice, target: x.targetPrice, sell: `Sell DOWN at ${rs(x.stopPrice)}${x.targetPrice ? `, sell UP at ${rs(x.targetPrice)}` : ''}, else 3:20 pm` });
  const np = p.news?.picks?.date === today ? p.news.picks : null;
  for (const b of np?.openBuys ?? []) all.push({ symbol: b.symbol, level: 2, kind: 'Strong news', why: `${b.why} (pre-open ${pct(b.gap)})`,
    limit: b.limit, sell: 'Sell when it falls 1.5% from its best price, else 3:20 pm' });
  // one entry per stock (keep its strongest reason)
  const best = new Map();
  for (const x of all.sort((a, b) => b.level - a.level)) if (!best.has(x.symbol)) best.set(x.symbol, x);
  const top = Math.max(0, ...[...best.values()].map((x) => x.level));
  return { picks: [...best.values()].filter((x) => x.level === top).slice(0, 3), ready: { gapgo: !!g, panic: !!pr, news: !!np?.preopenDone } };
}

// wait for the other morning jobs (they read pre-open at about 9:03-9:05), then send by 9:05:30
while (secs() < 9 * 3600 + 5 * 60 + 30) {
  const { ready } = collect(await readApp());
  if (secs() >= 9 * 3600 + 4 * 60 + 30 && ready.gapgo && ready.panic && ready.news) break;
  await sleep(10000);
}
let { picks, ready } = collect(await readApp());
const LEVEL = { 3: 'VERY STRONG', 2: 'STRONG', 1: 'MEDIUM - small money only' };
const send = async (list, update) => {
  if (!list.length) {
    await notify("TODAY'S BUY: none", `No strong signal this morning, so no buy. Keeping cash IS the strategy on weak days.\nThe live radar watches news all day and sends BUY NOW if something strong comes.${Object.values(ready).every(Boolean) ? '' : '\n(Some morning checks did not finish in time.)'}`, 'default', 'zzz');
    return;
  }
  const body = list.map((x, i) => `${i + 1}. ${x.symbol} - ${LEVEL[x.level]} (${x.kind})\n   ${x.why}\n   BUY: limit ${rs(x.limit)} in pre-open NOW (before 9:07)\n   SELL: ${x.sell}`).join('\n\n') +
    `\n\nIf it opens above your limit you are not filled: do not chase. Intraday only, never hold overnight.`;
  await notify(`${update ? 'UPDATE - ' : ''}TODAY'S BUY: ${list.map((x) => x.symbol).join(', ')}`, body, 'urgent', 'rocket');
};
await send(picks, false);
await publishNews('final', { date: today, sent: true, picks, ready });
// late arrivals until pre-open closes (9:07): send an update only if the list got stronger or a slot was free
const sentSyms = new Set(picks.map((x) => x.symbol));
while (secs() < 9 * 3600 + 6 * 60 + 50) {
  await sleep(10000);
  const now = collect(await readApp());
  if (now.picks.some((x) => !sentSyms.has(x.symbol))) {
    picks = now.picks; ready = now.ready;
    await send(picks, true);
    picks.forEach((x) => sentSyms.add(x.symbol));
    await publishNews('final', { date: today, sent: true, picks, ready });
  }
}
