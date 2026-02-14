/**
 * scripts/run-bot.js (CommonJS)
 * - Works on GitHub Actions Node 18+ without "type": "module"
 * - Avoids ESM/CJS named-export issues by using require()
 * - Uses Node 18+ global fetch (no node-fetch dependency)
 */

const kv = require("./kv.js");
const signal = require("./signal.js");
const kalshi = require("./kalshi.js");

const kvGetJson = kv.kvGetJson || kv.getJson || kv.get || kv.kv_get_json;
const kvSetJson = kv.kvSetJson || kv.setJson || kv.set || kv.kv_set_json;
const getBTCSignal = signal.getBTCSignal || signal.getSignal || signal.signal;
const getBTCMarkets = kalshi.getBTCMarkets || kalshi.getMarkets || kalshi.listBTCMarkets;
const placeKalshiOrder = kalshi.placeKalshiOrder || kalshi.placeOrder || kalshi.order;

function must(fn, name) {
  if (typeof fn !== "function") {
    throw new Error(`Missing function "${name}" in required modules. Check exports in scripts/*.js`);
  }
  return fn;
}

must(kvGetJson, "kvGetJson");
must(kvSetJson, "kvSetJson");
must(getBTCSignal, "getBTCSignal");
must(getBTCMarkets, "getBTCMarkets");
must(placeKalshiOrder, "placeKalshiOrder");

async function main() {
  // Guard fetch (Node 18+)
  if (typeof fetch !== "function") {
    throw new Error("Global fetch not found. Ensure Actions uses Node 18+.");
  }

  const cfg = (await kvGetJson("bot:config")) || {};
  console.log("CONFIG:", cfg);

  if (!cfg.enabled) {
    console.log("Bot disabled. Exiting.");
    return;
  }

  // Normalize series ticker
  const seriesTicker = String(cfg.seriesTicker || "KXBTC15M").toUpperCase();

  // 1) Get signal
  const sig = await getBTCSignal(cfg);
  console.log("SIGNAL:", sig);

  // Confidence gate
  const conf = Number(sig?.confidence || 0);
  const minConf = Number(cfg.minConfidence || 0);
  if (conf < minConf) {
    console.log(`No trade: confidence ${conf.toFixed(4)} < minConfidence ${minConf}`);
    return;
  }

  // 2) Discover markets — IMPORTANT: do not require status=open at discovery.
  // We ask module for markets; if it supports series/status internally, fine.
  // If it expects seriesTicker, pass it.
  const marketsResp = await getBTCMarkets({ seriesTicker, status: "open" }).catch(() => null);
  let markets = [];

  if (Array.isArray(marketsResp)) markets = marketsResp;
  else if (Array.isArray(marketsResp?.markets)) markets = marketsResp.markets;

  // If module returns nothing, try a fallback method if kalshi.js exposes it
  if (!markets.length && typeof kalshi.listMarkets === "function") {
    const all = await kalshi.listMarkets({ status: "open", limit: 500 });
    markets = (all?.markets || []).filter(m => {
      const t = ((m.title || "") + " " + (m.subtitle || "")).toLowerCase();
      return (t.includes("btc") || t.includes("bitcoin")) && t.includes("15") && t.includes("up") && t.includes("down");
    });
    markets.sort((a,b) => (Number(b.volume||0) - Number(a.volume||0)));
    console.log(`Fallback open-market filter found: ${markets.length}`);
  }

  if (!markets.length) {
    console.log(`No tradable markets found for series: ${seriesTicker}`);
    return;
  }

  // Pick top market (highest volume / first)
  const m = markets[0];
  console.log("Selected market:", { ticker: m.ticker, status: m.status, yes_ask: m.yes_ask, no_ask: m.no_ask, volume: m.volume });

  // 3) Decide side
  const dir = String(sig?.dir || sig?.direction || "NONE").toUpperCase();
  if (dir !== "UP" && dir !== "DOWN") {
    console.log(`No trade: direction=${dir}`);
    return;
  }

  const side = dir === "UP" ? "yes" : "no";
  const price = side === "yes" ? (m.yes_ask || m.last_price || 50) : (m.no_ask || (100 - (m.last_price || 50)));

  // Basic edge check if you have predictedProb logic; keep simple here:
  const minEdge = Number(cfg.minEdge || 0);
  const implied = Number(price || 0); // cents
  const predictedProb = Math.round((0.5 + conf * 0.35) * 100); // same idea as earlier UI
  const edge = predictedProb - implied;
  console.log(`Edge check: predicted=${predictedProb}¢ market=${implied}¢ edge=${edge}¢ minEdge=${minEdge}¢`);

  if (edge < minEdge) {
    console.log("No trade: edge too small.");
    return;
  }

  // Size: cap by maxContracts and tradeSizeUsd
  const maxContracts = Number(cfg.maxContracts || 1);
  const tradeSizeUsd = Number(cfg.tradeSizeUsd || 5);
  const maxCostCents = Math.max(1, Math.floor(tradeSizeUsd * 100));
  const contracts = Math.max(1, Math.min(maxContracts, Math.floor(maxCostCents / Math.max(1, implied))));
  console.log(`Placing order: ${side.toUpperCase()} ${contracts}x ${m.ticker} @ ${implied}¢`);

  // 4) Place order
  const orderRes = await placeKalshiOrder({
    ticker: m.ticker,
    side,
    count: contracts,
    price: implied,
    mode: cfg.mode || "paper",
  });

  console.log("ORDER RESULT:", orderRes);

  // Store last run
  await kvSetJson("bot:last_run", {
    ts: Date.now(),
    seriesTicker,
    marketTicker: m.ticker,
    side,
    count: contracts,
    price: implied,
    confidence: conf,
    edge,
    mode: cfg.mode || "paper",
  });

  console.log("Done.");
}

main().catch((e) => {
  console.error("Bot runner failed:", e && (e.stack || e));
  process.exit(1);
});
