const CLASS = { 'Max Confidence': 'r-max', Excellent: 'r-excellent', Good: 'r-good', Bad: 'r-bad', 'No data': 'r-none' };
const IPO_CLASS = { Strong: 'r-excellent', Okay: 'r-good', Avoid: 'r-bad', 'No GMP yet': 'r-none' };
const RANK = ['Max Confidence', 'Excellent', 'Good', 'Bad'];
const CHEVRON = '<svg class="chev" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
let data = null;
let filter = 'All';

// Company data comes from outside sources, so always insert it as escaped text.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const asDate = (iso) => new Date(iso + 'T00:00:00');
const dayName = (iso) => asDate(iso).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
const shortDay = (iso) => asDate(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const pct = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
const whole = (v) => `${(v * 100).toFixed(0)}%`;
const money = (v) => `₹${Math.round(v).toLocaleString('en-IN')}`;
const cleanName = (n) => String(n ?? '').replace(/\s+(Ltd\.?|Limited)$/i, '');

function relativeDay(iso) {
  const now = new Date();
  const days = Math.round((asDate(iso) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 864e5);
  return days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days > 1 ? `In ${days} days` : '';
}

const ring = (score, big) => `<span class="ring${big ? ' big' : ''}" style="--p:${Number(score) || 0}"><span>${score == null ? '–' : Math.round(score)}</span></span>`;
const shownScore = (c) => (c.filtered ? null : c.score);
const stopPrice = (close) => close * (1 - data.stopLossPct / 100);

function steps(c) {
  return `<div class="steps">
    <div class="step"><span>Buy on</span><b>${esc(shortDay(c.buyOn))}</b></div>
    <div class="step"><span>Stop-loss</span><b>${c.lastClose ? esc(money(stopPrice(c.lastClose))) : `-${data.stopLossPct}%`}</b></div>
    <div class="step"><span>Sell by</span><b>${esc(shortDay(c.sellOn))}</b></div>
  </div>`;
}

function record(label) {
  const h = data.history[label];
  if (!h) return '';
  return `<div class="stats">
    <div class="stat"><b>${whole(h.betterRate)}</b><span>result better</span></div>
    <div class="stat"><b>${whole(h.roseRate)}</b><span>stock rose</span></div>
    <div class="stat"><b class="${h.avgReturn >= 0 ? 'pos' : 'neg'}">${pct(h.avgReturn)}</b><span>avg trade</span></div>
  </div><p class="stats-note">Past record of this rating, ${h.trades.toLocaleString('en-IN')} trades</p>`;
}

function chances(c) {
  if (c.chanceYoY == null) return '';
  return `<div class="chances">
    <div class="step"><span>Chance better than last quarter</span><b>${whole(c.chanceQoQ)}</b></div>
    <div class="step"><span>Chance better than last year</span><b>${whole(c.chanceYoY)}</b></div>
  </div>`;
}

function position(c) {
  const per = data.perStockRs;
  if (!per || !c.lastClose) return '';
  const shares = Math.floor(per / c.lastClose);
  return `<p class="note">About ${shares} shares, ${esc(money(shares * c.lastClose))}. Keep the rest of your money in cash.</p>`;
}

function planHtml(c) {
  if (c.label === 'Bad' || c.label === 'No data') return '<div class="notice">Skip this one.</div>';
  if (c.tooLate) return '<div class="notice">Too late to buy on the plan, results are too close.</div>';
  return `${steps(c)}${c.late ? '<p class="note">A day later than the plan, because of the market calendar.</p>' : ''}`;
}

function companyHtml(c) {
  return `<details class="card ${CLASS[c.label]}">
    <summary>
      ${ring(shownScore(c))}
      <div class="name"><b>${esc(cleanName(c.company))}</b><span>${esc(c.quarter)} result${c.chanceQoQ != null ? ` · ${whole(c.chanceQoQ)} to beat last qtr` : ''}</span></div>
      <span class="badge">${esc(c.label)}</span>
      ${CHEVRON}
    </summary>
    <div class="detail">
      <p>${esc(c.summary)}</p>
      ${chances(c)}
      <ul>${c.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
      ${planHtml(c)}
      ${record(c.label)}
    </div>
  </details>`;
}

function legendHtml() {
  const rows = RANK.filter((l) => data.history[l]).map((l) => `<div class="legend-row ${CLASS[l]}">
    <span class="badge">${esc(l)}</span><span>${whole(data.history[l].betterRate)}</span><span>${whole(data.history[l].roseRate)}</span>
  </div>`).join('');
  return `<details class="legend">
    <summary>What the ratings mean ${CHEVRON}</summary>
    <div class="legend-body">
      <div class="legend-row legend-head"><span>Best to worst</span><span>Result better</span><span>Stock rose</span></div>
      ${rows}
      <p class="legend-note">A good rating means the result will likely be good. It does not mean the stock will rise, because good news is often already in the price.</p>
    </div>
  </details>`;
}

function renderSide() {
  const el = document.getElementById('side');
  const all = data.days.flatMap((d) => d.companies);
  const chosen = (data.picks ?? (data.pick ? [{ symbol: data.pick, date: data.pickDate }] : []))
    .map((p) => all.find((x) => x.symbol === p.symbol && x.date === p.date)).filter(Boolean);
  const heroes = chosen.map((c, i) => `<div class="hero ${CLASS[c.label]}">
      <small>${chosen.length > 1 ? `Pick ${i + 1} of ${chosen.length}` : "This week's pick"}</small>
      <div class="hero-head">
        <div><h2>${esc(cleanName(c.company))}</h2><span class="badge">${esc(c.label)}</span></div>
        ${ring(c.score, true)}
      </div>
      <p>${esc(c.summary)}</p>
      ${chances(c)}
      ${steps(c)}
      ${position(c)}
      ${record(c.label)}
    </div>`).join('');
  const hero = heroes || `<div class="hero r-none"><small>This week's pick</small><h2>No trade</h2><p>Nothing is strong enough with time left to buy. Keep your money in cash.</p></div>`;
  el.innerHTML = hero + legendHtml();
}

function renderFilters() {
  const all = data.days.flatMap((d) => d.companies);
  const count = (f) => (f === 'All' ? all.length : all.filter((c) => c.label === f).length);
  const el = document.getElementById('filters');
  el.innerHTML = ['All', ...RANK].map((f) => `<button type="button" data-f="${esc(f)}" aria-pressed="${f === filter}" class="${CLASS[f] ?? ''}">${f === 'All' ? '' : '<i></i>'}${esc(f)} <em>${count(f)}</em></button>`).join('');
  el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { filter = b.dataset.f; renderFilters(); renderDays(); }));
}

