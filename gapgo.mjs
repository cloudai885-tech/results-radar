// Gap-and-go check. Runs through the evening/night (new results alert the phone at once) and at 8:30 / 9:03 am.
// Rule, tested on Nov 2024 - Nov 2026: result beat BOTH last quarter and last year, stock opens 5-20% up,
// buy at the open, take +7% profit or stop at -3%, else sell by 3:20 pm. Watch-only: the app shows it, nothing is traded.
import fs from 'node:fs';
import { nifty500, announcements, preOpen, fundamentals, dailyBars, holidays, mapPool } from './src/sources.mjs';
import { targetQuarter } from './src/score.mjs';

const RULES = { minGap: 0.05, maxGap: 0.2, stop: 0.03, target: 0.07, capitalRs: 20000, minTradedValueRs: 5e7 };
const BACKTEST = { trades: 98, avgPerTrade: 0.0118, winRate: 0.49, period: 'Nov 2024 - Nov 2026' };

const nowIst = new Date(Date.now() + 19800e3);
const calendarDay = nowIst.toISOString().slice(0, 10);
const nowMins = nowIst.getUTCHours() * 60 + nowIst.getUTCMinutes();
const closed = await holidays();
const isSession = (iso) => { const wd = new Date(iso).getUTCDay(); return wd !== 0 && wd !== 6 && !closed.has(iso); };
const step = (iso, d) => new Date(Date.parse(iso) + d * 864e5).toISOString().slice(0, 10);
// The session these results will trade in: today before the close, otherwise the next market day.
let today = calendarDay;
if (!isSession(today) || nowMins >= 930) { do today = step(today, 1); while (!isSession(today)); }
const evening = today !== calendarDay;
let prevSession = today;
do prevSession = step(prevSession, -1); while (!isSession(prevSession));
const dayName = new Date(today).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const parseTime = (s) => {
  const m = /(\d+)-(\w{3})-(\d{4}) (\d+):(\d+)/.exec(s ?? '');
  return m ? { date: new Date(Date.UTC(+m[3], MON[m[2]], +m[1])).toISOString().slice(0, 10), mins: +m[4] * 60 + +m[5], hhmm: `${m[4].padStart(2, '0')}:${m[5]}` } : null;
};
const nseDay = (iso) => { const [y, m, d] = iso.split('-'); return `${d}-${Object.keys(MON)[+m - 1]}-${y}`; };

// Results published after the last close (3:30 pm) and before today's open (9:15 am).
const universe = new Map((await nifty500()).map((c) => [c.symbol, c]));
const overnight = new Map();
for (const a of await announcements(prevSession, calendarDay)) {
  if (!universe.has(a.symbol)) continue;
  if (!/Financial Result|Outcome of Board Meeting|Integrated Filing- Financial/i.test(a.desc) || !/result/i.test(a.attchmntText ?? '')) continue;
  const t = parseTime(a.an_dt);
  if (!t) continue;
  const isOvernight = (t.date === prevSession && t.mins >= 930) || (t.date > prevSession && t.date < today) || (t.date === today && t.mins < 555);
  if (!isOvernight) continue;
  const seen = overnight.get(a.symbol);
  if (!seen || t.date + t.hhmm < seen.date + seen.hhmm) overnight.set(a.symbol, t);
}

const pre = await preOpen();
const preOpenReady = [...pre.values()].some((p) => p.time.startsWith(nseDay(today)));
const growth = (a, b) => (a == null || b == null ? null : b > 0 ? (a - b) / b : a > b ? 1 : -1);
const pct = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// Earlier runs for the same session: reuse their result numbers (fewer Screener calls) and their sent alerts.
const sb = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY ? { url: `${process.env.SUPABASE_URL}/rest/v1/radar`, key: process.env.SUPABASE_SERVICE_KEY } : null;
const current = sb ? await (await fetch(`${sb.url}?id=eq.1&select=payload`, { headers: { apikey: sb.key } })).json() : null;
const before = current?.[0]?.payload?.gapgo?.date === today ? current[0].payload.gapgo : null;
const known = new Map((before?.candidates ?? []).filter((c) => c.qoq != null && c.yoy != null).map((c) => [c.symbol, c]));

