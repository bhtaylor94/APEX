// lib/kalshi.js
// Server-side Kalshi API client with RSA-PSS authentication
// Handles Vercel PEM newline escaping issues

import crypto from "crypto";

const PROD_BASE = "https://trading-api.kalshi.com/trade-api/v2";
const DEMO_BASE = "https://demo-api.kalshi.co/trade-api/v2";

// Also works via the elections subdomain (all markets, not just elections)
const PROD_BASE_ALT = "https://api.elections.kalshi.com/trade-api/v2";

function getBaseUrl() {
  return process.env.NEXT_PUBLIC_KALSHI_ENV === "demo" ? DEMO_BASE : PROD_BASE;
}

function getPublicBaseUrl() {
  // Public endpoints work on the elections URL without auth
  return PROD_BASE_ALT;
}

function formatPemKey(raw) {
  if (!raw) return raw;
  let key = raw;

  // Vercel env vars escape \n as literal \\n
  if (key.includes("\\n")) {
    key = key.replace(/\\n/g, "\n");
  }

  // Strip surrounding quotes if present
  key = key.replace(/^["']|["']$/g, "");

  // Already properly formatted
  if (key.includes("-----BEGIN") && key.includes("\n") && key.trim().endsWith("-----")) {
    return key.trim();
  }

  // Raw base64 without PEM wrapper
  if (!key.includes("-----BEGIN")) {
    const clean = key.replace(/[\s"']+/g, "");
    const lines = clean.match(/.{1,64}/g) || [];
    return `-----BEGIN RSA PRIVATE KEY-----\n${lines.join("\n")}\n-----END RSA PRIVATE KEY-----`;
  }

  // All on one line — reformat
  key = key
    .replace(/-----BEGIN RSA PRIVATE KEY-----\s*/, "-----BEGIN RSA PRIVATE KEY-----\n")
    .replace(/\s*-----END RSA PRIVATE KEY-----/, "\n-----END RSA PRIVATE KEY-----");

  const match = key.match(
    /-----BEGIN RSA PRIVATE KEY-----\n([\s\S]+)\n-----END RSA PRIVATE KEY-----/
  );
  if (match) {
    const b64 = match[1].replace(/\s+/g, "");
    const lines = b64.match(/.{1,64}/g) || [];
    return `-----BEGIN RSA PRIVATE KEY-----\n${lines.join("\n")}\n-----END RSA PRIVATE KEY-----`;
  }

  return key.trim();
}

function signRequest(privateKeyPem, timestamp, method, path) {
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

function getAuthHeaders(method, path) {
  const apiKeyId = process.env.NEXT_PUBLIC_KALSHI_API_KEY_ID;
  const privateKey = process.env.KALSHI_PRIVATE_KEY;

  if (!apiKeyId || !privateKey) {
    throw new Error("Kalshi API credentials not configured");
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const fullPath = `/trade-api/v2${path}`;
  const signature = signRequest(privateKey, timestamp, method, fullPath);

  return {
    "KALSHI-ACCESS-KEY": apiKeyId,
    "KALSHI-ACCESS-SIGNATURE": signature,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
    "Content-Type": "application/json",
  };
}

// Authenticated request (for portfolio/orders)
export async function kalshiFetch(path, method = "GET", body = null) {
  const baseUrl = getBaseUrl();
  const headers = getAuthHeaders(method, path);
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${baseUrl}${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kalshi ${res.status}: ${text}`);
  }
  return res.json();
}

// Public request (no auth needed — market data)
export async function kalshiPublicFetch(path) {
  const baseUrl = getPublicBaseUrl();
  const res = await fetch(`${baseUrl}${path}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kalshi public ${res.status}: ${text}`);
  }
  return res.json();
}

export function isConfigured() {
  return !!(
    process.env.NEXT_PUBLIC_KALSHI_API_KEY_ID &&
    process.env.KALSHI_PRIVATE_KEY
  );
}