function renderDays() {
  const html = data.days.map((d) => {
    const list = d.companies.filter((c) => filter === 'All' || c.label === filter);
    if (!list.length) return '';
    // On the All view, weak companies fold away so the good ones are easy to see.
    const fold = filter === 'All' ? list.filter((c) => c.label === 'Bad' || c.label === 'No data') : [];
    const main = list.filter((c) => !fold.includes(c));
    const more = fold.length ? `<details class="more"><summary>Show ${fold.length} weak ${fold.length === 1 ? 'company' : 'companies'} ${CHEVRON}</summary>${fold.map(companyHtml).join('')}</details>` : '';
    return `<section>
      <div class="day-head"><h2>${esc(dayName(d.date))}<span>${esc(relativeDay(d.date))}</span></h2><span>${list.length} ${list.length === 1 ? 'company' : 'companies'}</span></div>
      ${main.map(companyHtml).join('')}${more}
    </section>`;
  }).join('');
  document.getElementById('days').innerHTML = html || '<p class="empty">No companies to show.</p>';
}

function ipoStatus(i) {
  if (i.status === 'upcoming') return `Opens ${i.open ? shortDay(i.open) : 'soon'}`;
  if (i.status === 'open') return `Open now, closes ${shortDay(i.close)}`;
  return i.listing ? `Bidding closed, lists ${shortDay(i.listing)}` : 'Bidding closed';
}

function ipoHtml(i) {
  const minimum = i.price && i.lot ? i.price * i.lot * (i.board === 'SME' ? 2 : 1) : null;
  return `<details class="card ${IPO_CLASS[i.label]}">
    <summary>
      ${ring(i.score)}
      <div class="name"><b>${esc(i.name)}</b><span>${esc(i.board)} · ${esc(ipoStatus(i))}</span></div>
      <div class="gmp"><b class="${i.gmp ? (i.gmpPct >= 0 ? 'pos' : 'neg') : ''}">${i.gmp ? esc(pct(i.gmpPct)) : '–'}</b><span>GMP</span></div>
      <span class="badge">${esc(i.label)}</span>
      ${CHEVRON}
    </summary>
    <div class="detail">
      <p>${esc(i.why)}</p>
      <div class="steps">
        <div class="step"><span>Price</span><b>${i.price ? esc(money(i.price)) : '–'}</b></div>
        <div class="step"><span>Minimum</span><b>${minimum ? esc(money(minimum)) : '–'}</b></div>
        <div class="step"><span>Bids</span><b>${i.subscription != null ? `${esc(i.subscription)}x` : '–'}</b></div>
      </div>
    </div>
  </details>`;
}

