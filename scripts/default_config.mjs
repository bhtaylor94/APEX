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
    // e.g., 75 = sell when up $0.75 across all contracts
    takeProfitCents: 75,

    // Risk management: daily limits
    cooldownMinutes: 5,
    maxTradesPerDay: 10,
    dailyMaxLossUsd: 50,
  };
}
