/**
 * scripts/run-bot.js (ESM)
 * package.json has "type":"module"
 * Node 18+ provides global fetch (no node-fetch)
 */

import * as kv from "./kv.js";
import * as signal from "./signal.js";
import * as kalshi from "./kalshi.js";

function pickFn(mod, names) {
  for (const n of names) {
    if (typeof mod?.[n] === "function") return mod[n];
  }
  return null;
}

const kvGetJson = pickFn(kv, ["kvGetJson", "getJson", "get"]);
const kvSetJson = pickFn(kv, ["kvSetJson", "setJson", "set"]);
const getBTCSignal = pickFn(signal, ["getBTCSignal", "getSignal", "signal"]);
const getBTCMarkets = pickFn(kalshi, ["getBTCMarkets", "getMarkets", "listBTCMarkets"]);
const placeKalshiOrder = pickFn(kalshi, ["placeKalshiOrder", "placeOrder", "order"]);
const listMarkets = pickFn(kalshi, ["listMarkets", "getMarketsRaw"]);

function must(fn, name) {
  if (typeof fn !== "function") throw new Error(`Missing function "${name}" in scripts/*.js exports`);
  return fn;
}

must(kvGetJson, "kvGetJson");
must(kvSetJson, "kvSetJson");
must(getBTCSignal, "getBTCSignal");
must(getBTCMarkets, "getBTCMarkets");
must(placeKalshiOrder, "placeKalshiOrder");

async function fallbackOpenMarketFilter() {
  if (typeof listMarkets !== "function") return [];
  const all = await listMarkets({ status: "open", limit: 500 });
  const markets = (all?.markets || []).filter(m => {
    const t = ((m.title || "") + " " + (m.subtitle || "")).toLowerCase();
    return (t.includes("btc") || t.includes("bitcoin")) && t.includes("15") && t.includes("up") && t.includes("down");
  });
  markets.sort((a,b) => (Number(b.volume||0) - Number(a.volume||0)));
  return markets;
}

async function main() {
  if (typeof fetch !== "function") throw new Error("Global fetch not found. Ensure Node 18+.");

  const cfg = (await kvGetJson("bot:config")) || {};
  console.log("CONFIG:", cfg);

  if (!cfg.enabled) {
    console.log("Bot disabled. Exiting.");
    return;
  }

  const seriesTicker = String(cfg.seriesTicker || "KXBTC15M").toUpperCase();

  const sig = await getBTCSignal(cfg);
  console.log("SIGNAL:", sig);

  const conf = Number(sig?.confidence || 0);
  const minConf = Number(cfg.minConfidence || 0);
  if (conf < minConf) {
    console.log(`No trade: confidence ${conf.toFixed(4)} < minConfidence ${minConf}`);
    return;
  }

  // Market discovery: prefer kalshi.js's method; fall back to open-market scan
  let resp = null;
  try {
    resp = await getBTCMarkets({ seriesTicker, status: "open" });
  } catch (e) {
    console.log("getBTCMarkets error (will fallback):", e?.message || e);
  }

  let markets = [];
  if (Array.isArray(resp)) markets = resp;
  else if (Array.isArray(resp?.markets)) markets = resp.markets;

  if (!markets.length) {
    markets = await fallbackOpenMarketFilter();
    console.log(`Fallback open-market filter found: ${markets.length}`);
  }

  if (!markets.length) {
    console.log(`No tradable markets found for series: ${seriesTicker}`);
    return;
  }

  const m = markets[0];
  console.log("Selected market:", {
    ticker: m.ticker,
    status: m.status,
    yes_ask: m.yes_ask,
    no_ask: m.no_ask,
    volume: m.volume,
    close_ts: m.close_ts
  });

  const dir = String(sig?.dir || sig?.direction || "NONE").toUpperCase();
  if (dir !== "UP" && dir !== "DOWN") {
    console.log(`No trade: direction=${dir}`);
    return;
  }

  const side = dir === "UP" ? "yes" : "no";
  const price = side === "yes"
    ? (m.yes_ask || m.last_price || 50)
    : (m.no_ask || (100 - (m.last_price || 50)));

  const implied = Number(price || 0);
  const predictedProb = Math.round((0.5 + conf * 0.35) * 100);
  const edge = predictedProb - implied;
  const minEdge = Number(cfg.minEdge || 0);

  console.log(`Edge check: predicted=${predictedProb}¢ market=${implied}¢ edge=${edge}¢ minEdge=${minEdge}¢`);

  if (edge < minEdge) {
    console.log("No trade: edge too small.");
    return;
  }

  const maxContracts = Number(cfg.maxContracts || 1);
  const tradeSizeUsd = Number(cfg.tradeSizeUsd || 5);
  const maxCostCents = Math.max(1, Math.floor(tradeSizeUsd * 100));
  const contracts = Math.max(1, Math.min(maxContracts, Math.floor(maxCostCents / Math.max(1, implied))));

  console.log(`Placing order: ${side.toUpperCase()} ${contracts}x ${m.ticker} @ ${implied}¢ (mode=${cfg.mode || "paper"})`);

  const orderRes = await placeKalshiOrder({
    ticker: m.ticker,
    side,
    count: contracts,
    price: implied,
    mode: cfg.mode || "paper",
  });

  console.log("ORDER RESULT:", orderRes);

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
