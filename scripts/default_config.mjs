export function defaultConfig() {
  return {
    enabled: false,
    mode: "paper", // "paper" | "live"

    // 15-minute BTC Up/Down series
    seriesTicker: "kxbtc15m",

    tradeSizeUsd: 5,
    maxOpenPositions: 1,

    minConfidence: 0.55,

    // No TP/SL — contracts settle at $1 or $0. Risk controlled by position sizing.

    // Price band: only trade contracts priced 35¢–80¢
    minEntryPriceCents: 35,
    maxEntryPriceCents: 80,

    // Time gate: only enter with 10+ minutes until settlement
    minMinutesToCloseToEnter: 10,

    cooldownMinutes: 8,
    maxTradesPerDay: 10,
    dailyMaxLossUsd: 25
  };
}
