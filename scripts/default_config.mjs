export function defaultConfig() {
  return {
    enabled: false,
    mode: "paper", // "paper" | "live"

    // 15-minute BTC Up/Down series
    seriesTicker: "kxbtc15m",

    tradeSizeUsd: 5,
    maxOpenPositions: 1,

    minConfidence: 0.55,

    takeProfitPct: 0.20,
    stopLossPct: 0.12,

    // Force-exit rules for short-duration markets
    minMinutesToCloseToEnter: 3,
    minMinutesToCloseToHold: 2,

    cooldownMinutes: 8,
    maxTradesPerDay: 10,
    dailyMaxLossUsd: 25
  };
}
