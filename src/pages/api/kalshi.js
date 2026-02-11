// pages/api/kalshi.js
// Proxies authenticated requests to Kalshi API with RSA-PSS signing
// Private key stays server-side, never exposed to the browser

import crypto from "crypto";

// Correct Kalshi API base URLs
const DEMO_BASE = "https://demo-api.kalshi.co/trade-api/v2";
const PROD_BASE = "https://trading-api.kalshi.com/trade-api/v2";

function getBase() {
  return process.env.NEXT_PUBLIC_KALSHI_ENV === "demo" ? DEMO_BASE : PROD_BASE;
}

function formatPemKey(raw) {
  // Vercel env vars mangle newlines in PEM keys
  // Handle all common cases:

  // 1. Escaped \n as literal characters (Vercel does this)
  let key = raw;
  if (key.includes("\\n")) {
    key = key.replace(/\\n/g, "\n");
  }

  // 2. Already properly formatted with real newlines
  if (key.includes("-----BEGIN") && key.includes("\n")) {
    return key.trim();
  }

  // 3. Raw base64 without PEM wrapper — wrap it
  if (!key.includes("-----BEGIN")) {
    const clean = key.replace(/[\s"']+/g, "");
    const lines = clean.match(/.{1,64}/g) || [];
    return `-----BEGIN RSA PRIVATE KEY-----\n${lines.join("\n")}\n-----END RSA PRIVATE KEY-----`;
  }

  // 4. All on one line with spaces instead of newlines
  key = key.replace(/-----BEGIN RSA PRIVATE KEY-----\s*/, "-----BEGIN RSA PRIVATE KEY-----\n")
    .replace(/\s*-----END RSA PRIVATE KEY-----/, "\n-----END RSA PRIVATE KEY-----");
  
  // Split the middle base64 content into proper lines
  const match = key.match(/-----BEGIN RSA PRIVATE KEY-----\n([\s\S]+)\n-----END RSA PRIVATE KEY-----/);
  if (match) {
    const b64 = match[1].replace(/\s+/g, "");
    const lines = b64.match(/.{1,64}/g) || [];
    return `-----BEGIN RSA PRIVATE KEY-----\n${lines.join("\n")}\n-----END RSA PRIVATE KEY-----`;
  }

  return key.trim();
}

function sign(privateKeyPem, timestamp, method, path) {
  const pathOnly = path.split("?")[0];
  const message = `${timestamp}${method}${pathOnly}`;

  const formattedKey = formatPemKey(privateKeyPem);
  const key = crypto.createPrivateKey(formattedKey);
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
    return res.status(200).json({
      error: "no_keys",
      message: "API keys not configured.",
    });
  }

  const { path, method = "GET", body } = req.body || {};
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
    const text = await resp.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text, status: resp.status };
    }

    if (!resp.ok) {
      return res.status(resp.status).json({
        error: "kalshi_error",
        status: resp.status,
        detail: data,
        base: base,
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
