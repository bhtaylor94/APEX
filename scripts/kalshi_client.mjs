import crypto from "crypto";

const ENV = String(process.env.KALSHI_ENV || process.env.NEXT_PUBLIC_KALSHI_ENV || "prod").toLowerCase();

// Kalshi docs: demo uses demo-api.kalshi.co.
// Production host in Kalshi docs varies by product; APEX has been using trade-api/v2 under api.elections.kalshi.com.
// We’ll keep that to match what you were successfully trading against.
const BASE =
  (ENV === "demo" || ENV === "sandbox")
    ? "https://demo-api.kalshi.co"
    : "https://api.elections.kalshi.com";

const API_KEY_ID = process.env.KALSHI_API_KEY_ID || "";
const PRIVATE_KEY_PEM = process.env.KALSHI_PRIVATE_KEY || "";

function mustEnv(name, v) {
  if (!v) throw new Error("Missing env: " + name);
  return v;
}

function signKalshi({ timestampMs, method, path }) {
  const keyId = mustEnv("KALSHI_API_KEY_ID", API_KEY_ID);
  const pem = mustEnv("KALSHI_PRIVATE_KEY", PRIVATE_KEY_PEM);

  const pathNoQuery = path.split("?")[0];
  const msg = String(timestampMs) + method.toUpperCase() + pathNoQuery;

  const signature = crypto.sign("sha256", Buffer.from(msg, "utf8"), {
    key: pem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
  });

  return { keyId, sigB64: signature.toString("base64") };
}

export async function kalshiFetch(path, { method = "GET", body = null, auth = true } = {}) {
  const url = BASE + path;

  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "apex-bot/1.0"
  };

  if (auth) {
    const ts = Date.now();
    const sig = signKalshi({ timestampMs: ts, method, path });
    headers["KALSHI-ACCESS-KEY"] = sig.keyId;
    headers["KALSHI-ACCESS-TIMESTAMP"] = String(ts);
    headers["KALSHI-ACCESS-SIGNATURE"] = sig.sigB64;
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const txt = await res.text();
  let data = null;
  try { data = JSON.parse(txt); } catch { data = { raw: txt }; }

  if (!res.ok) {
    throw new Error("Kalshi " + method + " " + path + " failed (" + res.status + "): " + txt);
  }
  return data;
}

export async function getMarkets({ series_ticker, status = "open", limit = 200, cursor = null, mve_filter = "exclude" } = {}) {
  const qs = new URLSearchParams();
  if (series_ticker) qs.set("series_ticker", series_ticker);
  if (status) qs.set("status", status);
  if (mve_filter) qs.set("mve_filter", mve_filter);
  qs.set("limit", String(limit));
  if (cursor) qs.set("cursor", cursor);
  return kalshiFetch("/trade-api/v2/markets?" + qs.toString(), { method: "GET", auth: true });
}

export async function getMarket(ticker) {
  return kalshiFetch("/trade-api/v2/markets/" + encodeURIComponent(ticker), { method: "GET", auth: true });
}

export async function getOrderbook(ticker, depth = 1) {
  const qs = new URLSearchParams({ depth: String(depth) });
  return kalshiFetch("/trade-api/v2/markets/" + encodeURIComponent(ticker) + "/orderbook?" + qs.toString(), { method: "GET", auth: true });
}

export async function placeOrder({ ticker, side, count, priceCents, action = "buy" }) {
  if (side !== "yes" && side !== "no") throw new Error("Invalid side: " + side);
  if (action !== "buy" && action !== "sell") throw new Error("Invalid action: " + action);
  if (!Number.isFinite(count) || count <= 0) throw new Error("Invalid count: " + count);
  if (!Number.isFinite(priceCents) || priceCents < 1 || priceCents > 99) throw new Error("Invalid priceCents: " + priceCents);

  // ✅ EXACTLY ONE of yes_price / no_price
  const body = {
    ticker,
    action,
    type: "limit",
    side,
    count,
    client_order_id: crypto.randomUUID()
  };
  if (side === "yes") body.yes_price = priceCents;
  if (side === "no")  body.no_price  = priceCents;

  return kalshiFetch("/trade-api/v2/portfolio/orders", { method: "POST", body, auth: true });
}
