// Step 15: last ~1 month. For every day's gainers, the reason from MEDIA headlines (media.json, step 14) plus NSE filings
// (news.json, step 11): was there positive news last night / this morning? Then the other side: of ALL stocks with
// positive news before the open, how many gained, and does buying them pay (5-min bars, trailing exits)?
//   node research/15-media-study.mjs   -> data/research/media-report.txt
import fs from 'node:fs';
import { typeOf } from './news-types.mjs';

const DIR = new URL('../data/research/', import.meta.url);
const read = (f) => JSON.parse(fs.readFileSync(new URL(f, DIR), 'utf8'));
const { days, stocks } = read('market.json');
const media = read('media.json').items;
const nseNews = read('news.json').items;
const intra = fs.existsSync(new URL('intraday.json', DIR)) ? read('intraday.json') : {};
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (v, d = 1) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : '-');
const out = [];
const log = (s = '') => { out.push(s); console.log(s); };

// ---- headline types ----
const AFTER = /\b(jumps?|jumped|surges?|surged|soars?|soared|zooms?|zoomed|rall(y|ies|ied)|climbs?|climbed|gains?|gained|rises?|rose|spurts?|skyrockets?|rockets?|flies|flying|up \d|higher|hits?|touches|extends? (gain|rally)|buzzing|top gainers?|upper circuit|52-week high|record high|new high|all-time high|multibagger|stock (is )?up)\b/i;
const NEG = /\b(fall|falls|fell|slump|crash|plunge|drop|tank|decline|slide|sink|slips?|lower circuit|downgrade|sell rating|cuts? target|weak|loss widens|probe|raid|penalty|resign)/i;
const WATCH = /stocks? to (watch|buy|track)|stocks in (news|focus|the news)|in focus|buzzing stocks|hot stocks|stocks? that will be|trade setup|top picks/i;
const CAUSES = [
  ['broker', /target|upgrade|buy rating|\bbuy\b|initiat|coverage|brokerage|outperform|overweight|accumulate|motilal|jefferies|goldman|morgan stanley|nomura|clsa|kotak|nuvama|\bubs\b|citi\b|hsbc|macquarie|bernstein|analyst/i],
  ['result', /\bq[1-4]\b|quarter|results?|profit|net income|revenue|earnings|ebitda|\bpat\b|margin/i],
  // real business orders only (not "orders passed" by tax officers, awards ceremonies, court orders)
  ['order', /\b(bags?|bagged|bagging|wins?|won|secures?|secured|receives?|received|receiving|emerges?)\b.{0,60}\b(orders?|contracts?|projects?|work|L1)\b|\bL1\b|lowest bidder|(letter|notification|notice)s? of award|orders? (worth|for|from|of|book|inflow)|contracts? (worth|for|from)|work orders?/i],
  ['deal', /acqui|stake|merger|invest|fund ?rais|raises|temasek|partnership|tie-up|\bjv\b|\bmou\b|block deal|bulk deal|promoter/i],
  ['approval', /usfda|approval|\bnod\b|clearance|licen[cs]e|patent/i],
  ['corporate', /bonus|split|buyback|dividend|record date|demerger|listing/i],
  ['policy', /government|govt|policy|tariff|duty|subsidy|budget|ministry|railway|defence|pli\b/i],
];
const NOT_ORDER = /orders? passed|action\(s\)|ordered to|\btax\b|appeal|court|awards? at|wins? .*awards?|championship|defeats/i;
const mediaType = (title) => {
  if (NOT_ORDER.test(title) && !/(bags?|secures?|receives?|wins?) .*(order|contract)/i.test(title)) title = title.replace(/order|contract|award/gi, '');
  if (NEG.test(title) && !/despite/i.test(title)) return 'negative';
  if (WATCH.test(title)) return 'watchlist';
  const cause = CAUSES.find(([, re]) => re.test(title))?.[0];
  if (AFTER.test(title)) return cause ? `after:${cause}` : 'after';
  return cause ?? 'other';
};

// ---- the study window: days covered by the media download ----
const firstMedia = media.map((m) => m.ist.slice(0, 10)).sort()[Math.floor(media.length * 0.01)];
const winDays = days.map((d, i) => [d, i]).filter(([d]) => d > firstMedia);
const half = winDays[Math.floor(winDays.length / 2)][0];
log(`MEDIA + NSE NEWS BEHIND THE GAINERS, last month  (${winDays[0][0]}..${winDays.at(-1)[0]}, ${winDays.length} trading days; part 1 < ${half} <= part 2)`);
log(`Headlines: ${media.length.toLocaleString()} (Bing News, times converted to IST) for ${new Set(media.map((m) => m.symbol)).size} stocks; NSE filings added.`);

