// Example 2 (swing): 52-week-high breakout. The stock closed yesterday within 2% of its 1-year high, is above its
// 50-day average, and the whole market is not falling -> buy when the price breaks above the 1-year high during the
// day. Stop 8%, trailing stop 10% from the best price, sell if it closes below the 20-day average, hold up to 30 days.
export default {
  name: 'Example: 52-week-high breakout (swing)',
  side: 'buy',
  universe: { minTurnoverCr: 5, minPrice: 20, skipT2T: true, skipETF: true },
  entry: (v) => v.daysOfData >= 250 && v.yesterday.close >= v.highest(250) * 0.98 && v.yesterday.close > v.sma(50) && (v.marketYesterday ?? 0) > -0.01,
  entryType: 'stop',
  entryLevel: (v) => v.highest(250) * 1.001,
  rank: (v) => v.turnoverCr,
  maxPerDay: 2,
  maxOpen: 5,
  exit: { stop: 0.08, trail: 0.10, holdDays: 30, exitWhen: (v) => v.yesterday.close < v.sma(20) },
  costs: 0.004,
};
