import crypto from "node:crypto";

function envStr(k, d="") {
  const v = process.env[k];
  return (v && String(v).trim()) ? String(v) : d;
}

function getBaseUrl() {
  const e = (envStr("KALSHI_ENV", envStr("NEXT_PUBLIC_KALSHI_ENV", "prod")) || "prod").toLowerCase();
  if (e.includes("demo")) return "https://demo-api.kalshi.co";
  return "https://api.elections.kalshi.com";
}

function toPathNoQuery(p) { return String(p).split("?")[0]; }

function signKalshi({ timestampMs, method, path }) {
  const keyId = envStr("KALSHI_API_KEY_ID");
  const privateKeyPem = envStr("KALSHI_PRIVATE_KEY");
  if (!keyId || !privateKeyPem) throw new Error("missing kalshi keys (KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY)");

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
  const fullPath = cleanPath.startsWith("/trade-api/") ? cleanPath : ("/trade-api/v2" + (cleanPath.startsWith("/") ? cleanPath : ("/" + cleanPath)));
  const url = base + fullPath;

  const headers = { "Content-Type": "application/json" };
  if (auth) Object.assign(headers, signKalshi({ timestampMs: Date.now(), method, path: fullPath }));

  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

  if (!res.ok) {
    const msg = (typeof data === "object" && data) ? JSON.stringify(data) : String(text || "");
    throw new Error(`Kalshi ${method} ${fullPath} failed (${res.status}): ${msg}`);
  }
  return data;
}

export async function listMarkets({ seriesTicker, status="active", limit=200 } = {}) {
  const qs = new URLSearchParams();
  if (seriesTicker) qs.set("series_ticker", seriesTicker);
  if (status) qs.set("status", status);
  if (limit) qs.set("limit", String(limit));
  const path = "/markets" + (qs.toString() ? ("?" + qs.toString()) : "");
  return kalshiFetch("GET", path, null, { auth: false });
}

export async function getMarket(ticker) {
  const t = String(ticker || "").trim();
  if (!t) throw new Error("missing ticker for getMarket");
  return kalshiFetch("GET", `/markets/${encodeURIComponent(t)}`, null, { auth: false });
}

export async function getOrderbook(ticker) {
  const t = String(ticker || "").trim();
  if (!t) throw new Error("missing ticker for orderbook");
  return kalshiFetch("GET", `/markets/${encodeURIComponent(t)}/orderbook`, null, { auth: false });
}

function levelPrice(lvl) {
  // Supports [price, qty] or {price:..} style just in case
  if (Array.isArray(lvl)) return Number(lvl[0]);
  if (lvl && typeof lvl === "object") return Number(lvl.price ?? lvl.p ?? lvl[0]);
  return NaN;
}

export function deriveAsksFromOrderbook(orderbook) {
  // Orderbook returns bids only; asks implied from opposite bids.  [oai_citation:1‡Kalshi API Documentation](https://docs.kalshi.com/api-reference/market/get-market-orderbook?utm_source=chatgpt.com)
  const ob = orderbook?.orderbook || orderbook || {};
  const yesBids = Array.isArray(ob.yes) ? ob.yes : (Array.isArray(ob.yes_bids) ? ob.yes_bids : []);
  const noBids  = Array.isArray(ob.no)  ? ob.no  : (Array.isArray(ob.no_bids) ? ob.no_bids : []);

  let bestYesBid = null;
  for (const lvl of yesBids) {
    const p = levelPrice(lvl);
    if (Number.isFinite(p)) bestYesBid = bestYesBid === null ? p : Math.max(bestYesBid, p);
  }

  let bestNoBid = null;
  for (const lvl of noBids) {
    const p = levelPrice(lvl);
    if (Number.isFinite(p)) bestNoBid = bestNoBid === null ? p : Math.max(bestNoBid, p);
  }

  const yesAsk = (bestNoBid !== null) ? (100 - bestNoBid) : null;
  const noAsk  = (bestYesBid !== null) ? (100 - bestYesBid) : null;

  return {
    bestYesBid, bestNoBid,
    yesAsk: (yesAsk !== null && yesAsk >= 1 && yesAsk <= 99) ? yesAsk : null,
    noAsk:  (noAsk  !== null && noAsk  >= 1 && noAsk  <= 99) ? noAsk  : null,
  };
}

export async function createOrder({ ticker, action="buy", side, count, priceCents, postOnly=false, tif="fill_or_kill" } = {}) {
  const t = String(ticker || "").trim();
  const s = String(side || "").toLowerCase();
  const a = String(action || "").toLowerCase();
  const c = Number(count);
  const px = Number(priceCents);

  if (!t) throw new Error("missing order ticker");
  if (s !== "yes" && s !== "no") throw new Error("missing/invalid side (must be yes/no)");
  if (a !== "buy" && a !== "sell") throw new Error("invalid action (buy/sell)");
  if (!Number.isFinite(c) || c < 1) throw new Error("invalid count");
  if (!Number.isFinite(px) || px < 1 || px > 99) throw new Error("invalid priceCents (1..99)");

  const body = {
    ticker: t,
    type: "limit",
    action: a,
    side: s,
    count: c,
    time_in_force: tif,
    post_only: !!postOnly,
  };

  if (s === "yes") body.yes_price = px;
  else body.no_price = px;

  return kalshiFetch("POST", "/portfolio/orders", body, { auth: true });
}
