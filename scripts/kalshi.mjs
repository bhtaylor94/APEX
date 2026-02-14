import crypto from "node:crypto";

const KEY_ID = process.env.KALSHI_API_KEY_ID || "";
const PRIV = process.env.KALSHI_PRIVATE_KEY || "";

function baseUrl() {
  // default to prod elections domain (what their docs show); keep your existing if you use a different env
  return "https://api.elections.kalshi.com/trade-api/v2";
}

function mustAuth() {
  if (!KEY_ID || !PRIV) throw new Error("Missing KALSHI_API_KEY_ID or KALSHI_PRIVATE_KEY in secrets");
}

function signKalshi(method, path, bodyStr, ts) {
  // Kalshi signature scheme is documented in their quickstart + examples.
  // Many users implement: signature over timestamp + method + path + body
  const msg = ts + method.toUpperCase() + path + bodyStr;
  const key = crypto.createPrivateKey(PRIV);
  const sig = crypto.sign("RSA-SHA256", Buffer.from(msg), key);
  return sig.toString("base64");
}

async function kalshiFetch(method, path, bodyObj=null) {
  mustAuth();
  const url = baseUrl() + path;
  const ts = Math.floor(Date.now()/1000).toString();
  const bodyStr = bodyObj ? JSON.stringify(bodyObj) : "";
  const sig = signKalshi(method, path, bodyStr, ts);

  const headers = {
    "Content-Type": "application/json",
    "KALSHI-ACCESS-KEY": KEY_ID,
    "KALSHI-ACCESS-TIMESTAMP": ts,
    "KALSHI-ACCESS-SIGNATURE": sig
  };

  const res = await fetch(url, { method, headers, body: bodyObj ? bodyStr : undefined });
  const txt = await res.text();
  let j = null;
  try { j = JSON.parse(txt); } catch { j = { raw: txt }; }

  if (!res.ok) {
    throw new Error(`Kalshi ${method} ${path} failed (${res.status}): ${JSON.stringify(j)}`);
  }
  return j;
}

export async function listMarkets({ seriesTicker, status="open", limit=200 }) {
  const u = new URL(baseUrl() + "/markets");
  if (seriesTicker) u.searchParams.set("series_ticker", seriesTicker);
  if (status) u.searchParams.set("status", status);
  u.searchParams.set("limit", String(limit));

  // Use kalshiFetch without signing querystring path issues: call signed path exactly
  const path = "/markets" + "?" + u.searchParams.toString();
  return kalshiFetch("GET", path);
}

export async function getOrderbook(ticker) {
  return kalshiFetch("GET", "/markets/" + encodeURIComponent(ticker) + "/orderbook");
}

export async function createOrder({ ticker, action, side, count, priceCents, tif="fill_or_kill", postOnly=false }) {
  // EXACTLY ONE of yes_price/no_price must be set (Kalshi enforces this)  [oai_citation:1‡Kalshi API Documentation](https://docs.kalshi.com/python-sdk/models/CreateOrderRequest?utm_source=chatgpt.com)
  const body = {
    ticker,
    action,          // "buy" or "sell"
    side,            // "yes" or "no"
    count,
    type: "limit",
    time_in_force: tif
  };

  if (side === "yes") body.yes_price = priceCents;
  if (side === "no") body.no_price = priceCents;

  // Some Kalshi setups support post_only (if your account/api supports it). If it errors, set false.
  if (postOnly) body.post_only = true;

  // /portfolio/orders is the documented create order endpoint  [oai_citation:2‡Kalshi API Documentation](https://docs.kalshi.com/api-reference/orders/create-order?utm_source=chatgpt.com)
  return kalshiFetch("POST", "/portfolio/orders", body);
}

export function deriveYesNoFromOrderbook(ob) {
  const yesBids = Array.isArray(ob?.orderbook?.yes) ? ob.orderbook.yes : [];
  const noBids  = Array.isArray(ob?.orderbook?.no)  ? ob.orderbook.no  : [];
  const bestYesBid = yesBids.length ? yesBids[0]?.price : null;
  const bestNoBid  = noBids.length  ? noBids[0]?.price  : null;

  // Derive asks from opposite-side bids (Kalshi doc logic).  [oai_citation:3‡Kalshi API Documentation](https://docs.kalshi.com/api-reference/market/get-market-orderbook?utm_source=chatgpt.com)
  const yesAsk = (bestNoBid != null) ? (100 - bestNoBid) : null;
  const noAsk  = (bestYesBid != null) ? (100 - bestYesBid) : null;

  return { bestYesBid, bestNoBid, yesAsk, noAsk };
}
