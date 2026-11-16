// Step 10a: bulk and block deal history (who bought/sold big, by name). NSE's history API is used month by month.
// The NSE website blocks some networks, so this is meant to run on GitHub Actions (research-deals.yml).
// Output: data/research/deals.json = [{ date, symbol, client, side, qty, price, kind: 'bulk' | 'block' }]
import fs from 'node:fs';
import { nseJson } from '../src/sources.mjs';

const FROM = process.argv[2] || '2024-01-01';
const TO = process.argv[3] || new Date(Date.now() + 19800e3).toISOString().slice(0, 10);
const OUT = new URL('../data/research/deals.json', import.meta.url);
fs.mkdirSync(new URL('../data/research/', import.meta.url), { recursive: true });
const nse = (iso) => iso.split('-').reverse().join('-');
const MON = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
const isoOf = (s) => { const m = /(\d+)-([A-Za-z]{3})-(\d{4})/.exec(s ?? ''); return m ? `${m[3]}-${MON[m[2].toUpperCase()]}-${m[1].padStart(2, '0')}` : null; };
const pick = (o, ...keys) => { for (const k of keys) if (o[k] != null && o[k] !== '') return o[k]; return null; };

// quick test first so a blocked network fails in a minute
const probe = await nseJson(`historical/bulk-deals?from=01-10-2025&to=10-10-2025`, 0, { timeoutMs: 45000, attempts: 2 }).catch((e) => String(e));
if (!probe || typeof probe === 'string') { console.error('NSE history API not answering:', probe); process.exit(1); }
console.log('NSE answers. Sample record:', JSON.stringify((probe.data ?? probe)[0] ?? probe).slice(0, 300));

const all = [];
for (let d = new Date(FROM.slice(0, 8) + '01T00:00:00Z'); d <= new Date(TO + 'T00:00:00Z'); d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
  const a = d.toISOString().slice(0, 10), endD = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const b = endD > TO ? TO : endD;
  for (const kind of ['bulk', 'block']) {
    const j = await nseJson(`historical/${kind}-deals?from=${nse(a)}&to=${nse(b)}`, 1e7, { timeoutMs: 90000, attempts: 3 }).catch(() => null);
    const list = Array.isArray(j) ? j : j?.data ?? [];
    for (const x of list) {
      const date = isoOf(pick(x, 'BD_DT_DATE', 'date', 'mTIMESTAMP', 'BD_DT'));
      const symbol = pick(x, 'BD_SYMBOL', 'symbol');
      if (!date || !symbol) continue;
      all.push({ date, symbol, client: String(pick(x, 'BD_CLIENT_NAME', 'clientName') ?? ''), side: String(pick(x, 'BD_BUY_SELL', 'buySell') ?? '').toUpperCase().startsWith('B') ? 'BUY' : 'SELL', qty: Number(pick(x, 'BD_QTY_TRD', 'quantityTraded', 'qty')) || 0, price: Number(pick(x, 'BD_TP_WATP', 'tradePrice', 'watp')) || 0, kind });
    }
    console.log(`  ${a} ${kind}: ${list.length}`);
  }
}
fs.writeFileSync(OUT, JSON.stringify(all));
console.log(`Saved ${all.length} deals.`);
