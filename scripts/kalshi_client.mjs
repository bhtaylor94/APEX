function loadPemKey(raw) {
  if (!raw) return "";
  // If user stored key with literal \n, fix it
  let k = String(raw).trim().replace(/\\n/g, "\n");

  // If it's base64 (no PEM header), decode
  if (!k.includes("BEGIN") && /^[A-Za-z0-9+/=\r\n]+$/.test(k) && k.length > 200) {
    try {
      const buf = Buffer.from(k.replace(/\s+/g, ""), "base64");
      const decoded = buf.toString("utf8");
      if (decoded.includes("BEGIN")) k = decoded.trim();
    } catch {}
  }

  // Ensure it looks like PEM
  return k;
}

import crypto from "crypto";

function normalizePem(pem) {
  if (!pem) return "";
  const trimmed = pem.trim();

  if (trimmed.includes("\\n")) return trimmed.replace(/\\n/g, "\n");

  if (trimmed.includes("BEGIN") && trimmed.includes("END") && !trimmed.includes("\n")) {
    const m = trimmed.match(/(-----BEGIN [^-]+-----)(.+)(-----END [^-]+-----)/);
    if (!m) return trimmed;
    const head = m[1];
    const body = m[2].replace(/\s+/g, "");
    const tail = m[3];
    const wrapped = body.match(/.{1,64}/g)?.join("\n") || body;
    return [head, wrapped, tail].join("\n");
  }

  return trimmed;
}

export class KalshiClient {
  constructor() {
    this.keyId = process.env.KALSHI_API_KEY_ID || "";
    this.env = (process.env.KALSHI_ENV || "prod").toLowerCase();
    this.baseUrl =
      this.env === "demo"
        ? "https://demo-api.kalshi.co/trade-api/v2"
        : "https://api.elections.kalshi.com/trade-api/v2";

    const pem = normalizePem(process.env.KALSHI_PRIVATE_KEY || "");
    if (!this.keyId || !pem) throw new Error("Missing Kalshi credentials (KALSHI_API_KEY_ID/KALSHI_PRIVATE_KEY)");
    this.privateKey = crypto.createPrivateKey(loadPemKey(process.env.KALSHI_PRIVATE_KEY));
  }

  sign(method, pathNoQuery, tsMs) {
    const payload = [tsMs, method.toUpperCase(), pathNoQuery].join("");
    const signer = crypto.createSign("RSA-SHA256");
    signer.update(payload);
    signer.end();
    return signer.sign(this.privateKey, "base64");
  }

  async request(method, path, bodyObj) {
    const tsMs = Date.now().toString();
    const pathNoQuery = path.split("?")[0];
    const sig = this.sign(method, pathNoQuery, tsMs);

    const headers = {
      "Content-Type": "application/json",
      "KALSHI-ACCESS-KEY": this.keyId,
      "KALSHI-ACCESS-TIMESTAMP": tsMs,
      "KALSHI-ACCESS-SIGNATURE": sig
    };

    const res = await fetch(this.baseUrl + path, {
      method,
      headers,
      body: bodyObj ? JSON.stringify(bodyObj) : undefined
    });

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!res.ok) {
      const msg = data?.error || data?.message || JSON.stringify(data);
      throw new Error([method, path, res.status, msg].join(" "));
    }
    return data;
  }

  getMarkets({ series_ticker, status="open", limit=50 } = {}) {
    const qs = new URLSearchParams();
    if (series_ticker) qs.set("series_ticker", series_ticker);
    if (status) qs.set("status", status);
    qs.set("limit", String(limit));
    return this.request("GET", "/markets?" + qs.toString());
  }

  createOrder({ ticker, type="market", action="buy", side="yes", count, priceCents }) {
    const payload = { ticker, type, action, side, count };
    if (side === "yes") payload.yes_price = priceCents;
    if (side === "no") payload.no_price = priceCents;
    return this.request("POST", "/portfolio/orders", payload);
  }
}