function renderIpos() {
  const el = document.getElementById('view-ipo');
  if (!data.ipo) { el.innerHTML = '<p class="empty">IPO data is not available right now.</p>'; return; }
  const items = data.ipo.items.map(ipoHtml).join('') || '<p class="empty">No upcoming IPOs right now.</p>';
  const rows = ['Strong', 'Okay', 'Avoid'].filter((l) => data.ipo.record[l]).map((l) => {
    const r = data.ipo.record[l];
    return `<div class="track-row ${IPO_CLASS[l]}"><span class="badge">${esc(l)}</span><span>${r.positive} of ${r.count} listed up</span><b class="${r.avgGain >= 0 ? 'pos' : 'neg'}">${esc(pct(r.avgGain))}</b></div>`;
  }).join('');
  el.innerHTML = `${items}
    ${rows ? `<div class="track"><div class="section-label">How the score did on recent listings</div>${rows}<p class="note">A small sample, so treat it as a rough guide. GMP is an unofficial price and can change fast.</p></div>` : ''}`;
}

function gapCard(c, rules, goCount) {
  const go = c.status === 'go';
  // Capital is split across the day's GO stocks (at most 2).
  const perStock = (rules.capitalRs ?? 20000) / Math.min(Math.max(goCount, 1), 2);
  const shares = c.openPrice ? Math.floor(perStock / c.openPrice) : 0;
  const target = c.targetPrice ?? (c.openPrice ? c.openPrice * (1 + (rules.target ?? 0.07)) : null);
  // Limit 1% above the indicative price: fills at the official open, but never chases a big jump.
  const buyAt = c.openPrice ? Math.round(c.openPrice * 1.01) : null;
  const plan = go && c.openPrice ? `<ol class="simple">
      <li><b>Buy ${shares} shares at ₹${esc(buyAt)}</b><span>Intraday, before 9:08 am</span></li>
      <li><b>Sell UP at ₹${esc(Math.round(target))}</b><span>profit about ${esc(money(shares * (target - c.openPrice)))}</span></li>
      <li><b>Sell DOWN at ₹${esc(Math.round(c.stopPrice))}</b><span>loss about ${esc(money(shares * (c.openPrice - c.stopPrice)))}</span></li>
      <li><b>Neither? Sell at 3:20 pm</b><span>never hold overnight</span></li>
    </ol>` : '';
  return `<details class="card ${go ? 'r-excellent' : c.status === 'watch' ? 'r-good' : 'r-none'}"${go ? ' open' : ''}>
    <summary>
      <div class="name"><b>${esc(cleanName(c.company))}</b><span>Result ${esc(c.announced.slice(5))} · qtr ${c.qoq != null ? esc(pct(c.qoq)) : '–'} · year ${c.yoy != null ? esc(pct(c.yoy)) : '–'}</span></div>
      <div class="gmp"><b class="${c.gap > 0 ? 'pos' : c.gap < 0 ? 'neg' : ''}">${c.gap != null ? esc(pct(c.gap)) : '–'}</b><span>opening</span></div>
      <span class="badge">${go ? 'GO' : c.status === 'watch' ? 'Watch' : 'Skip'}</span>
      ${CHEVRON}
    </summary>
    <div class="detail"><p>${esc(c.reason)}.</p>${plan}</div>
  </details>`;
}


