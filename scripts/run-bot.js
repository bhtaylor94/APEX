import { listMarkets, getOrderbook, deriveAsksFromOrderbook, createOrder } from "./kalshi.js";

function n(v, d) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function loadConfig() {
  // Minimal config defaults; you can still override via your Upstash config writer if you have it.
  const cfg = {
    enabled: true,
    mode: "paper",
    seriesTicker: "KXBTC15M",
    tradeSizeUsd: 5,
    maxContracts: 5,
    minConfidence: 0.15,
    minEdge: 5,
    maxEntryPriceCents: 85,
  };

  // Allow env overrides if desired
  cfg.mode = (process.env.BOT_MODE || cfg.mode).toLowerCase();
  cfg.seriesTicker = (process.env.SERIES_TICKER || cfg.seriesTicker).toUpperCase();

  return cfg;
}

async function getSignalStub() {
  // Your project already has a signal engine; keep yours.
  // For safety, keep a stub here only if you haven't wired one.
  // If you already compute SIGNAL elsewhere, replace this function.
  const dir = (Math.random() > 0.5) ? "up" : "down";
  return { direction: dir, confidence: 0.2, price: 0 };
}

function pickSideFromSignal(direction) {
  if (direction === "up") return "yes";
  if (direction === "down") return "no";
  return null;
}

async function pickBestMarket(markets) {
  const ms = Array.isArray(markets) ? markets : [];
  // Prefer "active" & higher volume
  const active = ms.filter(m => (m?.status || "").toLowerCase() === "active");
  const sorted = (active.length ? active : ms).slice().sort((a,b) => (Number(b.volume||0) - Number(a.volume||0)));
  return sorted[0] || null;
}

async function main() {
  const cfg = loadConfig();
  console.log("CONFIG:", cfg);

  // IMPORTANT: If you already compute SIGNAL in your repo, swap to your function.
  // Keeping this line so the script runs even if signal module isn’t wired.
  const signal = await getSignalStub();
  console.log("SIGNAL:", signal);

  if (!cfg.enabled) {
    console.log("Bot disabled — exiting.");
    return;
  }

  if (cfg.mode !== "live" && cfg.mode !== "paper") {
    console.log("Invalid mode; must be live or paper.");
    return;
  }

  if ((signal.confidence ?? 0) < cfg.minConfidence) {
    console.log(`No trade — confidence ${(signal.confidence ?? 0).toFixed(3)} < minConfidence ${cfg.minConfidence}`);
    return;
  }

  const side = pickSideFromSignal(signal.direction);
  if (!side) {
    console.log("No trade — neutral signal.");
    return;
  }

  // Fetch markets for series
  let marketsResp;
  try {
    marketsResp = await listMarkets({ seriesTicker: cfg.seriesTicker, status: "active", limit: 200 });
  } catch (e) {
    console.log("listMarkets error:", e.message);
    return;
  }

  const markets = Array.isArray(marketsResp?.markets) ? marketsResp.markets : [];
  console.log(`Markets source: series(${cfg.seriesTicker}) — found: ${markets.length}`);

  if (!markets.length) {
    console.log("No tradable markets found for series:", cfg.seriesTicker);
    return;
  }

  const m = await pickBestMarket(markets);
  if (!m?.ticker) {
    console.log("No valid market chosen.");
    return;
  }

  // Pull orderbook and derive ask
  const ob = await getOrderbook(m.ticker);
  const book = deriveAsksFromOrderbook(ob);

  const askCents = (side === "yes") ? book.yesAsk : book.noAsk;

  if (!askCents || askCents < 1 || askCents > 99) {
    console.log("No trade — missing/invalid ask:", askCents, "derived:", book);
    return;
  }

  if (askCents > cfg.maxEntryPriceCents) {
    console.log(`No trade — ask ${askCents}¢ > maxEntryPriceCents ${cfg.maxEntryPriceCents}¢`);
    return;
  }

  // Simple edge model: convert confidence into a probability tilt
  // predictedCents ~ 50 +/- tilt; you can replace with your own pricing model
  const tilt = Math.min(Math.max(signal.confidence, 0), 1) * 35; // up to ±35¢
  const predicted = (side === "yes") ? (50 + tilt) : (50 + tilt); // same for no; we compare to no-ask directly
  const predictedCents = Math.round(predicted);
  const edge = predictedCents - askCents;

  console.log(`Selected market:`, { ticker: m.ticker, status: m.status, volume: m.volume, askCents, side, book });
  console.log(`Edge check: predicted=${predictedCents}¢ market=${askCents}¢ edge=${edge}¢ minEdge=${cfg.minEdge}¢`);

  if (edge < cfg.minEdge) {
    console.log("No trade — edge too small.");
    return;
  }

  // Position sizing: as requested, keep it simple — cap by maxContracts
  const count = Math.max(1, Math.min(cfg.maxContracts, Math.floor(cfg.tradeSizeUsd / (askCents / 100))));
  if (count < 1) {
    console.log("No trade — count computed < 1.");
    return;
  }

  const actionLine = `BUY ${side.toUpperCase()} ${count}x ${m.ticker} @ ${askCents}¢ (mode=${cfg.mode})`;
  console.log("Placing order:", actionLine);

  if (cfg.mode !== "live") {
    console.log("PAPER MODE — would have placed:", actionLine);
    return;
  }

  const result = await createOrder({
    ticker: m.ticker,
    action: "buy",
    side,
    count,
    priceCents: askCents,
    postOnly: false,
    tif: "fill_or_kill",
  });

  console.log("ORDER RESULT:", result);
  console.log("Done.");
}

main().catch((e) => {
  console.error("Bot runner failed:", e);
  process.exit(1);
});
