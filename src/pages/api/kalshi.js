// pages/api/kalshi.js
// Uses Kalshi's official JavaScript signing method from their docs:
// https://docs.kalshi.com/getting_started/api_keys#javascript

import crypto from "crypto";

const DEMO_BASE = "https://demo-api.kalshi.co/trade-api/v2";
const PROD_BASE = "https://api.elections.kalshi.com/trade-api/v2";

function getBase() {
  return process.env.NEXT_PUBLIC_KALSHI_ENV === "demo" ? DEMO_BASE : PROD_BASE;
}

// Reconstruct a valid PEM key from whatever Vercel gives us
function fixPem(raw) {
  let k = raw.trim();

  // Remove wrapping quotes
  if ((k[0] === '"' && k[k.length - 1] === '"') || (k[0] === "'" && k[k.length - 1] === "'")) {
    k = k.slice(1, -1);
  }

  // Replace escaped newlines
  k = k.replace(/\\n/g, "\n");

  // Detect key type from whatever header fragment exists
  const isRsa = /RSA/i.test(k);
  const header = isRsa ? "-----BEGIN RSA PRIVATE KEY-----" : "-----BEGIN PRIVATE KEY-----";
  const footer = isRsa ? "-----END RSA PRIVATE KEY-----" : "-----END PRIVATE KEY-----";

  // Strip ALL header/footer variants (even malformed ones with wrong dash count)
  let b64 = k
    .replace(/-+BEGIN[^-]*-+/g, "")
    .replace(/-+END[^-]*-+/g, "")
    .replace(/[\s\r\n]+/g, "");

  // Reformat into proper 64-char PEM lines
  const lines = b64.match(/.{1,64}/g) || [];
  return `${header}\n${lines.join("\n")}\n${footer}`;
}

// Kalshi's official JS signing method (from their docs)
function signPssText(privateKeyPem, text) {
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(text);
  sign.end();

  const signature = sign.sign({
    key: privateKeyPem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });

  return signature.toString("base64");
}

export default async function handler(req, res) {
  const keyId = process.env.NEXT_PUBLIC_KALSHI_API_KEY_ID;
  const rawKey = process.env.KALSHI_PRIVATE_KEY;

  if (!keyId || !rawKey || keyId === "your-api-key-id-here") {
    return res.status(200).json({ error: "no_keys", message: "API keys not configured." });
  }

  const { path, method = "GET", body } = req.body || {};
  if (!path) return res.status(400).json({ error: "Missing path" });

  const base = getBase();
  const fullPath = `/trade-api/v2${path}`;
  const timestamp = String(Date.now());

  try {
    const privateKeyPem = fixPem(rawKey);

    // Build the message to sign: timestamp + method + path (no query params)
    const pathWithoutQuery = fullPath.split("?")[0];
    const msgString = timestamp + method + pathWithoutQuery;
    const sig = signPssText(privateKeyPem, msgString);

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
    const text = await resp.text();

    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!resp.ok) {
      return res.status(resp.status).json({
        error: "kalshi_error",
        status: resp.status,
        detail: data,
        base,
        env: process.env.NEXT_PUBLIC_KALSHI_ENV || "prod",
      });
    }

    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({
      error: "server_error",
      message: err.message,
    });
  }
}
