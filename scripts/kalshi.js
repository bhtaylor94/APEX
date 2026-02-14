import crypto from "node:crypto";

function envStr(k, d="") {
  const v = process.env[k];
  return (v && String(v).trim()) ? String(v) : d;
}

function getBaseUrl() {
  // Kalshi docs show production market-data at api.elections.kalshi.com (covers ALL markets).  [oai_citation:2‡Kalshi API Documentation](https://docs.kalshi.com/getting_started/quick_start_market_data?utm_source=chatgpt.com)
  // Demo typically uses demo-api.kalshi.co.
  const e = (envStr("KALSHI_ENV", envStr("NEXT_PUBLIC_KALSHI_ENV", "prod")) || "prod").toLowerCase();
  if (e.includes("demo")) return "https://demo-api.kalshi.co";
  return "https://api.elections.kalshi.com";
}

function toPathNoQuery(p) {
  // p can be "/portfolio/orders?limit=5" -> sign only "/trade-api/v2/portfolio/orders"  [oai_citation:3‡Kalshi API Documentation](https://docs.kalshi.com/getting_started/quick_start_authenticated_requests?utm_source=chatgpt.com)
  return String(p).split("?")[0];
}

function signKalshi({ timestampMs, method, path }) {
  const keyId = envStr("KALSHI_API_KEY_ID");
  const privateKeyPem = envStr("KALSHI_PRIVATE_KEY");

  if (!keyId || !privateKeyPem) {
    throw new Error("missing kalshi keys (KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY)");
  }

  const msg = String(timestampMs) + String(method).toUpperCase() + String(path);
  const sig = crypto.sign("sha256", Buffer.from(msg, "utf8"), {
    key: privateKeyPem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  });

  return {
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-TIMESTAMP": String(timestampMs),
    "KALSHI-ACCESS-SIGNATURE": sig.toString("base64"),
  };
}

async function kalshiFetch(method, path, body, { auth=false } = {}) {
  const base = getBaseUrl();
  const cleanPath = toPathNoQuery(path);

  // Ensure we ALWAYS request /trade-api/v2/...
  const fullPath = cleanPath.startsWith("/trade-api/") ? cleanPath : ("/trade-api/v2" + (cleanPath.startsWith("/") ? cleanPath : ("/" + cleanPath)));
  const url = base + fullPath;

  const headers = { "Content-Type": "application/json" };

  if (auth) {
    const ts = Date.now();
    const signed = signKalshi({ timestampMs: ts, method, path: fullPath }); // sign the FULL /trade-api/v2/... path
    Object.assign(headers, signed);
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

  if (!res.ok) {
    const msg = (typeof data === "object" && data)
      ? JSON.stringify(data)
      : String(text || "");
    throw new Error(`Kalshi ${method} ${fullPath} failed (${res.status}): ${msg}`);
  }

  return data;
}

// -------- public data --------

export async function listMarkets({ seriesTicker, status="active", limit=200 } = {}) {
  // Market data does not require auth per docs, but works either way.  [oai_citation:4‡Kalshi API Documentation](https://docs.kalshi.com/getting_started/quick_start_market_data?utm_source=chatgpt.com)
  const qs = new URLSearchParams();
  if (seriesTicker) qs.set("series_ticker", seriesTicker);
  if (status) qs.set("status", status);
  if (limit) qs.set("limit", String(limit));
  const path = "/markets" + (qs.toString() ? ("?" + qs.toString()) : "");
  return kalshiFetch("GET", path, null, { auth: false });
}

export async function getOrderbook(ticker) {
  const t = String(ticker || "").trim();
  if (!t) throw new Error("missing ticker for orderbook");
  return kalshiFetch("GET", `/markets/${encodeURIComponent(t)}/orderbook`, null, { auth: false });
}

export function deriveAsksFromOrderbook(orderbook) {
  // Orderbook returns BIDS only for yes/no. Asks are implied.  [oai_citation:5‡Kalshi API Documentation](https://docs.kalshi.com/api-reference/market/get-market-orderbook?utm_source=chatgpt.com)
  const ob = orderbook?.orderbook || orderbook || {};
  const yesBids = Array.isArray(ob.yes) ? ob.yes : [];
  const noBids  = Array.isArray(ob.no)  ? ob.no  : [];

  const bestYesBid = yesBids.reduce((m, lvl) => Math.max(m, Number(lvl?.[0] ?? -1)), -1);
  const bestNoBid  = noBids.reduce((m, lvl) => Math.max(m, Number(lvl?.[0] ?? -1)), -1);

  const yesAsk = bestNoBid >= 0 ? (100 - bestNoBid) : null;
  const noAsk  = bestYesBid >= 0 ? (100 - bestYesBid) : null;

  return {
    bestYesBid: bestYesBid >= 0 ? bestYesBid : null,
    bestNoBid:  bestNoBid  >= 0 ? bestNoBid  : null,
    yesAsk: (yesAsk !== null && yesAsk >= 1 && yesAsk <= 99) ? yesAsk : null,
    noAsk:  (noAsk  !== null && noAsk  >= 1 && noAsk  <= 99) ? noAsk  : null,
  };
}

// -------- trading (auth required) --------

export async function createOrder({ ticker, action="buy", side, count, priceCents, postOnly=false, tif="fill_or_kill" } = {}) {
  const t = String(ticker || "").trim();
  const s = String(side || "").toLowerCase();
  const a = String(action || "").toLowerCase();
  const c = Number(count);

  if (!t) throw new Error("missing order ticker");
  if (s !== "yes" && s !== "no") throw new Error("missing/invalid side (must be yes/no)");
  if (a !== "buy" && a !== "sell") throw new Error("invalid action (buy/sell)");
  if (!Number.isFinite(c) || c < 1) throw new Error("invalid count");

  const px = Number(priceCents);
  if (!Number.isFinite(px) || px < 1 || px > 99) throw new Error("invalid priceCents (1..99)");

  const body = {
    ticker: t,
    type: "limit",
    action: a,
    side: s,                  // REQUIRED (you hit missing side earlier)
    count: c,
    time_in_force: tif,        // "fill_or_kill" recommended for taker entries
    post_only: !!postOnly,
  };

  if (s === "yes") body.yes_price = px;
  else body.no_price = px;

  return kalshiFetch("POST", "/portfolio/orders", body, { auth: true });
}
