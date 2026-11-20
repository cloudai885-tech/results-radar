// COPY THIS FILE, rename it (e.g. my-strategy.mjs), change the rules, then run:
//   node mahins-strategy/backtest.mjs mahins-strategy/strategies/my-strategy.mjs
//
// The lab asks entry(v) for EVERY stock on EVERY day, before the market opens.
// v knows only the past + today's opening price (never today's high/low/close - that would be cheating).
//
// What v gives you:
//   v.symbol, v.date, v.open (today's opening price), v.prevClose, v.gap (open vs yesterday's close, -0.03 = -3%)
//   v.yesterday            -> { open, high, low, close, change, turnoverCr, delivery }   (change -0.05 = fell 5%)
//   v.bar(n)               -> same for n days ago (1 = yesterday, 2 = day before ...)
//   v.change(n)            -> move over the last n days up to yesterday's close (0.10 = up 10%)
//   v.sma(n), v.ema(n)     -> moving averages of the close (n days)
//   v.rsi(14)              -> RSI 0..100
//   v.atr(14)              -> typical daily range as a share of the price (0.04 = moves ~4% a day)
//   v.highest(n), v.lowest(n) -> highest high / lowest low of the last n days (52 weeks = 250)
//   v.turnoverCr           -> money traded a day, Rs crore (median of 20 days)
//   v.volumeRatio(20)      -> yesterday's volume vs normal (2 = double)
//   v.daysDown(n, -0.045)  -> how many of the last n days fell 4.5% or more (v.daysUp the same for rises)
//   v.lowerCircuitYesterday / v.upperCircuitYesterday -> true / false
//   v.marketGap            -> how the whole market opened today (median stock, -0.01 = -1%)
//   v.marketYesterday      -> how the whole market moved yesterday
//   v.resultsToday         -> true if the company announced results since yesterday's close
//   v.series               -> 'EQ' or 'BE' (BE = T2T, delivery only)
export default {
  name: 'My strategy',
  side: 'buy',                 // 'buy' or 'short' (a short is always closed the same day)

  // Which stocks are allowed at all
  universe: { minTurnoverCr: 1, minPrice: 5, skipT2T: true, skipETF: true, skipResultsDay: false },

  // THE RULE: return true to trade this stock today
  entry: (v) => v.gap <= -0.02 && v.yesterday.change <= -0.03,

  // How to get in:
  //   'open'  = at the opening price (bought in pre-open)
  //   'stop'  = when the price RISES to entryLevel (breakout). For a short: when it FALLS to the level.
  //   'limit' = when the price FALLS to entryLevel (buy the dip). For a short: when it RISES to the level.
  entryType: 'open',
  // entryLevel: (v) => v.highest(20),   // needed for 'stop' / 'limit'

  // If more stocks match than allowed: which first? (higher = first). Default: most traded.
  rank: (v) => v.turnoverCr,
  maxPerDay: 3,                // new trades a day
  // maxOpen: 5,               // swing only: most positions open at the same time

  exit: {
    stop: 0.03,                // sell if it falls 3% from the buy price (null = no stop)
    target: 0.07,              // sell if it rises 7% (null = no target)
    trail: null,               // e.g. 0.05 = sell if it falls 5% from its best price since the buy
    holdDays: 0,               // 0 = intraday (sold by 3:20 pm). 10 = swing, hold up to 10 days
    // exitWhen: (v, pos) => v.yesterday.close < v.sma(20),   // swing: sell at the next open when this is true
  },

  costs: 0.004,                // charges + slippage a trade (0.4%). Delivery/swing: about 0.3-0.5%
  // from: '2024-03-01', to: '2026-12-31', testFrom: '2025-10-01',
};
