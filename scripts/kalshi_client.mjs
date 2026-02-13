import crypto from "crypto";

function normalizePem(pem) {
  if (!pem) return "";
  const trimmed = pem.trim();

  // If pasted with literal "\n"
  if (trimmed.includes("\\n")) return trimmed.replace(/\\n/g, "\n");

  // If it's one-line PEM: BEGIN...KEY-----MIIE...-----END...
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
    this.keyId = process.env.KALSHI_API_KEY_ID || process.env.NEXT_PUBLIC_KALSHI_API_KEY_ID || "";
    this.env = (process.env.KALSHI_ENV || process.env.NEXT_PUBLIC_KALSHI_ENV || "prod").toLowerCase();
    this.baseUrl =
      this.env === "demo"
        ? "https://demo-api.kalshi.co/trade-api/v2"
        : "https://api.elections.kalshi.com/trade-api/v2";

    const pem = normalizePem(process.env.KALSHI_PRIVATE_KEY || "");
    if (!this.keyId || !pem) throw new Error("Missing Kalshi credentials (KALSHI_API_KEY_ID and/or KALSHI_PRIVATE_KEY)");
    this.privateKey = crypto.createPrivateKey(pem);
  }

  sign(method, path, tsMs) {
    // Kalshi docs: sign concat(timestamp + method + path) and timestamp must be ms.  [oai_citation:0‡Kalshi API Docs](https://docs.kalshi.com/getting_started/api_keys?utm_source=chatgpt.com)
    const payload = [tsMs, method.toUpperCase(), path].join("");
    const signer = crypto.createSign("RSA-SHA256");
    signer.update(payload);
    signer.end();
    return signer.sign(this.privateKey, "base64");
  }

  async request(method, path, bodyObj) {
    const tsMs = Date.now().toString();
    const cleanPath = path.split("?")[0]; // per Kalshi auth troubleshooting  [oai_citation:1‡Kalshi API Docs](https://docs.kalshi.com/getting_started/quick_start_authenticated_requests?utm_source=chatgpt.com)
    const sig = this.sign(method, cleanPath, tsMs);

    const headers = {
      "Content-Type": "application/json",
      "KALSHI-ACCESS-KEY": this.keyId,
      "KALSHI-ACCESS-TIMESTAMP": tsMs,
      "KALSHI-ACCESS-SIGNATURE": sig
    };

    const res = await fetch([this.baseUrl, path].join(""), {
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

  // Portfolio
  getBalance() {
    return this.request("GET", "/portfolio/balance");
  }

  // Market data
  getOrderbook(marketTicker, depth=1) {
    return this.request("GET", ["/markets/", encodeURIComponent(marketTicker), "/orderbook?depth=", depth].join(""));
  }

  // Orders (Create Order endpoint)  [oai_citation:2‡Kalshi API Docs](https://docs.kalshi.com/api-reference/orders/create-order?utm_source=chatgpt.com)
  createOrder({ ticker, type="market", action="buy", side="yes", count, yes_price }) {
    return this.request("POST", "/portfolio/orders", { ticker, type, action, side, count, yes_price });
  }
}