// ---- map every headline / filing to (stock, trading day, 'pre' | 'day' hh:mm) ----
const dayIdx = new Map(days.map((d, i) => [d, i]));
const tradingAfter = (iso) => days.findIndex((d) => d > iso);
const ev = new Map(); // `${sym}|${i}` -> [{ when, hm, kind, title }]
const add = (sym, d, hm, kind, title, src) => {
  let i, when = 'pre';
  if (dayIdx.has(d) && hm < '09:15') i = dayIdx.get(d);
  else if (dayIdx.has(d) && hm <= '15:30') { i = dayIdx.get(d); when = 'day'; }
  else i = tradingAfter(d);
  if (i < 0) return;
  const k = `${sym}|${i}`;
  (ev.get(k) ?? ev.set(k, []).get(k)).push({ when, hm, kind, title, src });
};
for (const m of media) add(m.symbol, m.ist.slice(0, 10), m.ist.slice(11, 16), mediaType(m.title), m.title, m.source);
for (const n of nseNews) {
  let t = typeOf(n.desc, n.text);
  // an NSE "order" must look like a real business order too (not interest notices, court orders...)
  if (t === 'order' && !/bagging|receiving of orders/i.test(n.desc) && !CAUSES.find(([c]) => c === 'order')[1].test(`${n.desc} ${n.text}`)) t = 'other';
  if (['routine', 'meeting', 'management', 'rating', 'board-meet', 'other', 'press', 'legal', 'fundraise'].includes(t)) continue;
  add(n.symbol, n.time.slice(0, 10), n.time.slice(11, 16), `nse:${t}`, (n.text || n.desc).replace(/^.*?has (informed|submitted)( to)? the Exchange,? (about|regarding|that)? ?/i, '').slice(0, 110), 'NSE');
}
const POS = (k) => !['negative', 'watchlist', 'other'].includes(k) && !k.startsWith('after');
const causeOf = (k) => (k.startsWith('nse:') ? k.slice(4) : k);

// ---- stock-days ----
const toMin = (hhmm) => Math.floor(hhmm / 100) * 60 + (hhmm % 100);
const rows = [];
for (const [sym, rws] of Object.entries(stocks)) {
  const m = new Map(rws.map((r) => [r[0], r]));
  for (const [d, i] of winDays) {
    const t = m.get(i), y = m.get(i - 1);
    if (!t || !y || !(t[2] > 0)) continue;
    const liqA = []; for (let j = i - 1; j >= 0 && liqA.length < 20; j--) if (m.has(j)) liqA.push(m.get(j)[6]);
    const liq = median(liqA);
    if (!(liq >= 3)) continue;
    const e = ev.get(`${sym}|${i}`) ?? [];
    const pre = e.filter((x) => x.when === 'pre'), day = e.filter((x) => x.when === 'day').sort((a, z) => a.hm.localeCompare(z.hm));
    rows.push({ sym, d, i, liq, part: d < half ? 1 : 2, prev: t[1], open: t[2], close: t[5], ret: t[5] / t[1] - 1, gap: t[2] / t[1] - 1, oc: t[5] / t[2] - 1,
      pre, day, prePos: pre.filter((x) => POS(x.kind)), preNeg: pre.some((x) => x.kind === 'negative'), preWatch: pre.some((x) => x.kind === 'watchlist'),
      preAfter: pre.some((x) => x.kind.startsWith('after')) });
  }
}
const gainers = rows.filter((r) => r.ret >= 0.05);
log(`Liquid (Rs 3 cr+/day) stock-days: ${rows.length.toLocaleString()}. Gainers (close 5%+): ${gainers.length} = ${(gainers.length / winDays.length).toFixed(0)} a day.`);

