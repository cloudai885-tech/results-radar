// Stand-in while the full announcement history is missing: Nifty 500 result dates from the saved NSE board-meeting lists.
// There is no filing time here, so each result is treated as known by the next morning (time set to 16:00 on the meeting day).
// Output: data/research/events-results.json (same shape as events.json)
import fs from 'node:fs';
import { nifty500, pastResultDates, mapPool } from '../src/sources.mjs';

const TO = process.argv[2] ?? '12-11-2026'; // must match the saved lists, or NSE is asked again
const out = [];
await mapPool(await nifty500(), 4, async ({ symbol }) => {
  const dates = await pastResultDates(symbol, '01-01-2022', TO).catch(() => []);
  for (const d of dates) if (d >= '2024-01-01') out.push({ symbol, time: `${d} 16:00`, desc: 'Financial Results (date only)', text: '', cat: 'result' });
});
fs.writeFileSync(new URL('../data/research/events-results.json', import.meta.url), JSON.stringify(out));
console.log(`Saved ${out.length} result dates for ${new Set(out.map((e) => e.symbol)).size} companies.`);