// ---------------- News tab: today's news alerts in plain sections ----------------
const istToday = () => new Date(Date.now() + 19800e3).toISOString().slice(0, 10);
const plain = (v) => (v == null ? '' : `<b class="${v >= 0 ? 'pos' : 'neg'}">${esc(pct(v))}</b>`);
function section(icon, title, explain, body, emptyText) {
  return `<div class="day-head"><h2>${icon} ${esc(title)}</h2></div><p class="note" style="margin:-4px 2px 8px">${esc(explain)}</p>${body || `<p class="empty small">${esc(emptyText)}</p>`}`;
}
function newsCard(cls, symbol, sub, right, badge, detail) {
  return `<details class="card ${cls}"><summary><div class="name"><b>${esc(symbol)}</b><span>${esc(sub)}</span></div>${right ? `<div class="gmp">${right}</div>` : ''}${badge ? `<span class="badge">${esc(badge)}</span>` : ''}${CHEVRON}</summary><div class="detail">${detail}</div></details>`;
}
const row = (sym, text, bad) => `<div class="track-row"><b class="${bad ? 'neg' : ''}">${esc(sym)}</b><span class="row-why">${esc(text)}</span></div>`;
const box = (rows) => (rows ? `<div class="track" style="margin-top:0">${rows}</div>` : '');
function renderNews() {
  const el = document.getElementById('view-news');
  const n = data.news ?? {}, today = istToday();
  const p = n.picks?.date === today ? n.picks : null, l = n.live?.date === today ? n.live : null;
  const intro = `<div class="hero r-excellent"><small>Today's trades · paper test</small>
    <p style="margin:6px 0 0">Every buy signal of the day in one place: <b>news</b>, <b>Gap &amp; Go</b> and <b>Panic rebound</b>. Each card shows when to buy and when to sell. Never hold overnight. Your phone (ntfy) gets every alert first; this page is to check later.</p></div>`;
  // 1. live BUY NOW
  const live = (l?.trades ?? []).map((t) => {
    const sold = t.ret != null;
    return newsCard(sold ? (t.ret >= 0 ? 'r-excellent' : 'r-bad') : 'r-good', t.symbol, t.why,
      sold ? `${plain(t.ret)}<span>result</span>` : `<b>₹${esc(t.px.toFixed(1))}</b><span>bought</span>`, sold ? 'Sold' : 'Holding',
      `<ol class="simple"><li><b>News at ${esc(t.newsAt?.slice(0, 5))}</b><span>strength ${esc(t.strength)}/10 · alert ${esc(t.delay)} seconds later</span></li>
       <li><b>Buy at ${esc(t.at)} · ₹${esc(t.px.toFixed(2))}</b><span>paper trade</span></li>
       ${sold ? `<li><b>Sold at ${esc(t.exitAt)} · ₹${esc(t.exit.toFixed(2))}</b><span>${esc(t.how)} · ${esc(pct(t.ret))} after charges</span></li>` : '<li><b>Still holding</b><span>SELL NOW comes on the phone when it falls 1.5% from its best</span></li>'}</ol>`);
  }).join('');
  // 2. buy at open
  const open = (p?.openBuys ?? []).map((b) => newsCard(b.result == null ? 'r-good' : b.result >= 0 ? 'r-excellent' : 'r-bad', b.symbol, b.why,
    `<b class="pos">${esc(pct(b.gap))}</b><span>pre-open</span>`, b.result == null ? 'At open' : pct(b.result),
    `<ol class="simple"><li><b>Limit buy ₹${esc(b.limit)}</b><span>before 9:08 am. If it opens above this you are not filled - do not chase.</span></li><li><b>Sell when it falls 1.5% from its best</b><span>never hold past 3:20 pm</span></li></ol>`)).join('');
  // 3. 9:30 buys
  const at930 = (p?.buys ?? []).map((b) => newsCard('r-good', b.symbol, b.why, `<b>₹${esc(b.buy.toFixed(1))}</b><span>at 9:30</span>`, '9:30 buy',
    `<ol class="simple"><li><b>Bought ~₹${esc(b.buy.toFixed(2))} at 9:30</b><span>it was above its open and yesterday's close</span></li><li><b>Sell at +3%, or when it falls 2% from its best</b><span>never hold past 3:20 pm</span></li></ol>`)).join('');
  // 4. good news, watch only
  const bought = new Set([...(p?.openBuys ?? []), ...(p?.buys ?? [])].map((b) => b.symbol));
  const good = (p?.watch ?? []).filter((w) => !bought.has(w.symbol)).map((w) => row(w.symbol, w.why)).join('');
  // 5. bad news
  const liveBad = new Set((l?.badNews ?? []).map((b) => b.symbol));
  const bad = [...(l?.badNews ?? []).map((b) => row(b.symbol, `${b.at} · ${b.why}`, true)), ...(p?.bad ?? []).filter((s) => !liveBad.has(s)).map((s) => row(s, 'overnight bad news', true))].join('');
  // 5a. gap & go (full detail on its own tab)
  const g = data.gapgo?.date === today ? data.gapgo : null;
  const gapRows = (g?.candidates ?? []).filter((c) => c.status === 'go' || c.status === 'watch').map((c) => gapCard(c, g.rules, g.candidates.filter((x) => x.status === 'go').length)).join('');
  // 5b. panic rebound
  const pr = n.panic?.date === today ? n.panic : null;
  const panic = (pr?.picks ?? []).map((x) => newsCard(x.result == null ? (x.tier === 'high' ? 'r-excellent' : 'r-good') : x.result >= 0 ? 'r-excellent' : 'r-bad', x.symbol,
    `fell ${pct(x.yRet ?? 0)} yesterday`, `<b class="neg">${esc(pct(x.gap))}</b><span>opening</span>`, x.result != null ? pct(x.result) : x.tier === 'high' ? 'HIGH' : 'Watch',
    `<ol class="simple"><li><b>Limit buy ₹${esc(x.limit)}</b><span>in pre-open, before 9:07 am</span></li><li><b>Sell DOWN at ₹${esc(x.stopPrice)}</b><span>-3% stop</span></li>${x.targetPrice ? `<li><b>Sell UP at ₹${esc(x.targetPrice)}</b><span>+7% target</span></li>` : ''}<li><b>Neither? Sell at 3:20 pm</b><span>never hold overnight</span></li></ol>${x.howEnded ? `<p class="note">Ended: ${esc(x.howEnded)}</p>` : ''}`)).join('');
  // 6. scorecard over all paper trades
  const all = [...(n.picks?.history ?? []).flatMap((h) => h.buys.map((b) => ({ d: h.date, symbol: b.symbol, result: b.result, kind: 'morning' }))),
    ...(n.live?.history ?? []).flatMap((h) => h.trades.filter((t) => t.ret != null).map((t) => ({ d: h.date, symbol: t.symbol, result: t.ret, kind: 'live' }))),
    ...(l?.trades ?? []).filter((t) => t.ret != null).map((t) => ({ d: today, symbol: t.symbol, result: t.ret, kind: 'live' })),
    ...(n.panic?.history ?? []).flatMap((h) => h.picks.map((x) => ({ d: h.date, symbol: x.symbol, result: x.result - 0.004, kind: 'panic' })))].sort((x, y) => x.d.localeCompare(y.d));
  const won = all.filter((x) => x.result > 0).length, avg = all.length ? all.reduce((s, x) => s + x.result, 0) / all.length : 0;
  const score = all.length ? `<div class="track" style="margin-top:0"><div class="stats"><div class="stat"><b>${all.length}</b><span>trades</span></div><div class="stat"><b>${Math.round((won / all.length) * 100)}%</b><span>won</span></div><div class="stat">${plain(avg)}<span>avg per trade</span></div></div>
    ${all.slice(-12).reverse().map((x) => `<div class="track-row"><span>${esc(x.d.slice(5))} · <b>${esc(x.symbol)}</b> <span style="color:var(--muted)">${x.kind}</span></span>${plain(x.result)}</div>`).join('')}
    <p class="note">After charges. Use real money only if this stays green for a few weeks.</p></div>` : '';
  const when = n.updated ? new Date(n.updated).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : null;
  el.innerHTML = intro +
    section('🚀', 'Buy now (live)', 'Strong news came out during the day. Alert sent within seconds.', live, 'No BUY NOW yet today. Strong news does not come every day.') +
    section('🌅', 'Buy at open', 'Strong overnight news, and buyers rushing in before 9:08 am (pre-open +5% or more).', open, p?.preopenDone ? 'None today: no strong-news stock opened +5% or more.' : 'Comes at 9:04-9:08 am.') +
    section('✅', 'Buy at 9:30', "Strong overnight news, still above its open and yesterday's close at 9:30.", at930, p?.confirmed ? 'None today: none of them held up at 9:30.' : 'Comes at 9:31 am.') +
    section('🎯', 'Gap & Go (results)', 'Results beat last quarter AND last year, and the stock opens 5-20% up: buy at the open.', gapRows, g ? 'No GO today.' : 'Watch list 8:30 am, GO list 9:03 am.') +
    section('📉', 'Panic rebound', 'Fell 3%+ yesterday and opens 3-5% down again with no bad news: it usually bounces back during the day. HIGH = whole market panicking.', panic, pr ? `None today. Market opening ${pct(pr.marketGap ?? 0)}.` : 'Comes at about 9:04 am.') +
    section('👀', 'Good news - just watch', 'Good news, but no buy signal. Do not buy these on your own.', box(good), p ? 'No strong good news overnight.' : 'The morning list comes at 7:50-8:25 am.') +
    section('⛔', 'Bad news - avoid or sell', 'If you hold one of these, think about selling.', box(bad), 'No bad news found.') +
    section('📊', 'Scorecard', 'How every paper trade turned out (news, live and panic rebound).', score, 'No finished trades yet. Results show after the first trading day.') +
    (when ? `<p class="note" style="text-align:center">News updated ${esc(when)}${p?.mode === 'keyword' ? ' · rough keyword reading (no Claude key)' : ''}</p>` : '');
}

