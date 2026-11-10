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
  return `<p class="note">About ${shares} shares, ${esc(money(shares * c.lastClose))}. A third of your money per stock, keep the rest in cash.</p>`;
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

function showTab(name) {
  document.getElementById('view-results').hidden = name !== 'results';
  document.getElementById('view-ipo').hidden = name !== 'ipo';
  document.getElementById('tab-results').setAttribute('aria-selected', String(name === 'results'));
  document.getElementById('tab-ipo').setAttribute('aria-selected', String(name === 'ipo'));
}
document.getElementById('tab-results').addEventListener('click', () => showTab('results'));
document.getElementById('tab-ipo').addEventListener('click', () => showTab('ipo'));

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
}

load();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
