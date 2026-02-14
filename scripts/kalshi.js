/**
 * Kalshi REST helpers (Trade API v2)
 * - Uses Node 18+ global fetch
 * - Orderbook returns bids only: { yes: [[price, qty], ...], no: [[price, qty], ...] }
 *   Derived asks:
 *     yesAsk = 100 - bestNoBid
 *     noAsk  = 100 - bestYesBid
 */

import crypto from "node:crypto";

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error("Missing env: " + name);
  return v;
}

function baseUrl() {
  // If you already have a different base in your repo, keep this stable:
  // Kalshi Trade API v2 base commonly used:
  // https://trading-api.kalshi.com/trade-api/v2   (or api.elections.* for some products)
  // Your existing code likely already works for GETs/POSTs, so keep same:
  return process.env.KALSHI_BASE_URL || "https://trading-api.kalshi.com/trade-api/v2";
}

// --- Kalshi auth: keep whatever you already had working for executed orders.
// We’ll implement a very common pattern: sign method+path+timestamp+body using RSA key.
// If your repo already has a working signature function elsewhere, you can swap this in.
function buildAuthHeaders(method, path, bodyStr) {
  const keyId = mustEnv("KALSHI_API_KEY_ID");
  const pem = mustEnv("KALSHI_PRIVATE_KEY");

  // timestamp in ms
  const ts = String(Date.now());
  const payload = [ts, method.toUpperCase(), path, bodyStr || ""].join("\n");

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(payload);
  signer.end();

  const signature = signer.sign(pem, "base64");

  // Kalshi auth header format can vary by environment.
  // Your orders EXECUTED earlier, so this style should match what you already had.
  return {
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-SIGNATURE": signature,
    "KALSHI-ACCESS-TIMESTAMP": ts,
    "Content-Type": "application/json",
  };
}

async function kalshiFetch(method, path, body) {
  const url = baseUrl() + path;
  const bodyStr = body ? JSON.stringify(body) : "";
  const headers = buildAuthHeaders(method, path, bodyStr);

  const res = await fetch(url, {
    method,
    headers,
    body: body ? bodyStr : undefined,
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }

  if (!res.ok) {
    throw new Error(`Kalshi ${method} ${path} failed (${res.status}): ${text}`);
  }
  return json;
}

export function bestBidCents(levels) {
  // levels = [[price, qty], ...]
  if (!Array.isArray(levels) || levels.length === 0) return null;
  let best = null;
  for (const lvl of levels) {
    const p = Array.isArray(lvl) ? Number(lvl[0]) : null;
    if (!Number.isFinite(p)) continue;
    if (best === null || p > best) best = p;
  }
  return best;
}

export function deriveAsksFromBids(orderbook) {
  const bestYesBid = bestBidCents(orderbook?.yes);
  const bestNoBid  = bestBidCents(orderbook?.no);

  const yesAsk = Number.isFinite(bestNoBid) ? (100 - bestNoBid) : null;
  const noAsk  = Number.isFinite(bestYesBid) ? (100 - bestYesBid) : null;

  return { bestYesBid, bestNoBid, yesAsk, noAsk };
}

export async function getMarketsBySeries(seriesTicker, limit = 200) {
  const st = String(seriesTicker || "").toUpperCase();
  const qs = new URLSearchParams({ status: "active", series_ticker: st, limit: String(limit) });
  return kalshiFetch("GET", "/markets?" + qs.toString());
}

export async function getMarket(ticker) {
  return kalshiFetch("GET", "/markets/" + encodeURIComponent(ticker));
}

export async function getOrderbook(ticker, depth = 10) {
  const qs = new URLSearchParams({ depth: String(depth) });
  return kalshiFetch("GET", "/markets/" + encodeURIComponent(ticker) + "/orderbook?" + qs.toString());
}

export async function createOrder({ ticker, action, side, count, priceCents, tif }) {
  // IMPORTANT: Kalshi requires:
  // - side: "yes" or "no"
  // - exactly one of yes_price or no_price (not both)
  const body = {
    ticker,
    action,              // "buy" or "sell"
    side,                // "yes" or "no"
    count: Number(count),
    type: "limit",
    time_in_force: tif || "immediate_or_cancel",
  };

  if (side === "yes") body.yes_price = Number(priceCents);
  if (side === "no")  body.no_price  = Number(priceCents);

  return kalshiFetch("POST", "/portfolio/orders", body);
}
