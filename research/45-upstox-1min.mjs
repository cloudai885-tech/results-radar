// Step 45: 1-minute candles for every liquid NSE stock from Upstox (free, history since Jan 2022).
// Needs today's token: run `node upstox-login.mjs` first (token in .upstox-token.json, never committed).
// Universe: data/research/upstox-universe.json (median Rs 1 cr+/day since 2022, in Upstox's current list).
// Output: data/research/min1/<SYMBOL>.bin.gz = Int32 rows [yyyymmdd, hhmm, open*100, high*100, low*100, close*100, volume]
// One file per stock, written when the stock is complete, so a rerun skips finished stocks (resume).
//   node research/45-upstox-1min.mjs              all stocks
//   node research/45-upstox-1min.mjs RELIANCE     one stock (test)
import fs from 'node:fs';
import zlib from 'node:zlib';

const DIR = new URL('../data/research/', import.meta.url);
const OUT = new URL('min1/', DIR); fs.mkdirSync(OUT, { recursive: true });
const token = JSON.parse(fs.readFileSync('.upstox-token.json', 'utf8')).access_token;
const keys = new Map(JSON.parse(fs.readFileSync(new URL('upstox-instruments.json', DIR), 'utf8')).map((x) => [x.s, x.k]));
const only = process.argv[2];
const universe = only ? [only] : JSON.parse(fs.readFileSync(new URL('upstox-universe.json', DIR), 'utf8'));
const FROM = '2022-01-01', TO = new Date(Date.now() + 19800e3 - 864e5).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// month windows (Upstox allows max 1 month per request for 1-minute candles)
const windows = [];
for (let d = new Date(FROM + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= TO; d.setUTCMonth(d.getUTCMonth() + 1)) {
  const a = d.toISOString().slice(0, 10), e = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  windows.push([a, e < TO ? e : TO]);
}

let calls = 0, fails = 0;
async function get(key, a, b) {
  const url = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(key)}/minutes/1/${b}/${a}`;
  for (let t = 0; t < 6; t++) {
    const res = await fetch(url, { headers: { accept: 'application/json', Authorization: `Bearer ${token}` } }).catch(() => null);
    calls++;
    if (res?.status === 429 || !res || res.status >= 500) { await sleep(1000 * 2 ** t); continue; }
    if (res.status === 401) { console.log('Token expired or invalid: run  node upstox-login.mjs  again, then rerun this (it resumes).'); process.exit(1); }
    const j = await res.json().catch(() => null);
    if (!res.ok) { fails++; return { err: `${res.status} ${j?.errors?.[0]?.message ?? ''}` }; }
    return { candles: j?.data?.candles ?? [] };
  }
  fails++; return { err: 'gave up after retries' };
}

async function stock(sym) {
  const file = new URL(`${sym}.bin.gz`, OUT);
  if (fs.existsSync(file) && !only) return 'skip';
  const key = keys.get(sym); if (!key) return 'no key';
  const rows = [];
  for (const [a, b] of windows) {
    const r = await get(key, a, b);
    if (r.err) { if (only) console.log(`  ${a}: ${r.err}`); continue; }
    for (const c of r.candles) { // [ts, o, h, l, c, vol, oi], newest first
      const ts = c[0]; // 2025-01-02T09:15:00+05:30
      rows.push([+ts.slice(0, 10).replaceAll('-', ''), +(ts.slice(11, 13) + ts.slice(14, 16)), Math.round(c[1] * 100), Math.round(c[2] * 100), Math.round(c[3] * 100), Math.round(c[4] * 100), Math.min(2 ** 31 - 1, c[5] | 0)]);
    }
  }
  rows.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const buf = Buffer.from(Int32Array.from(rows.flat()).buffer);
  fs.writeFileSync(file, zlib.gzipSync(buf, { level: 6 }));
  return `${rows.length} bars, ${new Set(rows.map((r) => r[0])).size} days`;
}

const t0 = Date.now(); let done = 0;
const queue = [...universe];
await Promise.all([...Array(only ? 1 : 4)].map(async () => {
  while (queue.length) {
    const s = queue.shift(); const r = await stock(s); done++;
    if (only || done % 25 === 0) console.log(`  ${done}/${universe.length} ${s}: ${r} | ${calls} calls, ${fails} failed, ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  }
}));
console.log(`Finished: ${done} stocks, ${calls} calls, ${fails} failed windows, ${((Date.now() - t0) / 60000).toFixed(1)} min.`);
