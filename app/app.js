const CLASS = { 'Max Confidence': 'max', Excellent: 'excellent', Good: 'good', Bad: 'bad', 'No data': 'none' };
const FILTERS = ['All', 'Max Confidence', 'Excellent', 'Good', 'Bad'];
let data = null;
let filter = 'All';

// Company data comes from outside sources, so always insert it as escaped text.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const asDate = (iso) => new Date(iso + 'T00:00:00');
const dayName = (iso) => asDate(iso).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
const pct = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;

function historyLine(label) {
  const h = data.history[label];
  return h ? `In past results, this rating won ${(h.winRate * 100).toFixed(0)}% of trades, average ${pct(h.avgReturn)} per trade (${h.trades.toLocaleString('en-IN')} trades).` : '';
}

function planHtml(c) {
  if (c.label === 'Bad' || c.label === 'No data') return '<div class="plan">Skip this one.</div>';
  if (c.tooLate) return '<div class="plan">Too late to buy on the plan, results are too close.</div>';
  const stop = c.lastClose ? ` Near last close of Rs ${c.lastClose.toFixed(1)}, that is about Rs ${(c.lastClose * (1 - data.stopLossPct / 100)).toFixed(1)}.` : '';
  return `<div class="plan"><b>Buy:</b> ${esc(dayName(c.buyOn))}${c.late ? ' (a day late)' : ''}<br><b>Stop-loss:</b> ${data.stopLossPct}% below your buy price.${esc(stop)}<br><b>Sell:</b> by close on ${esc(dayName(c.sellOn))}</div>`;
}

function companyHtml(c) {
  return `<details class="company">
    <summary>
      <div class="name"><b>${esc(c.company)}</b><span class="muted">${esc(c.quarter)} result</span></div>
      <span class="badge ${CLASS[c.label]}">${esc(c.label)}</span>
    </summary>
    <div class="detail">
      <ul>${c.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
      <p class="muted">${esc(historyLine(c.label))}</p>
      ${planHtml(c)}
    </div>
  </details>`;
}

function renderPick() {
  const el = document.getElementById('pick');
  const all = data.days.flatMap((d) => d.companies);
  const c = all.find((x) => x.symbol === data.pick && x.date === data.pickDate);
  if (!c) {
    el.innerHTML = '<div class="pick none"><small>This week\'s pick</small><h2>No trade</h2>Nothing is strong enough with time left to buy.</div>';
    return;
  }
  el.innerHTML = `<div class="pick">
    <small>This week's pick</small>
    <h2>${esc(c.company)}</h2>
    <ul>
      <li>${esc(c.quarter)} result on ${esc(dayName(c.date))}, rated ${esc(c.label)}</li>
      <li>Buy on ${esc(dayName(c.buyOn))}, near the close</li>
      <li>Stop-loss ${data.stopLossPct}% below your buy price</li>
      <li>Sell by close on ${esc(dayName(c.sellOn))}</li>
    </ul>
  </div>`;
}

function renderFilters() {
  const all = data.days.flatMap((d) => d.companies);
  const count = (f) => (f === 'All' ? all.length : all.filter((c) => c.label === f).length);
  const el = document.getElementById('filters');
  el.innerHTML = FILTERS.map((f) => `<button type="button" data-f="${esc(f)}" aria-pressed="${f === filter}">${esc(f)} ${count(f)}</button>`).join('');
  el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { filter = b.dataset.f; renderFilters(); renderDays(); }));
}

function renderDays() {
  const html = data.days.map((d) => {
    const list = d.companies.filter((c) => filter === 'All' || c.label === filter);
    if (!list.length) return '';
    return `<section class="day"><h2>${esc(dayName(d.date))}<span>${list.length} ${list.length === 1 ? 'company' : 'companies'}</span></h2>${list.map(companyHtml).join('')}</section>`;
  }).join('');
  document.getElementById('days').innerHTML = html || '<p class="empty">No companies to show.</p>';
}

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
    updated.textContent = 'No ratings yet. Check back after the next update.';
    return;
  }
  updated.textContent = `Updated ${new Date(data.generated).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}`;
  renderPick();
  renderFilters();
  renderDays();
}

load();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
