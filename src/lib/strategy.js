// lib/strategy.js
// Trading strategy — evaluates opportunities and sizes positions

export const DEFAULT_CONFIG = {
  minConfidence: 45,      // Minimum signal confidence % to trade
  minEdgeCents: 5,        // Minimum edge vs market price in cents
  maxContracts: 50,       // Max contracts per trade
  maxCostPerTrade: 5000,  // Max cost per trade in cents ($50)
  maxExposure: 25000,     // Max total open exposure in cents ($250)
  maxTradesPerHour: 10,   // Rate limiter
  tradeCooldownMs: 60000, // Cooldown per market (ms)
};

export function evaluateOpportunity(market, signal, config = DEFAULT_CONFIG) {
  const { direction, confidence, currentPrice } = signal;

  if (direction === "neutral" || confidence * 100 < config.minConfidence) {
    return { shouldTrade: false, reason: "Signal too weak" };
  }

  const title = (market.title || "").toLowerCase();
  const isUpDown = title.includes("up or down") || title.includes("up/down");

  // For now focus on "up or down" binary markets (like the Polymarket screenshot)
  if (!isUpDown) {
    // Also handle "above $X" style markets
    if (!title.includes("above") && !title.includes("or above")) {
      return { shouldTrade: false, reason: "Market type not supported" };
    }
  }

  // Convert confidence to probability estimate
  const baseProbability = 0.5 + confidence * 0.35; // maps 0→50%, 1→85%

  let side, marketPrice;

  if (isUpDown) {
    if (direction === "up") {
      side = "yes";
      marketPrice = market.yes_ask || market.last_price || 50;
    } else {
      side = "no";
      marketPrice = market.no_ask || 100 - (market.last_price || 50);
    }
  } else {
    // "Above $X" markets
    const priceMatch = title.match(/\$?([\d,]+(?:\.\d+)?)/);
    if (!priceMatch) return { shouldTrade: false, reason: "Could not parse target price" };

    const targetPrice = parseFloat(priceMatch[1].replace(/,/g, ""));
    const priceDiff = currentPrice - targetPrice;

    if (direction === "up" && priceDiff > 0) {
      side = "yes";
      marketPrice = market.yes_ask || market.last_price || 50;
    } else if (direction === "down" && priceDiff < 0) {
      side = "no";
      marketPrice = market.no_ask || 100 - (market.last_price || 50);
    } else {
      return { shouldTrade: false, reason: "Signal conflicts with price level" };
    }
  }

  // Edge calculation
  const predictedProb = Math.round(baseProbability * 100);
  const edge = predictedProb - marketPrice;

  if (edge < config.minEdgeCents) {
    return { shouldTrade: false, reason: `Edge ${edge}¢ < min ${config.minEdgeCents}¢`, edge };
  }

  // Quarter-Kelly position sizing
  const p = baseProbability;
  const kellyFraction = (p * (100 - marketPrice) - (1 - p) * marketPrice) / (100 - marketPrice);
  const quarterKelly = Math.max(0, kellyFraction * 0.25);

  const contracts = Math.min(
    Math.max(1, Math.floor(quarterKelly * 100)),
    config.maxContracts,
    Math.floor(config.maxCostPerTrade / marketPrice)
  );

  if (contracts < 1) {
    return { shouldTrade: false, reason: "Position size too small" };
  }

  return {
    shouldTrade: true,
    ticker: market.ticker,
    title: market.title,
    side,
    action: "buy",
    count: contracts,
    price: marketPrice,
    type: "limit",
    predictedProb,
    edge,
    confidence: Math.round(confidence * 100),
    estimatedCost: contracts * marketPrice,
    reason: `${direction.toUpperCase()} ${edge}¢ edge @ ${Math.round(confidence * 100)}% conf`,
  };
}
