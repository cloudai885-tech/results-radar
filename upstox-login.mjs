// Daily Upstox login (SEBI rule: the access token expires every day, ~3:30 am).
// Keys come from .env (never committed): UPSTOX_API_KEY, UPSTOX_API_SECRET, UPSTOX_REDIRECT (https://127.0.0.1).
// Run in a terminal:  node upstox-login.mjs
// 1. open the printed link, log in to Upstox
// 2. the browser lands on https://127.0.0.1/?code=... ("site can't be reached" is NORMAL) - copy that whole address
// 3. paste it here. The token is saved to .upstox-token.json (also never committed).
import fs from 'node:fs';
import readline from 'node:readline/promises';

const env = Object.fromEntries((fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '').split(/\r?\n/)
  .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]));
const key = env.UPSTOX_API_KEY, secret = env.UPSTOX_API_SECRET, redirect = env.UPSTOX_REDIRECT || 'https://127.0.0.1';
if (!key || !secret) { console.log('Missing UPSTOX_API_KEY / UPSTOX_API_SECRET in .env'); process.exit(1); }

console.log('\n1. Open this link and log in:\n');
console.log(`https://api.upstox.com/v2/login/authorization/dialog?response_type=code&client_id=${encodeURIComponent(key)}&redirect_uri=${encodeURIComponent(redirect)}\n`);
console.log('2. After login the page shows "site can\'t be reached" - that is normal. Copy the whole address from the address bar.\n');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const pasted = (await rl.question('3. Paste it here and press Enter: ')).trim();
rl.close();
const code = pasted.includes('code=') ? new URL(pasted).searchParams.get('code') : pasted;
if (!code) { console.log('No code found in what you pasted.'); process.exit(1); }

const res = await fetch('https://api.upstox.com/v2/login/authorization/token', {
  method: 'POST',
  headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ code, client_id: key, client_secret: secret, redirect_uri: redirect, grant_type: 'authorization_code' }),
});
const j = await res.json().catch(() => ({}));
if (!res.ok || !j.access_token) { console.log(`Login failed (${res.status}): ${j.errors?.[0]?.message ?? JSON.stringify(j).slice(0, 200)}`); process.exit(1); }
fs.writeFileSync('.upstox-token.json', JSON.stringify({ access_token: j.access_token, saved: new Date().toISOString() }));

// quick check that data works (prints no personal details)
const q = await fetch('https://api.upstox.com/v2/market-quote/ltp?instrument_key=NSE_INDEX%7CNifty%2050', { headers: { accept: 'application/json', Authorization: `Bearer ${j.access_token}` } });
const qj = await q.json().catch(() => ({}));
const ltp = Object.values(qj.data ?? {})[0]?.last_price;
console.log(ltp ? `\nDONE. Token saved. Test: Nifty 50 = ${ltp}` : `\nToken saved, but the data test answered ${q.status}: ${JSON.stringify(qj).slice(0, 200)}`);
