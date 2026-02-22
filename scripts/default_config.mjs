export function defaultConfig() {
  return {
    enabled: false,
    mode: "paper", // "paper" | "live"

    seriesTicker: "KXBTC15M",

    tradeSizeUsd: 10,
    maxContracts: 10,

    // Signal: minimum edge in cents to enter
    minEdge: 5,

    // Price band: only buy contracts priced 35c-80c
    minEntryPriceCents: 35,
    maxEntryPriceCents: 80,

    // Maker orders: offset below ask (2c = place 2c below ask)
    makerOffsetCents: 2,
    makerTimeoutMinutes: 2.5,

    // Time gate: only enter with 10+ min until settlement
    minMinutesToCloseToEnter: 10,

    // Take profit: sell when total unrealized profit >= this (in cents)
    takeProfitCents: 75,

    // Risk management: daily limits
    cooldownMinutes: 5,
    maxTradesPerDay: 10,
    dailyMaxLossUsd: 50,

    // ── 1-Hour series config ──
    hourlyEnabled: false,
    hourlySeriesTicker: "KXBTC",
    hourly_minMinutesToCloseToEnter: 60,
    hourly_cooldownMinutes: 15,
    hourly_minEntryPriceCents: 8,
    hourly_maxEntryPriceCents: 85,
    hourly_makerOffsetCents: 2,
    hourly_minEdge: 3,
  };
}