// ---------- PART A: reason for each gainer ----------
const firstTouch = (r, lvl) => { const b = intra[r.sym]?.[r.d]; if (!b) return null; const h = b.find((x) => x[2] / r.prev - 1 >= lvl); return h ? h[0] : 9999; };
const reason = (r) => {
  if (r.prePos.length) return `A positive news before open (${causeOf(r.prePos[0].kind)})`;
  if (r.preWatch) return 'B only named in a "stocks to watch" list before open';
  const t3 = firstTouch(r, 0.03);
  const dayPos = r.day.filter((x) => POS(x.kind));
  if (dayPos.length && t3 != null && Number(dayPos[0].hm.replace(':', '')) <= t3 + 5) return `C news during the day, BEFORE the jump (${causeOf(dayPos[0].kind)})`;
  if (dayPos.length && t3 == null) return `C? news during the day (${causeOf(dayPos[0].kind)}, no 5-min bars to check timing)`;
  if (dayPos.length) return 'D news came out only AFTER the jump started';
  if (r.day.some((x) => x.kind.startsWith('after')) || ev.get(`${r.sym}|${r.i + 1}`)?.some((x) => x.when === 'pre' && x.kind.startsWith('after'))) return 'E media only reported the jump (no cause found)';
  if (r.preAfter) return 'F yesterday it was already in the news for rising';
  return 'G no news at all';
};
log('\n==== PART A: why did the gainers go up? ====');
const byR = {};
for (const g of gainers) { const k = reason(g).replace(/\(.*\)/, '').trim(); (byR[k] ??= []).push(g); }
for (const k of Object.keys(byR).sort()) log(`  ${k.padEnd(56)} ${pct(byR[k].length / gainers.length, 0).padStart(5)}  (${(byR[k].length / winDays.length).toFixed(1)} a day)  avg gap ${pct(mean(byR[k].map((r) => r.gap)))}`);
const causeCount = {};
for (const g of gainers) if (g.prePos.length) { const c = causeOf(g.prePos[0].kind); causeCount[c] = (causeCount[c] ?? 0) + 1; }
log('  Type of the before-open news: ' + Object.entries(causeCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));

// ---------- PART B: the other side ----------
log('\n==== PART B: ALL stocks with positive news before the open (no negative news) - how many gained, does buying pay? ====');
log('  gainer% = closed 5%+ up. Trades after ~0.4% costs; 5-min exits use bars up to the last intraday day.');
const COST = (liq) => 0.0022 + (liq >= 20 ? 0.0005 : liq >= 5 ? 0.0015 : 0.003);
function simulate(bars, idx, px, x) {
  let peak = px;
  for (let j = idx; j < bars.length; j++) {
    const [t, o, h, l, c] = bars[j];
    if (t > 1515) break;
    const stop = Math.max(px * (1 - x.stop), x.trail ? peak * (1 - x.trail) : 0);
    if (l <= stop) return Math.min(o, stop) / px - 1;
    if (x.target && h >= px * (1 + x.target)) return x.target;
    peak = Math.max(peak, h);
    if (t === 1515) return c / px - 1;
  }
  return bars.filter((b) => b[0] <= 1515).at(-1)[4] / px - 1;
}
const EXITS = [{ n: 'hold 3:20', stop: 0.03 }, { n: 'trail 1%', stop: 0.03, trail: 0.01 }, { n: 'trail 2%', stop: 0.03, trail: 0.02 }, { n: 'tgt 3%/stop 2%', stop: 0.02, target: 0.03 }];
const ENTRIES = {
  'open 9:15': (b, r) => ({ idx: 0, px: b[0][1] }),
  '9:30 if above open & yday': (b, r) => { const k = b.findIndex((x) => x[0] === 925); return k > 0 && b[k][4] > b[0][1] && b[k][4] > r.prev ? { idx: k + 1, px: b[k][4] } : null; },
};
const showGroup = (label, f) => {
  const g = rows.filter((r) => f(r));
  if (g.length < 10) { log(`  ${label}: n=${g.length} (too few)`); return; }
  const line = [1, 2].map((p) => { const s = g.filter((r) => r.part === p); return `part${p} n=${String(s.length).padStart(4)} gainer ${pct(s.filter((r) => r.ret >= 0.05).length / s.length, 0).padStart(4)} open->close ${pct(mean(s.map((r) => r.oc - COST(r.liq))), 2).padStart(7)}`; }).join(' | ');
  log(`  ${label.padEnd(44)} ${line}`);
  for (const [en, fn] of Object.entries(ENTRIES)) {
    const res = {};
    for (const r of g) { const b = intra[r.sym]?.[r.d]; if (!b || b.length < 60 || b[0][0] !== 915) continue; const e = fn(b, r); if (!e || e.idx >= b.length) continue; for (const x of EXITS) ((res[x.n] ??= { 1: [], 2: [] })[r.part]).push(simulate(b, e.idx, e.px, x) - COST(r.liq)); }
    if (!res['hold 3:20']) continue;
    log(`      ${en.padEnd(26)} ` + EXITS.map((x) => `${x.n}: ${pct(mean(res[x.n][1]), 2)}/${pct(mean(res[x.n][2]), 2)}`).join('  ') + `   (n ${res['hold 3:20'][1].length}/${res['hold 3:20'][2].length})`);
  }
};
log('  (each 5-min line: part1/part2 average per trade)');
showGroup('every liquid stock-day', () => true);
showGroup('ANY positive news before open', (r) => r.prePos.length && !r.preNeg);
for (const [c] of [...CAUSES, ['other']]) showGroup(`  ${c}`, (r) => !r.preNeg && r.prePos.some((x) => causeOf(x.kind) === c));
showGroup('  2+ different positive headlines', (r) => !r.preNeg && new Set(r.prePos.map((x) => x.title)).size >= 2);
showGroup('  positive news, opens 0..+2%', (r) => r.prePos.length && !r.preNeg && r.gap >= 0 && r.gap < 0.02);
showGroup('  positive news, opens +2..+6%', (r) => r.prePos.length && !r.preNeg && r.gap >= 0.02 && r.gap < 0.06);
showGroup('  positive news, opens down', (r) => r.prePos.length && !r.preNeg && r.gap < 0);
showGroup('named in "stocks to watch" only', (r) => r.preWatch && !r.prePos.length && !r.preNeg);
showGroup('negative news before open', (r) => r.preNeg);

