export function defaultConfig() {
  return {
    enabled: false,
    mode: "paper", // "paper" | "live"

    // 15-minute BTC Up/Down series
    seriesTicker: "kxbtc15m",

    tradeSizeUsd: 5,
    maxContracts: 5,
    maxOpenPositions: 1,

    minConfidence: 0.55,
    minEdge: 5,

    // Exit strategy: take profit at +15c, stop loss at -20c
    takeProfitCents: 15,
    stopLossCents: 20,

    // Price band: only trade contracts priced 35c-80c
    minEntryPriceCents: 35,
    maxEntryPriceCents: 80,

    // Time gate: only enter with 10+ minutes until settlement
    minMinutesToCloseToEnter: 10,

    cooldownMinutes: 8,
    maxTradesPerDay: 10,
    dailyMaxLossUsd: 25
  };
}
