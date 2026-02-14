import crypto from "crypto";

const BASE =
  (process.env.KALSHI_ENV || process.env.NEXT_PUBLIC_KALSHI_ENV || "prod").toLowerCase() === "demo"
    ? "https://demo-api.kalshi.co/trade-api/v2"
    : "https://api.elections.kalshi.com/trade-api/v2";

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error("Missing env var: " + name);
  return v;
}

function signRequest({ method, path, body }) {
  const keyId = mustEnv("KALSHI_API_KEY_ID");
  const pem = mustEnv("KALSHI_PRIVATE_KEY");

  // Kalshi uses RSA-PSS signatures. Their docs show these headers:
  // KALSHI-ACCESS-KEY, KALSHI-ACCESS-SIGNATURE, KALSHI-ACCESS-TIMESTAMP
  const ts = String(Date.now());

  const bodyStr = body ? JSON.stringify(body) : "";
  const msg = [ts, method.toUpperCase(), path, bodyStr].join("");

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(msg);
  signer.end();

  const sig = signer.sign(
    {
      key: pem,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    },
    "base64"
  );

  return {
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-SIGNATURE": sig,
    "KALSHI-ACCESS-TIMESTAMP": ts,
  };
}

async function kalshiFetch(path, { method = "GET", body = null, auth = true } = {}) {
  const url = BASE + path;
  const headers = { "Content-Type": "application/json" };

  if (auth) Object.assign(headers, signRequest({ method, path, body }));

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    throw new Error(
      "Kalshi " + method + " " + path + " failed (" + res.status + "): " + (typeof data === "string" ? data : JSON.stringify(data))
    );
  }
  return data;
}

// PUBLIC (no auth) — orderbook returns bids only
export async function getOrderbookTop(marketTicker) {
  const ob = await kalshiFetch("/markets/" + encodeURIComponent(marketTicker) + "/orderbook", { auth: false });
  // expected shape: { orderbook: { yes: [[price, size]...], no: [[price, size]...] } } (bids only)
  const book = ob?.orderbook || ob?.order_book || ob;
  const yes = Array.isArray(book?.yes) ? book.yes : [];
  const no  = Array.isArray(book?.no)  ? book.no  : [];

  const bestYesBid = yes.length ? Number(yes[0][0]) : null;
  const bestNoBid  = no.length  ? Number(no[0][0])  : null;

  // Derived asks (Kalshi docs: YES bid at X == NO ask at 100-X; NO bid at Y == YES ask at 100-Y)
  const yesAsk = bestNoBid != null ? (100 - bestNoBid) : null;
  const noAsk  = bestYesBid != null ? (100 - bestYesBid) : null;

  return { bestYesBid, bestNoBid, yesAsk, noAsk, raw: ob };
}

export async function listOpenMarkets(limit = 500) {
  // IMPORTANT: do NOT pass status=open; Kalshi response statuses include "active" etc.
  // Leaving status empty returns markets of any status. (Docs: Get Markets)
  return kalshiFetch("/markets?limit=" + limit, { auth: false });
}

export async function placeOrder({
  ticker,
  side,           // "yes" | "no"
  action,         // "buy" | "sell"
  count,
  priceCents,
  time_in_force = "fill_or_kill",
  reduce_only = false,
}) {
  // Create Order requires: ticker, side, action, count, and exactly one of yes_price/no_price (or *_dollars)
  // Docs show reduce_only boolean exists.  [oai_citation:5‡Kalshi API Documentation](https://docs.kalshi.com/api-reference/orders/create-order)
  const body = {
    ticker,
    side,
    action,
    count,
    time_in_force,
    reduce_only: !!reduce_only,
  };

  if (side === "yes") body.yes_price = priceCents;
  else body.no_price = priceCents;

  return kalshiFetch("/portfolio/orders", { method: "POST", body, auth: true });
}

export async function listMarkets({ limit = 200, status = null, series_ticker = null } = {}) {
  const q = new URLSearchParams();
  if (limit) q.set("limit", String(limit));
  if (status) q.set("status", String(status));
  if (series_ticker) q.set("series_ticker", String(series_ticker));
  return kalshiFetch("/markets?" + q.toString(), { auth: false });
}

export async function getSeriesMarkets(seriesTicker, { limit = 200 } = {}) {
  const st = String(seriesTicker || "");
  const variants = [st, st.toLowerCase(), st.toUpperCase()]
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i);

  for (const v of variants) {
    try {
      const resp = await listMarkets({ limit, series_ticker: v });
      const markets = Array.isArray(resp?.markets) ? resp.markets : [];
      if (markets.length) return { method: "series", used: v, markets };
    } catch (e) {
      // try next
    }
  }

  return { method: "series", used: variants[0] || st, markets: [] };
}