// ---------- examples ----------
log('\n==== EXAMPLES: last 3 days, every gainer with its headline ====');
for (const [d, i] of winDays.slice(-3)) {
  const g = gainers.filter((r) => r.i === i).sort((a, b) => b.ret - a.ret);
  log(`\n  ${d}: ${g.length} gainers`);
  for (const r of g) {
    const h = r.prePos[0] ?? r.day.find((x) => POS(x.kind)) ?? r.pre.find((x) => x.kind === 'watchlist') ?? r.day[0] ?? r.pre[0];
    log(`   ${r.sym.padEnd(12)} ${pct(r.ret).padStart(6)} gap ${pct(r.gap).padStart(6)} | ${reason(r).slice(2, 40).padEnd(38)} | ${h ? `${h.when === 'pre' ? 'pre' : h.hm} ${h.src ? '[' + h.src.slice(0, 18) + '] ' : ''}${h.title.slice(0, 90)}` : ''}`);
  }
}
fs.writeFileSync(new URL('media-report.txt', DIR), out.join('\n'));

// ---------- the order-news lead, trade by trade ----------
{
  log('\n==== ORDER news before open, bought at 9:30 only if above open & yesterday (target 3% / stop 2%) ====');
  const list = [];
  for (const r of rows) {
    if (r.preNeg || !r.prePos.some((x) => causeOf(x.kind) === 'order')) continue;
    const b = intra[r.sym]?.[r.d]; if (!b || b.length < 60 || b[0][0] !== 915) continue;
    const e = ENTRIES['9:30 if above open & yday'](b, r); if (!e || e.idx >= b.length) continue;
    const res = simulate(b, e.idx, e.px, { stop: 0.02, target: 0.03 }) - COST(r.liq);
    const trail = simulate(b, e.idx, e.px, { stop: 0.03, trail: 0.02 }) - COST(r.liq);
    list.push({ r, res, trail, h: r.prePos.find((x) => causeOf(x.kind) === 'order') });
  }
  for (const { r, res, trail, h } of list) log(`  ${r.d} ${r.sym.padEnd(12)} gap ${pct(r.gap).padStart(6)} | tgt/stop ${pct(res).padStart(6)} trail2 ${pct(trail).padStart(6)} | ${h.title.slice(0, 85)}`);
  const v = list.map((x) => x.res), s = [...v].sort((a, b) => a - b);
  log(`  n=${v.length}, avg ${pct(mean(v), 2)}, win ${pct(v.filter((x) => x > 0).length / v.length, 0)}, median ${pct(s[s.length >> 1], 2)}; without the best 3: ${pct(mean(s.slice(0, -3)), 2)}`);
  const perDay = {}; for (const x of list) (perDay[x.r.d] ??= []).push(x.res);
  log(`  days with a trade: ${Object.keys(perDay).length} of ${winDays.length}; days positive: ${Object.values(perDay).filter((a) => mean(a) > 0).length}`);
}
fs.writeFileSync(new URL('media-report.txt', DIR), out.join('\n'));
