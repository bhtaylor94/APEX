
function isBtc15mUpDown(m){
  const t = ((m.title||"") + " " + (m.subtitle||"")).toLowerCase();
  return (t.includes("btc") || t.includes("bitcoin")) &&
         (t.includes("15") || t.includes("15m") || t.includes("15-minute") || t.includes("15 minutes")) &&
         (t.includes("up") && t.includes("down"));
}

async function pickOpenMarkets(kalshi, seriesTicker){
  const st = (seriesTicker || "").toUpperCase();
  const candidates = [st, "KXBTC15M", "KXBTC15", "KXBTCUD", "KXBTCUDR"].filter(Boolean);

  // 1) Try series tickers first
  for (const c of candidates) {
    try {
      const r = await kalshi.listMarkets({ status: "open", series_ticker: c, limit: 100 });
      const ms = Array.isArray(r?.markets) ? r.markets : [];
      if (ms.length) return { markets: ms, used: c, method: "series" };
    } catch {}
  }

  // 2) Fallback: scan all open markets and filter for BTC 15m Up/Down
  const rAll = await kalshi.listMarkets({ status: "open", limit: 300 });
  const all = Array.isArray(rAll?.markets) ? rAll.markets : [];
  const filtered = all.filter(isBtc15mUpDown);
  return { markets: filtered, used: "ALL_OPEN", method: "fallback" };
}

import { kvGetJson, kvSetJson } from "./kv.js";
import { getBTCSignal } from "./signal.js";
import kalshiPkg from "./kalshi.js";
const { getBTCMarkets, placeKalshiOrder } = kalshiPkg;
// Node 18+ has global fetch. (We intentionally avoid node-fetch in Actions.)
if (typeof fetch !== "function") {
  throw new Error("Global fetch not found. Use Node 18+ in GitHub Actions.");
}


async function pickKxBtc15mMarket(kalshi, seriesTicker) {
  const st = String(seriesTicker || "KXBTC15M");
  // IMPORTANT: don't force status=open; 15m markets are often 'unopened' until right before start.
  const resp = await kalshi.listMarkets({ series_ticker: st, limit: 200 });
  const markets = Array.isArray(resp?.markets) ? resp.markets : [];

  const now = Math.floor(Date.now() / 1000);

  const tradable = markets
    .filter(m => ["open", "unopened", "paused"].includes(String(m.status || "").toLowerCase()))
    .filter(m => (m.close_ts || 0) > now) // upcoming / current only
    .sort((a,b) => (a.close_ts || 0) - (b.close_ts || 0)); // soonest close first

  if (!tradable.length) {
    return { market: null, count: markets.length, method: "series-no-status" };
  }

  return { market: tradable[0], count: markets.length, method: "series-no-status" };
}


(async () => {
  const config = await kvGetJson("bot:config");
  if (!config?.enabled) {
    console.log("Bot disabled");
    return;
  }

  const signal = await getBTCSignal();
  console.log("Signal:", signal);

  if (signal.direction === "neutral") return;
  if (signal.confidence < config.minConfidence) return;

  const markets = await getBTCMarkets();
  if (!markets.length) {
    console.log("No BTC markets");
    return;
  }

  for (const m of markets) {
    const side = signal.direction === "up" ? "yes" : "no";
    const price = side === "yes" ? m.yes_ask : m.no_ask;
    if (!price || price >= 99) continue;

    const edge = Math.round(signal.confidence * 100) - price;
    if (edge < config.minEdge) continue;

    const count = Math.min(config.maxContracts, Math.floor(config.tradeSizeUsd / (price / 100)));
    if (count < 1) continue;

    console.log("PLACING TRADE:", m.ticker, side, count, price);

    if (config.mode === "live") {
      await placeKalshiOrder(m.ticker, side, count, price);
    }

    await kvSetJson("bot:last_trade", {
      ticker: m.ticker,
      side,
      count,
      price,
      confidence: signal.confidence,
      ts: Date.now()
    });

    break;
  }

  await kvSetJson("bot:last_run", { ts: Date.now(), signal });
})();
