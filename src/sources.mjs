// Data access: NSE (events, universe, holidays), Yahoo (prices), Screener (quarterly numbers).
// Every response is cached on disk so reruns are cheap and we stay polite to these sites.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(ROOT, 'data', 'cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One request at a time per host, with a minimum gap between them.
const gates = new Map();
const GAP_MS = { 'www.nseindia.com': 450, 'query1.finance.yahoo.com': 250, 'www.screener.in': 3000 };
// When a site says "slow down", every request to that site waits, not just the one that was refused.
const pausedUntil = new Map();
function gated(host, fn) {
  const prev = gates.get(host) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    const wait = (pausedUntil.get(host) ?? 0) - Date.now();
    if (wait > 0) await sleep(wait);
    try { return await fn(); } finally { await sleep(GAP_MS[host] ?? 300); }
  });
  gates.set(host, run);
  return run;
}

function cachePath(url) {
  return path.join(CACHE_DIR, crypto.createHash('sha1').update(url).digest('hex') + '.cache');
}

async function fetchCached(url, { ttlHours, headers = {}, onStatus } = {}) {
  const file = cachePath(url);
  if (fs.existsSync(file) && (Date.now() - fs.statSync(file).mtimeMs) / 36e5 < ttlHours) {
    return fs.readFileSync(file, 'utf8');
  }
  const host = new URL(url).host;
  let lastError;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await gated(host, async () => {
      try {
        const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', ...headers }, signal: AbortSignal.timeout(30000) });
        return { status: r.status, body: await r.text(), retryAfter: Number(r.headers.get('retry-after')) || 0 };
      } catch (e) {
        return { status: 0, body: String(e) };
      }
    });
    if (res.status === 200) {
      fs.writeFileSync(file, res.body);
      return res.body;
    }
    if (res.status === 404) return null;
    lastError = `HTTP ${res.status} for ${url}`;
    console.warn(`  ${host} answered ${res.status}${res.retryAfter ? `, retry after ${res.retryAfter}s` : ''} (attempt ${attempt})`);
    if (onStatus) await onStatus(res.status);
    if (res.status === 429) pausedUntil.set(host, Date.now() + (res.retryAfter || 60) * 1000);
    else await sleep(1500 * attempt);
  }
  throw new Error(lastError);
}

