// Prints what the app shows: today's TODAY'S BUY picks, CANCEL messages, Claude's removals and the scorecard.
// Read-only: uses the same public read key as the phone app (app/config.js) and never prints the key.
//   node read-picks.mjs
import fs from 'node:fs';

const cfg = fs.readFileSync(new URL('./app/config.js', import.meta.url), 'utf8');
const url = /supabaseUrl:\s*'([^']+)'/.exec(cfg)?.[1];
const key = /supabaseAnonKey:\s*'([^']+)'/.exec(cfg)?.[1];
if (!url || !key) { console.log('app/config.js has no Supabase settings.'); process.exit(1); }

const res = await fetch(`${url}/rest/v1/radar?id=eq.1&select=payload`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
if (!res.ok) { console.log(`Supabase answered ${res.status}`); process.exit(1); }
const news = (await res.json())?.[0]?.payload?.news ?? {};
const pct = (v) => (v == null ? '?' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);

const b = news.best ?? {};
console.log(`TODAY'S BUY record for ${b.date ?? '?'} (made ${b.generated ?? '?'}), market opening ${pct(b.marketGap)}`);
for (const p of [...(b.picks ?? []), ...(b.shorts ?? [])]) {
  console.log(`  ${p.symbol} - ${p.side === 'short' ? 'SHORT ' : ''}${p.kind} (level ${p.level})`);
  console.log(`    why: ${p.why}`);
  console.log(`    pre-open ₹${p.iep} (${pct(p.gap)}), buy limit ₹${p.limit}, ${p.side === "short" ? `sell limit ₹${p.limit}, stop ₹${p.stopPrice}, target ₹${p.targetPrice}` : `sell ${p.sell}`}`);
  console.log(`    Claude check: ${p.check ?? '-'}${p.result != null ? ` | result ${pct(p.result)} (${p.how})` : ''}${p.filled === false ? ' | not filled' : ''}`);
}
if (!b.picks?.length) console.log('  (no picks left in the list)');
for (const c of b.cancelled ?? []) console.log(`  CANCEL sent: ${c.symbol} (pre-open moved to ${pct(c.gap)})`);
for (const a of b.avoided ?? []) console.log(`  Claude removed: ${a.symbol} (${a.reason})`);

const f = news.final;
if (f) console.log(`\nApp list (final) for ${f.date}: ${(f.picks ?? []).map((p) => p.symbol).join(', ') || 'none'}`);

// separate Panic rebound alert (panic.mjs): HIGH = market panic morning, NORMAL = watch only, no money
const pn = news.panic;
if (pn) {
  console.log(`\nPanic rebound alert for ${pn.date}: market opening ${pct(pn.marketGap)}, ${pn.panicMorning ? 'PANIC MORNING (HIGH level possible)' : 'no market panic (NORMAL level = watch only)'}`);
  for (const p of pn.picks ?? []) console.log(`  ${p.tier.toUpperCase()} ${p.symbol}: fell ${pct(p.yRet)} yesterday, pre-open ₹${p.iep} (${pct(p.gap)}), limit ₹${p.limit}, stop ₹${p.stopPrice}${p.targetPrice ? `, target ₹${p.targetPrice}` : ''}${p.result != null ? ` | result ${pct(p.result)} (${p.howEnded})` : ''}`);
  for (const h of (pn.history ?? []).slice(-10)) console.log(`  past ${h.date}: ${h.picks.map((p) => `${p.tier === 'high' ? 'HIGH ' : ''}${p.symbol} ${pct(p.result)}`).join(', ') || 'none'}${h.day != null ? ` | basket ${pct(h.day)}` : ''}`);
}

const hist = b.history ?? [];
if (hist.length) {
  console.log('\nScorecard (past days):');
  for (const h of hist.slice(-15)) console.log(`  ${h.date}: ${h.picks.map((p) => `${p.symbol} ${p.kind} ${pct(p.result)} (${p.how})`).join(', ') || 'nothing filled'}`);
  const all = hist.flatMap((h) => h.picks);
  if (all.length) console.log(`  Total: ${all.length} trades, ${all.filter((x) => x.result > 0).length} won, avg ${pct(all.reduce((s, x) => s + x.result, 0) / all.length)} after charges`);
}
