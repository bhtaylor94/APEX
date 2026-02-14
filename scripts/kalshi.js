import crypto from "crypto";

/**
 * Kalshi REST Auth (per docs):
 * Headers required:
 *  - KALSHI-ACCESS-KEY: Key ID
 *  - KALSHI-ACCESS-TIMESTAMP: ms timestamp string
 *  - KALSHI-ACCESS-SIGNATURE: base64(RSA-PSS-SHA256(sign(timestamp + METHOD + PATH_NO_QUERY)))
 *
 * Docs: https://docs.kalshi.com/getting_started/api_keys
 */

function baseUrl() {
  const env = String(process.env.KALSHI_ENV || process.env.NEXT_PUBLIC_KALSHI_ENV || "prod").toLowerCase();
  // Kalshi docs commonly show demo-api.kalshi.co for demo and api.elections.kalshi.com for prod
  if (env.includes("demo")) return "https://demo-api.kalshi.co";
  return "https://api.elections.kalshi.com";
}

function mustEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing env var: ${name}`);
  return String(v);
}

function signPssBase64(privateKeyPem, msg) {
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(msg);
  sign.end();

  const signature = sign.sign({
    key: privateKeyPem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });

  return signature.toString("base64");
}

async function kalshiFetch(pathWithQuery, { method = "GET", body = null } = {}) {
  const keyId = mustEnv("KALSHI_API_KEY_ID");
  const privateKeyPem = mustEnv("KALSHI_PRIVATE_KEY");

  const url = baseUrl() + pathWithQuery;

  // IMPORTANT: sign the PATH WITHOUT QUERY PARAMETERS
  const pathNoQuery = String(pathWithQuery).split("?")[0];
  const ts = String(Date.now());
  const msg = ts + method.toUpperCase() + pathNoQuery;

  const sig = signPssBase64(privateKeyPem, msg);

  const headers = {
    "KALSHI-ACCESS-KEY": keyId.trim(),
    "KALSHI-ACCESS-TIMESTAMP": ts,
    "KALSHI-ACCESS-SIGNATURE": sig,
    "Accept": "application/json",
  };

  // NOTE: Never put the private key in headers. Only signature goes in header.
  let fetchBody = undefined;
  if (body !== null && body !== undefined) {
    headers["Content-Type"] = "application/json";
    fetchBody = JSON.stringify(body);
  }

  const res = await fetch(url, { method, headers, body: fetchBody });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

  if (!res.ok) {
    const msg2 = (data && (data.error || data.message)) ? (data.error || data.message) : text;
    throw new Error(`Kalshi ${method} ${pathWithQuery} failed (${res.status}): ${msg2}`);
  }

  return data;
}

export async function listMarkets({ status = "open", limit = 200, series_ticker = undefined } = {}) {
  const q = new URLSearchParams();
  if (status) q.set("status", status);
  if (limit) q.set("limit", String(limit));
  if (series_ticker) q.set("series_ticker", series_ticker);

  return kalshiFetch(`/trade-api/v2/markets?${q.toString()}`, { method: "GET" });
}

/**
 * Robust BTC 15m Up/Down market discovery:
 * - Try series ticker variants (as-is / lower / upper)
 * - Fallback: scan all open markets and pick those whose ticker starts with kxbtc15m-
 */
export async function getBTCMarkets({ seriesTicker = "kxbtc15m", status = "open", limit = 200 } = {}) {
  const st = String(seriesTicker || "kxbtc15m");
  const variants = Array.from(new Set([st, st.toLowerCase(), st.toUpperCase()]));

  for (const v of variants) {
    try {
      const resp = await listMarkets({ status, limit, series_ticker: v });
      const markets = Array.isArray(resp?.markets) ? resp.markets : [];
      if (markets.length) return { method: "series", used: v, markets };
    } catch {
      // keep trying
    }
  }

  // Fallback: pull open markets and filter by ticker prefix (strongest signal)
  const all = await listMarkets({ status, limit: 500 });
  const allMkts = Array.isArray(all?.markets) ? all.markets : [];

  const prefixLower = st.toLowerCase() + "-";
  const prefixUpper = st.toUpperCase() + "-";

  const filtered = allMkts.filter(m => {
    const t = String(m.ticker || "");
    return t.startsWith(prefixLower) || t.startsWith(prefixUpper);
  });

  // pick most liquid/active first
  filtered.sort((a,b) => (Number(b.volume||0) - Number(a.volume||0)));

  return { method: "fallback_all_open", used: st, markets: filtered };
}

/**
 * Place order:
 * - mode: "paper" => DO NOT place live order (returns a simulated result)
 * - mode: "live"  => POST /portfolio/orders
 */
export async function placeKalshiOrder({ ticker, side, count, price, mode = "paper" } = {}) {
  if (!ticker) throw new Error("placeKalshiOrder: missing ticker");
  if (side !== "yes" && side !== "no") throw new Error("placeKalshiOrder: side must be yes|no");
  if (!Number.isFinite(Number(count)) || Number(count) <= 0) throw new Error("placeKalshiOrder: bad count");
  if (!Number.isFinite(Number(price)) || Number(price) <= 0 || Number(price) >= 100) throw new Error("placeKalshiOrder: bad price (1-99)");

  if (String(mode).toLowerCase() !== "live") {
    return {
      ok: true,
      paper: true,
      order: { ticker, side, count: Number(count), price: Number(price), status: "paper_simulated" }
    };
  }

  const body = {
    ticker,
    action: "buy",
    count: Number(count),
    type: "limit",
    // Kalshi expects yes_price/no_price in cents
    ...(side === "yes" ? { yes_price: Number(price) } : { no_price: Number(price) }),
  };

  return kalshiFetch("/trade-api/v2/portfolio/orders", { method: "POST", body });
}