// ---- NSE ----------------------------------------------------------------
let nseCookie = null;
async function nseRefreshCookie() {
  const r = await gated('www.nseindia.com', () =>
    fetch('https://www.nseindia.com/companies-listing/corporate-filings-event-calendar', {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html' },
      signal: AbortSignal.timeout(30000),
    }));
  await r.text();
  nseCookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

async function nseJson(apiPath, ttlHours) {
  const url = 'https://www.nseindia.com/api/' + apiPath;
  const cached = cachePath(url);
  const fresh = fs.existsSync(cached) && (Date.now() - fs.statSync(cached).mtimeMs) / 36e5 < ttlHours;
  if (!nseCookie && !fresh) await nseRefreshCookie();
  // Headers are read per attempt through the getter so a refreshed cookie is used on retry.
  const headers = { Accept: 'application/json', Referer: 'https://www.nseindia.com/companies-listing/corporate-filings-event-calendar', get Cookie() { return nseCookie ?? ''; } };
  const body = await fetchCached(url, { ttlHours, headers, onStatus: (s) => (s === 0 || s === 401 || s === 403 ? nseRefreshCookie().catch(() => {}) : undefined) });
  return body ? JSON.parse(body) : null;
}

const MON = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
const isoFromNse = (s) => { const [d, m, y] = s.trim().split(' ')[0].split('-'); return `${y}-${MON[m]}-${d.padStart(2, '0')}`; };
const isResultsMeeting = (text) => /financial\s+result|quarterly\s+result|unaudited|audited\s+(financial|result)|\bresults?\b/i.test(text ?? '');

export async function nifty500() {
  const csv = await fetchCached('https://nsearchives.nseindia.com/content/indices/ind_nifty500list.csv', { ttlHours: 24 * 7 });
  return csv.trim().split(/\r?\n/).slice(1).map((line) => {
    // Company names can contain commas, so read the fixed columns from the right.
    const p = line.split(',');
    return { symbol: p.at(-3).trim(), company: p.slice(0, -4).join(',').replace(/"/g, '').trim(), industry: p.at(-4).trim() };
  });
}

export async function eventCalendar() {
  const j = await nseJson('event-calendar?index=equities', 6);
  return j.filter((e) => /financial results/i.test(e.purpose)).map((e) => ({ symbol: e.symbol, company: e.company, date: isoFromNse(e.date), desc: e.bm_desc }));
}

export async function pastResultDates(symbol, fromDDMMYYYY, toDDMMYYYY) {
  const q = `corporate-board-meetings?index=equities&symbol=${encodeURIComponent(symbol)}&from_date=${fromDDMMYYYY}&to_date=${toDDMMYYYY}`;
  const j = (await nseJson(q, 24 * 7)) ?? [];
  const dates = j.filter((m) => isResultsMeeting(m.bm_desc)).map((m) => isoFromNse(m.bm_date));
  return [...new Set(dates)].sort();
}

// Company announcements between two dates (ISO), newest first.
export async function announcements(fromIso, toIso, ttlHours = 0.25) {
  const nse = (iso) => iso.split('-').reverse().join('-');
  return (await nseJson(`corporate-announcements?index=equities&from_date=${nse(fromIso)}&to_date=${nse(toIso)}`, ttlHours)) ?? [];
}

// Pre-open session (9:00-9:08): expected opening price (IEP) and previous close for every stock.
export async function preOpen(ttlHours = 0.05) {
  const j = await nseJson('market-data-pre-open?key=ALL', ttlHours);
  return new Map((j?.data ?? []).map((r) => [r.metadata.symbol, { iep: r.metadata.iep, prevClose: r.metadata.previousClose, time: r.detail?.preOpenMarket?.lastUpdateTime ?? '' }]));
}

export async function holidays() {
  const j = await nseJson('holiday-master?type=trading', 24 * 7);
  return new Set((j.CM ?? []).map((h) => isoFromNse(h.tradingDate)));
}

// ---- Yahoo --------------------------------------------------------------
export async function dailyBars(yahooSymbol, range = '5y', ttlHours = 6) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=${range}&interval=1d`;
  const body = await fetchCached(url, { ttlHours });
  if (!body) return null;
  const r = JSON.parse(body).chart?.result?.[0];
  if (!r?.timestamp) return null;
  const q = r.indicators.quote[0];
  const bars = [];
  r.timestamp.forEach((t, i) => {
    if (q.close[i] == null || q.open[i] == null || q.low[i] == null) return;
    bars.push({ date: new Date((t + 19800) * 1000).toISOString().slice(0, 10), open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] ?? 0 });
  });
  return bars;
}

// One day's NSE delivery file: how many shares were really taken home, per stock.
export async function deliveryDay(iso) {
  const [y, m, d] = iso.split('-');
  const csv = await fetchCached(`https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${d}${m}${y}.csv`, { ttlHours: 1e7 });
  if (!csv) return null;
  const lines = csv.trim().split(/\r?\n/);
  const head = lines[0].split(',').map((x) => x.trim());
  const col = (name) => head.indexOf(name);
  const day = new Map();
  for (const line of lines.slice(1)) {
    const p = line.split(',').map((x) => x.trim());
    if (p[col('SERIES')] === 'EQ') day.set(p[col('SYMBOL')], { trades: Number(p[col('NO_OF_TRADES')]), delivered: Number(p[col('DELIV_QTY')]), deliveryPct: Number(p[col('DELIV_PER')]) });
  }
  return day;
}

// ---- IPOs ---------------------------------------------------------------
export const ipoPage = () => fetchCached('https://www.investorgain.com/report/live-ipo-gmp/331/', { ttlHours: 3 });

// ---- Screener -----------------------------------------------------------
const num = (s) => { const v = parseFloat(String(s).replace(/,|%|&nbsp;/g, '').trim()); return Number.isFinite(v) ? v : null; };
const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

export function parseScreener(html) {
  const start = html.indexOf('id="quarters"');
  if (start < 0) return null;
  const section = html.slice(start, html.indexOf('</section>', start));
  const headers = [...section.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => strip(m[1])).slice(1);
  const rows = {};
  for (const m of section.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => strip(c[1]));
    if (cells.length > 1) rows[cells[0].replace(/\s*\+\s*$/, '').trim()] = cells.slice(1).map(num);
  }
  const pick = (re) => { const k = Object.keys(rows).find((x) => re.test(x)); return k ? rows[k] : []; };
  const sales = pick(/^(sales|revenue)/i);
  const pat = pick(/^net profit/i);
  const opm = pick(/^(opm|financing margin)/i);
  const otherIncome = pick(/^other income/i);
  const pbt = pick(/^profit before tax/i);
  const eps = pick(/^eps/i);
  const quarters = new Map();
  headers.forEach((h, i) => {
    const ord = quarterOrdinal(h);
    if (ord != null) quarters.set(ord, { label: h, sales: sales[i] ?? null, pat: pat[i] ?? null, opm: opm[i] ?? null, otherIncome: otherIncome[i] ?? null, pbt: pbt[i] ?? null, eps: eps[i] ?? null });
  });

  // Who owns the stock, quarter by quarter. Only the first table is quarterly.
  const holdings = new Map();
  const holdStart = html.indexOf('id="shareholding"');
  if (holdStart >= 0) {
    const table = html.slice(holdStart, html.indexOf('</table>', holdStart));
    const holdHeaders = [...table.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => strip(m[1])).slice(1);
    const holdRows = {};
    for (const m of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => strip(c[1]));
      if (cells.length > 1) holdRows[cells[0].replace(/\s*\+\s*$/, '').trim()] = cells.slice(1).map(num);
    }
    holdHeaders.forEach((h, i) => {
      const ord = quarterOrdinal(h);
      if (ord != null) holdings.set(ord, { promoter: holdRows.Promoters?.[i] ?? null, fii: holdRows.FIIs?.[i] ?? null, dii: holdRows.DIIs?.[i] ?? null, holders: holdRows['No. of Shareholders']?.[i] ?? null });
    });
  }
  const level = (title) => new RegExp(`title="${title}"[^>]*>([^<]+)<`).exec(html)?.[1]?.replace(/&amp;/g, '&').trim() ?? null;
  const classification = { sector: level('Sector'), broadIndustry: level('Broad Industry'), industry: level('Industry') };
  const ratio = (name) => {
    const m = html.match(new RegExp(`${name}[\\s\\S]{0,250}?<span class="number">([\\d,.]+)</span>`));
    return m ? num(m[1]) : null;
  };
  return { quarters, holdings, classification, marketCapCr: ratio('Market Cap'), pe: ratio('Stock P/E') };
}

const QIDX = { Mar: 0, Jun: 1, Sep: 2, Dec: 3 };
export function quarterOrdinal(label) {
  const m = /^([A-Z][a-z]{2}) (\d{4})$/.exec(label ?? '');
  return m && m[1] in QIDX ? Number(m[2]) * 4 + QIDX[m[1]] : null;
}
export const ordinalLabel = (o) => `${['Mar', 'Jun', 'Sep', 'Dec'][o % 4]} ${Math.floor(o / 4)}`;

export async function fundamentals(symbol, ttlHours = 24) {
  const code = encodeURIComponent(symbol);
  const load = async (suffix) => {
    const body = await fetchCached(`https://www.screener.in/company/${code}/${suffix}`, { ttlHours });
    return body ? parseScreener(body) : null;
  };
  const consolidated = await load('consolidated/');
  const hasData = (d) => d && [...d.quarters.values()].filter((q) => q.pat != null).length >= 6;
  if (hasData(consolidated)) return consolidated;
  const standalone = await load('');
  return hasData(standalone) ? standalone : null;
}

// Runs fn over items with a small worker pool; a failure on one item never stops the rest.
export async function mapPool(items, size, fn, onProgress) {
  const out = new Array(items.length);
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i]); } catch (e) { out[i] = { error: e.message, item: items[i] }; }
      done++;
      if (onProgress) onProgress(done, items.length);
    }
  }));
  return out;
}