function renderGapGo() {
  const el = document.getElementById('view-gap');
  const g = data.gapgo;
  const todayIso = new Date(Date.now() + 19800e3).toISOString().slice(0, 10);
  const intro = `<div class="hero r-excellent"><small>Gap &amp; Go · watch only</small>
    <p style="margin:6px 0 0">Result beat <b>both</b> last quarter and last year, and the stock opens <b>5-20% up</b>: buy at the open, sell at +${g?.rules?.target ? g.rules.target * 100 : 7}% profit or -${g?.rules ? g.rules.stop * 100 : 3}% stop, otherwise by 3:20 pm.</p>
    ${g?.backtest ? `<p class="note">Tested ${esc(g.backtest.period)}: ${g.backtest.trades} trades, average ${esc(pct(g.backtest.avgPerTrade))} per trade after charges, ${whole(g.backtest.winRate)} won. Half the trades lose, so watch it before using money.</p>` : ''}
  </div>`;
  if (!g || g.date < todayIso) { el.innerHTML = intro + '<p class="empty">No results yet for the next market day. Checks run every 30 minutes in the evening, then 8:30 am (watch list) and 9:03 am (GO list).</p>'; return; }
  const label = g.date === todayIso ? 'Today' : new Date(g.date).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const go = g.candidates.filter((c) => c.status === 'go');
  el.innerHTML = `${intro}
    <div class="day-head"><h2>${esc(label)}<span>${go.length ? `${go.length} GO` : 'no GO'}</span></h2><span>${g.candidates.length} overnight result${g.candidates.length === 1 ? '' : 's'}</span></div>
    ${g.candidates.map((c) => gapCard(c, g.rules, go.length)).join('') || '<p class="empty">No Nifty 500 results came out overnight.</p>'}
    ${g.preOpenReady ? '' : g.date > todayIso ? `<p class="note">Results so far (updated ${esc(new Date(g.generated).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }))}). Opening prices come at 9:03 am.</p>` : '<p class="note">Pre-open prices were not ready when this ran.</p>'}`;
}