const rows = (await mapPool([...overnight.keys()], 3, async (symbol) => {
  const t = overnight.get(symbol);
  const old = known.get(symbol);
  const [f, bars] = await Promise.all([old ? null : fundamentals(symbol, 1), dailyBars(`${symbol}.NS`, '3mo', 6)]);
  const T = targetQuarter(t.date);
  const pat = (o) => (old ? (o === T ? 1 : undefined) : f?.quarters.get(o)?.pat);
  const qoq = old ? old.qoq : growth(pat(T), pat(T - 1)), yoy = old ? old.yoy : growth(pat(T), pat(T - 4));
  const p = pre.get(symbol);
  const gap = preOpenReady && p?.iep && p?.prevClose ? p.iep / p.prevClose - 1 : null;
  const traded = bars?.length >= 20 ? median(bars.slice(-20).map((b) => b.close * b.volume)) : null;
  let status = 'skip', reason;
  if (pat(T) == null) reason = 'New quarter numbers not available yet';
  else if (qoq <= 0 && yoy <= 0) reason = 'Profit fell vs last quarter and last year';
  else if (qoq <= 0) reason = `Did not beat last quarter (${pct(qoq)})`;
  else if (yoy <= 0) reason = `Did not beat last year (${pct(yoy)})`;
  else if (gap == null) { status = 'watch'; reason = evening ? `Good result. Check at 9:03 am ${dayName}: buy only if it opens 5-20% up` : 'Good result. Check its opening price after 9:00 am'; }
  else if (gap < RULES.minGap) reason = `Opening ${pct(gap)}, needs +5% or more`;
  else if (gap >= RULES.maxGap) reason = `Opening ${pct(gap)}, too big a jump`;
  else if (traded != null && traded < RULES.minTradedValueRs) reason = 'Too little trading to get in and out';
  else { status = 'go'; reason = 'Fits gap-and-go'; }
  return {
    symbol, company: universe.get(symbol).company, announced: `${t.date} ${t.hhmm}`,
    qoq, yoy, gap, openPrice: p?.iep ?? null, prevClose: p?.prevClose ?? null,
    stopPrice: p?.iep ? Math.round(p.iep * (1 - RULES.stop) * 100) / 100 : null,
    targetPrice: p?.iep ? Math.round(p.iep * (1 + RULES.target) * 100) / 100 : null, status, reason,
  };
})).filter((r) => r && !r.error).sort((a, b) => ['go', 'watch', 'skip'].indexOf(a.status) - ['go', 'watch', 'skip'].indexOf(b.status) || (b.gap ?? -9) - (a.gap ?? -9));

const notified = new Set(before?.notified ?? []);

// Phone notification through ntfy.sh (free app, no account or phone number). Only when NTFY_TOPIC is set.
const topic = process.env.NTFY_TOPIC;
const fresh = rows.filter((r) => (r.status === 'go' || r.status === 'watch') && !notified.has(`${r.status}:${r.symbol}`));
if (topic && fresh.length) {
  const go = fresh.filter((r) => r.status === 'go'), watch = fresh.filter((r) => r.status === 'watch');
  const perStock = RULES.capitalRs / Math.min(Math.max(rows.filter((r) => r.status === 'go').length, 1), 2);
  const lines = [
    ...go.map((r) => `GO ${r.symbol}: buy ${Math.floor(perStock / r.openPrice)} at Rs ${Math.round(r.openPrice * 1.01)} (intraday). Sell up Rs ${r.targetPrice}, sell down Rs ${r.stopPrice}, else 3:20 pm.`),
    ...watch.map((r) => `${r.symbol} (${r.company}): good result at ${r.announced.slice(11)}. Profit vs last qtr ${pct(r.qoq)}, vs last year ${pct(r.yoy)}. Check at 9:03 am ${evening ? dayName : 'today'}: buy only if it opens 5-20% up.`),
  ];
  const res = await fetch(`https://ntfy.sh/${topic}`, { method: 'POST', body: lines.join('\n'), headers: { Title: go.length ? `Gap & Go: ${go.length} GO today` : `Good result${watch.length > 1 ? 's' : ''}: ${watch.map((r) => r.symbol).join(', ')}`, Priority: go.length ? 'high' : 'default', Tags: go.length ? 'rocket' : 'eyes' } });
  console.log(res.ok ? `Phone notified: ${fresh.length}` : `Notification failed: ${res.status}`);
  if (res.ok) fresh.forEach((r) => notified.add(`${r.status}:${r.symbol}`));
}

const gapgo = { date: today, generated: new Date().toISOString(), preOpenReady, rules: RULES, backtest: BACKTEST, candidates: rows, notified: [...notified] };
fs.writeFileSync(new URL('./app/gapgo.json', import.meta.url), JSON.stringify(gapgo, null, 1));
console.log(`${today}: ${overnight.size} overnight results, pre-open ${preOpenReady ? 'ready' : 'NOT ready'}`);
for (const r of rows) console.log(r.status === 'go' ? 'GO  ' : '    ', r.symbol.padEnd(12), r.gap != null ? pct(r.gap).padStart(7) : '      -', '|', r.reason);

// Merge into the app's Supabase row without touching the rest of the data.
if (sb) {
  const { url, key } = sb;
  const payload = { ...(current?.[0]?.payload ?? {}), gapgo };
  const res = await fetch(url, { method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ id: 1, payload, updated_at: new Date().toISOString() }) });
  if (!res.ok) throw new Error(`Supabase upload failed: ${res.status} ${await res.text()}`);
  console.log('Uploaded to Supabase.');
}
