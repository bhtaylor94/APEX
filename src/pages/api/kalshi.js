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
  // Vercel env vars mangle newlines in PEM keys.
  // This handles PKCS#1 (BEGIN RSA PRIVATE KEY) AND PKCS#8 (BEGIN PRIVATE KEY)

  let key = raw.trim();

  // Strip wrapping quotes if Vercel added them
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1);
  }

  // Replace literal \n sequences with real newlines
  key = key.replace(/\\n/g, "\n");

  // If it already has proper PEM headers and newlines, return as-is
  if (key.includes("-----BEGIN") && key.includes("\n") && key.split("\n").length > 3) {
    return key;
  }

  // Detect which PEM type we have
  let header, footer;
  if (key.includes("BEGIN RSA PRIVATE KEY")) {
    header = "-----BEGIN RSA PRIVATE KEY-----";
    footer = "-----END RSA PRIVATE KEY-----";
  } else if (key.includes("BEGIN PRIVATE KEY")) {
    header = "-----BEGIN PRIVATE KEY-----";
    footer = "-----END PRIVATE KEY-----";
  } else if (key.includes("BEGIN EC PRIVATE KEY")) {
    header = "-----BEGIN EC PRIVATE KEY-----";
    footer = "-----END EC PRIVATE KEY-----";
  } else {
    // Raw base64 with no header — assume PKCS#8 since that's what Kalshi generates
    header = "-----BEGIN PRIVATE KEY-----";
    footer = "-----END PRIVATE KEY-----";
  }

  // Extract just the base64 content
  let b64 = key
    .replace(/-----BEGIN[^-]+-----/g, "")
    .replace(/-----END[^-]+-----/g, "")
    .replace(/[\s\r\n]+/g, "");

  // Reformat into proper 64-char PEM lines
  const lines = b64.match(/.{1,64}/g) || [];
  return `${header}\n${lines.join("\n")}\n${footer}`;
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
