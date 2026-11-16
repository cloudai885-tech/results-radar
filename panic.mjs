// Panic rebound (WATCH ONLY). Research (research/4-study.mjs, Jan 2025 - Nov 2026): a stock that fell 3%+ yesterday
// and opens 3-5% down again today, with no result or bad news overnight, tends to recover during the day.
// Buy in pre-open at the opening price, +7% target, -3% stop, otherwise sell at 3:20 pm. Max 3 picks, most traded first.
// Starts about 8:50 am, waits for pre-open prices (~9:04), alerts the phone, and first scores the previous picks.
import { fetchCached, preOpen, announcements } from './src/sources.mjs';
import { categorise } from './research/categories.mjs';

const RULE = { yFall: -0.03, gapMax: -0.03, gapMin: -0.05, minCr: 3, maxPicks: 3, stop: 0.03, target: 0.07, limitAbove: 0.005, capitalRs: 10000 };
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
  const map = new Map();
  for (const line of lines.slice(1)) {
    const p = line.split(',').map((x) => x.trim());
    if (p[c('SERIES')] !== 'EQ' && p[c('SERIES')] !== 'BE') continue;
    map.set(p[c('SYMBOL')], { prev: +p[c('PREV_CLOSE')], open: +p[c('OPEN_PRICE')], high: +p[c('HIGH_PRICE')], low: +p[c('LOW_PRICE')], close: +p[c('CLOSE_PRICE')], cr: +p[c('TURNOVER_LACS')] / 100 });
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
      const stop = t.open * (1 - RULE.stop), tgt = t.open * (1 + RULE.target);
      const ret = t.low <= stop ? -RULE.stop : t.high >= tgt ? RULE.target : t.close / t.open - 1;
      Object.assign(p, { open: t.open, high: t.high, low: t.low, close: t.close, result: ret, howEnded: t.low <= stop ? 'stop' : t.high >= tgt ? 'target' : '3:20 pm' });
      lines.push(`${p.symbol}: opened ${t.open}, ${p.howEnded} -> ${pct(ret)} (pre-open showed ${p.iep})`);
    }
    state.today.scored = true;
    const done = state.today.picks.filter((p) => p.result != null);
    state.history.push({ date: state.today.date, picks: done.map(({ symbol, iep, open, result, howEnded }) => ({ symbol, iep, open, result, howEnded })), day: done.length ? done.reduce((s, p) => s + p.result, 0) / done.length : null });
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
if (![...pre.values()].some((p) => p.time.startsWith(nseDay))) { console.log('Pre-open prices for today not available (holiday?).'); process.exit(0); }
}

// ---- 3. find candidates ----
const candidates = [];
for (const [symbol, y] of yday.data) {
  const p = pre.get(symbol);
  if (!p?.iep || !y.prev) continue;
  const yRet = y.close / y.prev - 1, gap = p.iep / y.close - 1;
  if (yRet > RULE.yFall || gap > RULE.gapMax || gap <= RULE.gapMin + 0.0005) continue; // -5% is often the lower circuit: tested negative
  if (p.iep > RULE.capitalRs / RULE.maxPicks) continue; // one share must fit the per-stock budget
  const liq = median(sessions.slice(0, 20).map((s) => s.data.get(symbol)?.cr ?? 0));
  if (liq < RULE.minCr) continue;
  candidates.push({ symbol, yRet, gap, iep: p.iep, liq });
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
const picks = candidates
  .filter((c) => !(news.get(c.symbol) ?? []).some((cat) => BAD_NEWS.has(cat)))
  .sort((a, b) => b.liq - a.liq)
  .slice(0, RULE.maxPicks)
  .map((c) => ({ ...c, limit: Math.round(c.iep * (1 + RULE.limitAbove) * 20) / 20, stopPrice: Math.round(c.iep * (1 - RULE.stop) * 20) / 20, targetPrice: Math.round(c.iep * (1 + RULE.target) * 20) / 20, otherNews: news.get(c.symbol) ?? [] }));
console.log(`${candidates.length} candidates, ${picks.length} picks. News ${newsChecked ? 'checked' : 'NOT checked'}.`);

state.today = { date: today, picks, candidates: candidates.length, newsChecked, generated: new Date().toISOString() };
await save();
if (picks.length) {
  const per = RULE.capitalRs / picks.length;
  const body = picks.map((p) => `${p.symbol}: yesterday ${pct(p.yRet)}, opening ${pct(p.gap)}. Pre-open BUY limit Rs ${p.limit} (qty ${Math.floor(per / p.iep)}). Stop Rs ${p.stopPrice}, target Rs ${p.targetPrice}, else sell 3:20 pm.`).join('\n')
    + `\nWATCH ONLY. Check for bad news yourself.${newsChecked ? '' : ' (Overnight news could NOT be checked today.)'}`;
  await notify(`Panic rebound: ${picks.length} pick${picks.length > 1 ? 's' : ''} (pre-open closes 9:07)`, body, 'high', 'rotating_light');
} else {
  await notify('Panic rebound: no picks today', `${candidates.length} stocks matched the price rule, none passed the checks. No trade is a fine answer.`, 'min', 'zzz');
}
