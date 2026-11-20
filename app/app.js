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
    `<ol class="simple"><li><b>Limit buy ₹${esc(x.limit)}</b><span>in pre-open, before 9:08 am</span></li><li><b>Sell DOWN at ₹${esc(x.stopPrice)}</b><span>-3% stop</span></li>${x.targetPrice ? `<li><b>Sell UP at ₹${esc(x.targetPrice)}</b><span>+7% target</span></li>` : ''}<li><b>Neither? Sell at 3:20 pm</b><span>never hold overnight</span></li></ol>${x.howEnded ? `<p class="note">Ended: ${esc(x.howEnded)}</p>` : ''}`)).join('');
  // 6. scorecard over all paper trades
  const all = [...(n.best?.history ?? []).flatMap((h) => h.picks.map((x) => ({ d: h.date, symbol: x.symbol, result: x.result, kind: x.kind }))),
    ...(n.live?.history ?? []).flatMap((h) => h.trades.filter((t) => t.ret != null).map((t) => ({ d: h.date, symbol: t.symbol, result: t.ret, kind: 'live news' }))),
    ...(l?.trades ?? []).filter((t) => t.ret != null).map((t) => ({ d: today, symbol: t.symbol, result: t.ret, kind: 'live news' }))].sort((x, y) => x.d.localeCompare(y.d));
  const won = all.filter((x) => x.result > 0).length, avg = all.length ? all.reduce((s, x) => s + x.result, 0) / all.length : 0;
  // forward test: each strategy's live trades next to what the research expects (research/37-40, after charges)
  const RESEARCH = { 'Bounce-back': [0.0167, 0.53], 'Short (failed bounce)': [0.0212, 0.67], 'Gap & Go': [0.0029, 0.54], 'Panic rebound': [0.016, null], 'Strong news': [0.012, 0.53] };
  const fwd = Object.entries(RESEARCH).map(([k, [ra, rw]]) => {
    const t = all.filter((x) => x.kind === k); if (!t.length) return '';
    const a = t.reduce((s, x) => s + x.result, 0) / t.length, w = t.filter((x) => x.result > 0).length / t.length;
    const verdict = t.length < 20 ? `${20 - t.length} more trades before judging` : a >= ra / 2 ? 'on track ✅' : a > 0 ? 'weaker than research ⚠' : 'losing — rethink ❌';
    return `<div class="track-row"><span><b>${esc(k)}</b> · ${t.length} trades · ${Math.round(w * 100)}% won<br><span style="color:var(--muted)">research: ${pct(ra)} a trade${rw ? `, ${Math.round(rw * 100)}% won` : ''} · ${verdict}</span></span>${plain(a)}</div>`;
  }).join('');
  const missed = (n.best?.history ?? []).flatMap((h) => h.missed ?? []).length;
  const score = all.length ? `<div class="track" style="margin-top:0"><div class="stats"><div class="stat"><b>${all.length}</b><span>trades</span></div><div class="stat"><b>${Math.round((won / all.length) * 100)}%</b><span>won</span></div><div class="stat">${plain(avg)}<span>avg per trade</span></div></div>
    ${fwd ? `<p class="note" style="margin:8px 2px 4px"><b>Forward test — live vs research</b>${missed ? ` · ${missed} pick${missed > 1 ? 's' : ''} not filled (opened outside the limit)` : ''}</p>${fwd}<p class="note" style="margin:8px 2px 4px"><b>Last trades</b></p>` : ''}
    ${all.slice(-12).reverse().map((x) => `<div class="track-row"><span>${esc(x.d.slice(5))} · <b>${esc(x.symbol)}</b> <span style="color:var(--muted)">${x.kind}</span></span>${plain(x.result)}</div>`).join('')}
    <p class="note">After charges. Judge each strategy after about 20 live trades: near its research number = real edge.</p></div>` : '';
  const when = n.updated ? new Date(n.updated).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : null;
  el.innerHTML = answerBox(n, today, l) +
    (bad ? `<details class="more fold"><summary>⛔ Bad news (${(l?.badNews ?? []).length + (p?.bad ?? []).filter((s) => !liveBad.has(s)).length}) · sell if you hold one ${CHEVRON}</summary>${box(bad)}</details>` : '') +
    section('📊', 'Scorecard', 'Every TODAY’S BUY and BUY NOW trade so far, after charges.', score, 'No finished trades yet.') +
    watchOnly(n, today, { live, open, at930, gapRows, panic, good, p, g, pr }) +
    (when ? `<p class="note" style="text-align:center">Live data updated ${esc(when)}${p?.mode === 'keyword' ? ' · rough keyword reading (no Claude key)' : ''}</p>` : '');
}

