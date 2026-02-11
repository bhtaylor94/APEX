// pages/api/kalshi.js
// Proxies authenticated requests to Kalshi API with RSA-PSS signing
// Private key stays server-side, never exposed to the browser

import crypto from "crypto";

const DEMO_BASE = "https://demo-api.kalshi.co/trade-api/v2";
const PROD_BASE = "https://api.elections.kalshi.com/trade-api/v2";

function getBase() {
  return process.env.NEXT_PUBLIC_KALSHI_ENV === "prod" ? PROD_BASE : DEMO_BASE;
}

function sign(privateKeyPem, timestamp, method, path) {
  // Strip query params for signing
  const pathOnly = path.split("?")[0];
  const message = `${timestamp}${method}${pathOnly}`;

  const key = crypto.createPrivateKey(privateKeyPem);
  const signature = crypto.sign("sha256", Buffer.from(message), {
    key,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });

  return signature.toString("base64");
}

export default async function handler(req, res) {
  const keyId = process.env.NEXT_PUBLIC_KALSHI_API_KEY_ID;
  const privateKey = process.env.KALSHI_PRIVATE_KEY;

  if (!keyId || !privateKey || keyId === "your-api-key-id-here") {
    return res.status(200).json({ error: "no_keys", message: "API keys not configured. Running in demo/view-only mode." });
  }

  const { path, method = "GET", body } = req.body;
  if (!path) return res.status(400).json({ error: "Missing path" });

  const base = getBase();
  const fullPath = `/trade-api/v2${path}`;
  const timestamp = String(Date.now());

  try {
    const sig = sign(privateKey, timestamp, method, fullPath);
    const url = `${base}${path}`;

    const opts = {
      method,
      headers: {
        "Content-Type": "application/json",
        "KALSHI-ACCESS-KEY": keyId,
        "KALSHI-ACCESS-TIMESTAMP": timestamp,
        "KALSHI-ACCESS-SIGNATURE": sig,
      },
    };

    if (body && method !== "GET") {
      opts.body = JSON.stringify(body);
    }

    const resp = await fetch(url, opts);
    const data = await resp.json();

    return res.status(resp.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
