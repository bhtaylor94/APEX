export function defaultConfig() {
  return {
    enabled: false,
    mode: "paper",                // "paper" or "live"
    tradeSizeUsd: 10,             // start small
    maxOpenPositions: 1,

    minConfidence: 0.65,

    takeProfitPct: 0.20,          // 20%
    stopLossPct: 0.12,            // 12%
    timeStopMinutes: 60,

    cooldownMinutes: 8,
    maxTradesPerDay: 10,
    dailyMaxLossUsd: 25
  };
}
