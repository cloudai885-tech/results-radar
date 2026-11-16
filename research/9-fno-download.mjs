// Step 9a: what big players do in F&O, per stock per day, from the NSE F&O archive (one zip per trading day).
// Saves one small summary per day: data/research/fo-days/YYYY-MM-DD.json =
//   { SYMBOL: { futOI, futOIchg, futVol, futClose (nearest expiry), under, callOI, putOI, callOIchg, putOIchg, callVol, putVol } }
import fs from 'node:fs';
import zlib from 'node:zlib';

const DIR = new URL('../data/research/', import.meta.url);
const OUT = new URL('fo-days/', DIR);
fs.mkdirSync(OUT, { recursive: true });
const { days } = JSON.parse(fs.readFileSync(new URL('market.json', DIR), 'utf8'));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function unzipFirst(buf) {
  if (buf.readUInt32LE(0) !== 0x04034b50) return null;
  const method = buf.readUInt16LE(8), size = buf.readUInt32LE(18), n = buf.readUInt16LE(26), x = buf.readUInt16LE(28);
  const data = buf.subarray(30 + n + x, 30 + n + x + size);
  return (method === 8 ? zlib.inflateRawSync(data) : data).toString();
}

let done = 0, missing = 0;
for (const iso of days) {
  const file = new URL(`${iso}.json`, OUT);
  if (fs.existsSync(file)) { done++; continue; }
  const ymd = iso.replaceAll('-', '');
  let csv = null;
  for (let attempt = 1; attempt <= 3 && !csv; attempt++) {
    try {
      const r = await fetch(`https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_${ymd}_F_0000.csv.zip`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
      if (r.status === 404) break;
      if (r.ok) csv = unzipFirst(Buffer.from(await r.arrayBuffer()));
    } catch {}
    if (!csv) await sleep(2000 * attempt);
  }
  await sleep(400);
  if (!csv) { missing++; console.log(`  ${iso}: no F&O file`); continue; }
  const lines = csv.trim().split(/\r?\n/), head = lines[0].split(','), c = (k) => head.indexOf(k);
  const out = {};
  const near = {};
  for (const line of lines.slice(1)) {
    const p = line.split(',');
    const type = p[c('FinInstrmTp')], sym = p[c('TckrSymb')];
    if (type !== 'STF' && type !== 'STO') continue;
    if (p[c('TradDt')] !== iso) continue;
    const s = (out[sym] ??= { futOI: 0, futOIchg: 0, futVol: 0, futClose: null, under: null, callOI: 0, putOI: 0, callOIchg: 0, putOIchg: 0, callVol: 0, putVol: 0 });
    const oi = +p[c('OpnIntrst')] || 0, chg = +p[c('ChngInOpnIntrst')] || 0, vol = +p[c('TtlTradgVol')] || 0;
    if (type === 'STF') {
      s.futOI += oi; s.futOIchg += chg; s.futVol += vol;
      const exp = p[c('XpryDt')];
      if (!near[sym] || exp < near[sym]) { near[sym] = exp; s.futClose = +p[c('ClsPric')]; s.under = +p[c('UndrlygPric')]; }
    } else if (p[c('OptnTp')] === 'CE') { s.callOI += oi; s.callOIchg += chg; s.callVol += vol; }
    else if (p[c('OptnTp')] === 'PE') { s.putOI += oi; s.putOIchg += chg; s.putVol += vol; }
  }
  fs.writeFileSync(file, JSON.stringify(out));
  if (++done % 50 === 0) console.log(`  ${done}/${days.length} days (${iso}, ${Object.keys(out).length} F&O stocks)`);
}
console.log(`F&O summaries: ${done} days saved, ${missing} missing.`);
