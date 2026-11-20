// Example 1 (intraday): Results Radar's Bounce-back rule, written for the lab.
// Fell 3-8% yesterday, ALSO had a 4.5%+ fall in the 5 days before, opens 2-5% down again -> buy at the open,
// stop 3%, target 7%, else sell at 3:20 pm. No results day (the news might be real).
export default {
  name: 'Example: Bounce-back (intraday)',
  side: 'buy',
  universe: { minTurnoverCr: 1, minPrice: 5, skipT2T: true, skipETF: true, skipResultsDay: true },
  entry: (v) => v.yesterday.change <= -0.03 && v.yesterday.change > -0.08 && v.gap <= -0.02 && v.gap > -0.05
    && v.bar(2) && [2, 3, 4, 5, 6].some((n) => v.bar(n) && v.bar(n).change <= -0.045),
  entryType: 'open',
  maxPerDay: 3,
  exit: { stop: 0.03, target: 0.07, holdDays: 0 },
  costs: 0.004,
};
