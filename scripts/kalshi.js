import crypto from "crypto";

function readKalshiPrivateKey() {
  // Source of truth: env var KALSHI_PRIVATE_KEY (often stored with \n in GitHub secrets)
  const rawEnv = String(process.env.KALSHI_PRIVATE_KEY || "").trim();

  // Optional: allow pointing to a PEM file via KALSHI_PRIVATE_KEY_PATH
  const p = String(process.env.KALSHI_PRIVATE_KEY_PATH || "").trim();

  let raw = rawEnv;
  if (!raw && p) {
    try {
      raw = fs.readFileSync(p, "utf8").trim();
    } catch {
      raw = "";
    }
  }

  // Normalize GitHub-style escaped newlines
  return raw.replace(/\\n/g, "\n").trim();
}


const ENV = (process.env.NEXT_PUBLIC_KALSHI_ENV || process.env.KALSHI_ENV || "prod").toLowerCase();

// Per Kalshi docs: demo uses demo-api.kalshi.co ; production uses api.elections.kalshi.com (trade-api/v2)
const BASE =
  ENV === "demo" || ENV === "sandbox"
    ? "https://demo-api.kalshi.co"
    : "https://api.elections.kalshi.com";

const API_KEY_ID = process.env.KALSHI_API_KEY_ID || process.env.NEXT_PUBLIC_KALSHI_API_KEY_ID || "";
const PRIVATE_KEY_PEM = readKalshiPrivateKey() || "";

function mustEnv(name, v) {
  if (!v) throw new Error("Missing env: " + name);
  return v;
}

// RSA-PSS SHA256 signature (per docs)
function signKalshi({ timestampMs, method, path }) {
  const keyId = mustEnv("KALSHI_API_KEY_ID", API_KEY_ID);
  const pem = mustEnv("KALSHI_PRIVATE_KEY", PRIVATE_KEY_PEM);

  // IMPORTANT: sign path without query params
  const pathNoQuery = path.split("?")[0];
  const msg = String(timestampMs) + method.toUpperCase() + pathNoQuery;

  const signature = crypto.sign("sha256", Buffer.from(msg, "utf8"), {
    key: pem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
  });

  return {
    keyId,
    signatureB64: signature.toString("base64"),
  };
}

export async function kalshiFetch(path, { method = "GET", body = null, auth = true } = {}) {
  const url = BASE + path;
  const headers = { "Content-Type": "application/json" };

  if (auth) {
    const ts = Date.now();
    const sig = signKalshi({ timestampMs: ts, method, path });
    headers["KALSHI-ACCESS-KEY"] = sig.keyId;
    headers["KALSHI-ACCESS-TIMESTAMP"] = String(ts);
    headers["KALSHI-ACCESS-SIGNATURE"] = sig.signatureB64;
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
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

export async function getOrderbook(ticker, depth = 1) {
  const qs = new URLSearchParams({ ticker, depth: String(depth) });
  return kalshiFetch("/trade-api/v2/markets/" + encodeURIComponent(ticker) + "/orderbook?" + qs.toString(), { method: "GET", auth: true });
}

export async function getMarket(ticker) {
  if (!ticker) throw new Error("getMarket: missing ticker");
  const enc = encodeURIComponent(ticker);
  return kalshiFetch("/trade-api/v2/markets/" + enc, { method: "GET", auth: true });
}

export async function placeOrder({ ticker, side, count, priceCents }) {
  // side must be "yes" or "no"
  if (side !== "yes" && side !== "no") throw new Error("Invalid side: " + side);
  if (!Number.isFinite(count) || count <= 0) throw new Error("Invalid count: " + count);
  if (!Number.isFinite(priceCents) || priceCents <= 0 || priceCents >= 99) {
    throw new Error("Invalid priceCents: " + priceCents);
  }

  // IMPORTANT: Kalshi requires EXACTLY ONE of yes_price/no_price
  const body = {
    ticker,
    action: "buy",
    type: "limit",
    side,
    count,
    client_order_id: ""
  };

  if (side === "yes") body.yes_price = priceCents;
  if (side === "no")  body.no_price  = priceCents;

  return kalshiFetch("/trade-api/v2/portfolio/orders", { method: "POST", body, auth: true });
}


