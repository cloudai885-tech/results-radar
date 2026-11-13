// Live watcher for results announced DURING market hours (Nifty 500), checked every minute.
// Test (Sep-Nov 2026): buying within 2-15 minutes of a result that beat both last quarter and last year averaged
// +0.7% to +1.1% per trade; one hour late it fell to +0.3%. NSE's clean numbers arrive hours late, so the alert gives
// the profit figure to beat (from Screener history) and the result PDF: you check one line and decide in a minute.
// Watch-only. Runs until STOP_AT (IST, e.g. "12:30") or 14:35.
import { nifty500, eventCalendar, announcements, fundamentals, holidays } from './src/sources.mjs';
import { targetQuarter } from './src/score.mjs';

const STOP_AT = process.env.STOP_AT ?? '14:35';
// Stocks you own (comma list in HOLD): alerted at any time of day, good or bad, so you can act on them.
const HOLD = new Set((process.env.HOLD ?? '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean));
const LAST_ALERT_MINS = 14 * 60 + 30; // later than 2:30 pm leaves too little time in the day
const ist = () => new Date(Date.now() + 19800e3);
const minsNow = () => ist().getUTCHours() * 60 + ist().getUTCMinutes();
const toMins = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const today = ist().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const closed = await holidays();
const wd = new Date(today).getUTCDay();
if (wd === 0 || wd === 6 || closed.has(today)) { console.log('Market closed today.'); process.exit(0); }

const topic = process.env.NTFY_TOPIC;
const sb = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY ? { url: `${process.env.SUPABASE_URL}/rest/v1/radar`, key: process.env.SUPABASE_SERVICE_KEY } : null;

// Alerts already sent today (shared between the morning and afternoon jobs), kept in row id=2.
let seen = new Set();
if (sb) {
  const r = await (await fetch(`${sb.url}?id=eq.2&select=payload`, { headers: { apikey: sb.key } })).json();
  if (r?.[0]?.payload?.date === today) seen = new Set(r[0].payload.seen);
}
const saveSeen = async () => {
  if (!sb) return;
  await fetch(sb.url, { method: 'POST', headers: { apikey: sb.key, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ id: 2, payload: { date: today, seen: [...seen] }, updated_at: new Date().toISOString() }) });
};

const universe = new Map((await nifty500()).map((c) => [c.symbol, c]));
const T = targetQuarter(today);
const crore = (v) => `Rs ${v.toLocaleString('en-IN', { maximumFractionDigits: 1 })} Cr`;

// Profit to beat, loaded ahead for companies with a results meeting today.
const bar = new Map();
async function profitToBeat(symbol) {
  if (bar.has(symbol)) return bar.get(symbol);
  const f = await fundamentals(symbol, 12).catch(() => null);
  const q = (o) => f?.quarters.get(o)?.pat;
  const v = { lastQtr: q(T - 1), lastYear: q(T - 4), ready: q(T) != null };
  bar.set(symbol, v);
  return v;
}
const todays = (await eventCalendar()).filter((e) => e.date === today && universe.has(e.symbol)).map((e) => e.symbol);
console.log(`${today}: ${todays.length} Nifty 500 results meetings today. Loading their past profits...`);
for (const s of todays) await profitToBeat(s);

const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const filedMins = (s) => { const m = /(\d+)-(\w{3})-(\d{4}) (\d+):(\d+)/.exec(s ?? ''); return m && new Date(Date.UTC(+m[3], MON[m[2]], +m[1])).toISOString().slice(0, 10) === today ? +m[4] * 60 + +m[5] : null; };

async function check() {
  const list = await announcements(today, today, 0);
  for (const a of list) {
    const mine = HOLD.has(a.symbol);
    if ((!universe.has(a.symbol) && !mine) || seen.has(a.symbol)) continue;
    if (!/Financial Result|Outcome of Board Meeting|Integrated Filing- Financial/i.test(a.desc) || !/result/i.test(a.attchmntText ?? '')) continue;
    const at = filedMins(a.an_dt);
    if (at == null || (!mine && (at < 555 || at > LAST_ALERT_MINS))) continue;
    seen.add(a.symbol);
    const p = await profitToBeat(a.symbol);
    const lag = minsNow() - at;
    const need = p.lastQtr != null && p.lastYear != null ? Math.max(p.lastQtr, p.lastYear) : null;
    const lines = [
      need != null
        ? `GOOD only if quarterly net profit (consolidated) is above ${crore(need)}  (last quarter ${crore(p.lastQtr)}, same quarter last year ${crore(p.lastYear)}).`
        : 'Past profit not available: check the result yourself.',
      mine ? 'You own this. Send me the numbers and I will tell you hold or sell.' : 'If good: buy within 15 min of the result, sell at +7% or -3%, else by 3:20 pm. If not: skip.',
      a.voiceSummary ? `NSE summary: ${a.voiceSummary.slice(0, 300)}` : '',
      lag > 15 ? `Note: this alert is ${lag} min after the filing, which is late. Skip it.` : '',
    ].filter(Boolean);
    console.log(`${a.an_dt} ${a.symbol} (alert ${lag} min after filing)`);
    if (topic) {
      const r = await fetch(`https://ntfy.sh/${topic}`, { method: 'POST', body: lines.join('\n'),
        headers: { Title: `${mine ? 'YOUR STOCK ' : ''}RESULT OUT ${a.symbol} at ${a.an_dt.slice(12, 17)}`, Priority: 'urgent', Tags: 'zap', ...(a.attchmntFile ? { Click: a.attchmntFile, Actions: `view, Open result PDF, ${a.attchmntFile}` } : {}) } });
      if (!r.ok) console.log('notify failed', r.status);
    }
    await saveSeen();
  }
}

// Started late by hand: do not alert old filings from earlier today (your own stocks still alert).
if (process.env.SKIP_EXISTING) for (const x of await announcements(today, today, 0)) if (!HOLD.has(x.symbol)) seen.add(x.symbol);

while (minsNow() < toMins(STOP_AT)) {
  const start = Date.now();
  try { await check(); } catch (e) { console.log('check failed:', e.message); }
  await sleep(Math.max(5000, 60000 - (Date.now() - start)));
}
console.log('Stopped at', STOP_AT);