// ---- The one box that answers "what do I do today?" ----
const istMin = () => { const d = new Date(Date.now() + 19800e3); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
function answerBox(n, today, l) {
  const now = istMin(), dow = new Date(Date.now() + 19800e3).getUTCDay();
  const b = n.best?.date === today ? n.best : null, f = n.final?.date === today ? n.final : null;
  // the newer of the two records wins (best gets the real opening prices at ~9:13)
  const src = b?.levelsSent ? b : f ?? b;
  const picks = src?.picks ?? [], shorts = src?.shorts ?? [];
  const cancelled = b?.cancelled ?? [], avoided = b?.avoided ?? [];
  const liveTrades = l?.trades ?? [];
  const closed = now >= 15 * 60 + 30;
  const card = (cls, tag, title, body) => `<section class="answer ${cls}"><small>${esc(tag)}</small><h2>${title}</h2>${body}</section>`;
  const line = (k, v) => `<div class="kv"><span>${esc(k)}</span><b>${v}</b></div>`;

  let main;
  if (dow === 0 || dow === 6) main = card('r-none', 'Today', 'Market closed', '<p>Weekend. The next buy list comes at about 9:05:30 am on the next market day.</p>');
  else if (!b && now < 9 * 60 + 6) main = card('r-good', 'Today · waiting', '⏳ Wait for 9:05:30 am', '<p>The buy list comes at <b>about 9:05:30 am</b> on your phone and here. <b>Do not buy anything before it.</b></p>');
  else if (!b && !liveTrades.length) main = card('r-none', 'Today', 'No list today', '<p>The morning check did not run (holiday, or NSE did not answer). <b>No buy.</b></p>');
  else if (picks.length || shorts.length) {
    const half = picks.some((x) => x.level === 1);
    // after ~9:13 the record has the real opening price: show what happened and the exact levels
    const opened = (x, verb) => (x.open == null ? '' : x.filled
      ? `<p class="why pos"><b>Opened ₹${esc(x.open)} — you are ${verb} at ₹${esc(x.open)}.</b> Levels below are exact.</p>`
      : `<p class="why neg"><b>Opened ₹${esc(x.open)} — NOT filled.</b> Cancel the order, do not chase.</p>`);
    const buyHtml = picks.map((x) => `<div class="pick"><div class="pick-head"><b>${esc(x.symbol)}</b><span>${esc(x.kind)}${x.level === 1 ? ' · HALF money' : ''}</span></div>
        ${opened(x, 'bought')}
        ${line('1. Buy (limit order)', `₹${esc(x.limit)} <em>before 9:08 am</em>`)}
        ${x.targetPrice ? line('2. Sell UP at', `<span class="pos">₹${esc(x.targetPrice)}</span>`) : line('2. Sell when', '<span class="pos">it falls 1.5% from its best</span>')}
        ${line(x.targetPrice ? '3. Sell DOWN at' : '3. Or DOWN at', `<span class="neg">₹${esc(x.stopPrice)}</span>`)}
        ${line('4. Otherwise sell at', '3:20 pm')}
        <p class="why">${esc(x.why)}</p></div>`).join('');
    const shortHtml = shorts.map((x) => `<div class="pick"><div class="pick-head"><b>${esc(x.symbol)}</b><span>SHORT · sell first, buy back today</span></div>
        ${opened(x, 'short')}
        ${line('1. SELL first (Intraday, limit)', `₹${esc(x.limit)} <em>before 9:08 am</em>`)}
        ${line('2. Right after: stop-loss market BUY', `<span class="neg">₹${esc(x.stopPrice)}</span>`)}
        ${line('3. Buy back (target) at', `<span class="pos">₹${esc(x.targetPrice)}</span>`)}
        ${line('4. Otherwise buy back at', '3:20 pm')}
        <p class="why">${esc(x.why)}</p></div>`).join('');
    const title = [picks.length ? `BUY ${picks.map((x) => esc(x.symbol)).join(' + ')}` : '', shorts.length ? `SHORT ${shorts.map((x) => esc(x.symbol)).join(' + ')}` : ''].filter(Boolean).join(' · ');
    const n2 = picks.length + shorts.length;
    main = card('r-excellent', `Today · ${n2} trade${n2 > 1 ? 's' : ''}`, `✅ ${title}`, buyHtml + shortHtml +
      `<p class="rule">${n2 > 1 ? `Split your money equally. ` : ''}${half ? 'HALF money on the one marked. ' : ''}Not filled at the open? <b>Do not chase</b> — cancel the order at 9:15.${shorts.length ? ' A short MUST have its stop-loss order in place; never hold it overnight.' : ''} Exact levels from the real opening price come at about 9:13.</p>`);
  } else main = card('r-none', "Today's buy", '🚫 NO BUY TODAY', `<p><b>Keep your money.</b> Nothing was strong enough this morning${b?.marketGap != null ? ` (market opened ${esc(pct(b.marketGap))})` : ''}. On weak days not trading is the winning move.</p>`);

  const notes = [
    ...cancelled.map((c) => `<li class="neg"><b>${esc(c.symbol)} cancelled</b> — pre-open moved to ${esc(c.gap != null ? pct(c.gap) : '?')}. Do not buy it.</li>`),
    ...avoided.map((a) => `<li class="neg"><b>${esc(a.symbol)} removed</b> by the news check — ${esc(a.reason)}</li>`),
  ];
  const live = liveTrades.map((t) => { const sold = t.ret != null; return `<li><b>🚀 ${esc(t.symbol)}</b> BUY NOW at ${esc(t.at)} ₹${esc(t.px.toFixed(2))} — ${sold ? `sold ${esc(t.exitAt)}, ${plain(t.ret)}` : '<b>holding</b>: SELL NOW comes on your phone'}</li>`; });
  const extra = (notes.length || live.length ? `<ul class="answer-notes">${[...live, ...notes].join('')}</ul>` : '') +
    `<p class="note">${closed ? 'Market closed. Today’s results go into the scorecard tomorrow morning.' : 'Live BUY NOW alerts can still come on strong news until 2:45 pm.'} <b>Only buy what is in this box.</b></p>`;
  return main.replace(/<\/section>$/, `${extra}</section>`);
}

// ---- Everything else: watch only, folded away so it never looks like a buy ----
function watchOnly(n, today, s) {
  const cancelled = new Set((n.best?.date === today ? n.best.cancelled ?? [] : []).map((c) => c.symbol));
  const mark = (html) => html.replace(/9:30 buy|At open|HIGH|Watch/g, 'Watch only').replace(/Limit buy/g, 'Test rule: limit')
    .replace(/Bought ~/g, 'Price ~').replace(/<span>opening<\/span>/g, '<span>pre-open</span>');
  const body = `<p class="note" style="margin:0 2px 8px">These are for learning and testing. <b>Do not buy them</b> unless they also appear in the box at the top.</p>` +
    section('🌅', 'Opening strong on news', 'Strong overnight news and pre-open +5% or more.', mark(s.open), s.p?.preopenDone ? 'None today.' : 'Comes at 9:04-9:08 am.') +
    section('✅', 'Still strong at 9:30', "Strong overnight news, still above its open at 9:30.", mark(s.at930), s.p?.confirmed ? 'None today.' : 'Comes at 9:31 am.') +
    section('🎯', 'Gap & Go (results)', 'Results beat last quarter AND last year, stock opens 5-20% up.', s.gapRows, s.g ? 'No GO today.' : 'Watch list 8:30 am, GO list 9:03 am.') +
    section('📉', 'Panic rebound', 'Fell 3%+ yesterday, pre-open 3-5% down again. Prices shown are pre-open prices, not the real open.', mark(s.panic), s.pr ? `None today. Market opening ${pct(s.pr.marketGap ?? 0)}.` : 'Comes at about 9:04 am.') +
    section('👀', 'Good news', 'Good news, but no buy signal.', box(s.good), s.p ? 'No strong good news overnight.' : 'The morning list comes at 7:50-8:25 am.');
  const withCancel = [...cancelled].reduce((h, sym) => h.replaceAll(`<b>${sym}</b>`, `<b>${sym} <span class="neg">· cancelled</span></b>`), body);
  return `<details class="more fold"><summary>👀 Watch only — do not buy ${CHEVRON}</summary>${withCancel}</details>`;
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

let lastJson = '';
async function load() {
  const updated = document.getElementById('updated');
  try {
    const fresh = await fetchData();
    const js = JSON.stringify(fresh);
    if (js === lastJson) return; // nothing new: keep the screen (and any open card) as it is
    lastJson = js;
    data = fresh;
  } catch {
    if (data) return; // a failed background refresh keeps what is on screen
    updated.textContent = 'No ratings yet';
    document.getElementById('days').innerHTML = '<p class="empty">No ratings yet. Check back after the next update.</p>';
    return;
  }
  // Show the newest time: live news data during the day, the evening ratings otherwise.
  const newest = [data.news?.updated, data.generated].filter(Boolean).map((x) => new Date(x)).sort((a, b) => b - a)[0];
  const sameDay = newest && new Date(+newest + 19800e3).toISOString().slice(0, 10) === istToday();
  updated.textContent = newest ? `${sameDay ? 'Today' : newest.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })} · updated ${newest.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })}` : 'Loading...';
  renderSide();
  renderFilters();
  renderDays();
  renderIpos();
  renderGapGo();
  renderNews();
}

load();
// Stay fresh: every 20 seconds while the app is on screen, and at once when you come back to it.
setInterval(() => { if (!document.hidden) load(); }, 20000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