function showTab(name) {
  for (const t of ['news', 'results', 'gap', 'ipo']) {
    document.getElementById(`view-${t}`).hidden = name !== t;
    document.getElementById(`tab-${t}`).setAttribute('aria-selected', String(name === t));
  }
}
for (const t of ['news', 'results', 'gap', 'ipo']) document.getElementById(`tab-${t}`).addEventListener('click', () => showTab(t));

// Reads from Supabase once config.js is filled in, otherwise from the local data.json.
async function fetchData() {
  const { supabaseUrl, supabaseAnonKey } = window.RADAR_CONFIG;
  if (!supabaseUrl) {
    const res = await fetch('data.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    return res.json();
  }
  const res = await fetch(`${supabaseUrl}/rest/v1/radar?id=eq.1&select=payload`, {
    headers: { apikey: supabaseAnonKey }, cache: 'no-store',
  });
  if (!res.ok) throw new Error(res.status);
  const rows = await res.json();
  if (!rows.length) throw new Error('empty');
  return rows[0].payload;
}

async function load() {
  const updated = document.getElementById('updated');
  try {
    data = await fetchData();
  } catch {
    updated.textContent = 'No ratings yet';
    document.getElementById('days').innerHTML = '<p class="empty">No ratings yet. Check back after the next update.</p>';
    return;
  }
  updated.textContent = `Updated ${new Date(data.generated).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`;
  renderSide();
  renderFilters();
  renderDays();
  renderIpos();
  renderGapGo();
  renderNews();
}

load();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
