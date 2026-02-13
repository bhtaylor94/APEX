// lib/kalshi.js
// Server-side Kalshi API client with RSA-PSS authentication
// Handles Vercel PEM newline escaping issues

import crypto from "crypto";

const PROD_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const DEMO_BASE = "https://demo-api.kalshi.co/trade-api/v2";

function getBaseUrl() {
  return process.env.NEXT_PUBLIC_KALSHI_ENV === "demo" ? DEMO_BASE : PROD_BASE;
}

function getPublicBaseUrl() {
  // Public endpoints work on the elections URL without auth
  return PROD_BASE;
}

function formatPemKey(raw) {
  if (!raw) return raw;

  // Normalize common env-var encodings (Vercel often stores PEM as one line or with literal \n)
  let key = String(raw).trim();

  // Strip wrapping quotes
  key = key.replace(/^["']|["']$/g, "");

  // Convert literal \n to real newlines
  key = key.replace(/\\n/g, "\n");

  // Normalize CRLF
  key = key.replace(/\r\n/g, "\n");

  const hasBegin = key.includes("-----BEGIN");
  const hasEnd = key.includes("-----END");

  // If PEM is on one line (BEGIN...base64...END), reconstruct with wrapped base64
  if (hasBegin && hasEnd && !key.includes("\n")) {
    const beginMatch = key.match(/-----BEGIN [A-Z ]+-----/);
    const endMatch = key.match(/-----END [A-Z ]+-----/);
    if (beginMatch && endMatch) {
      const header = beginMatch[0];
      const footer = endMatch[0];
      const body = key
        .replace(header, "")
        .replace(footer, "")
        .replace(/\s+/g, "");
      const lines = body.match(/.{1,64}/g) || [];
      return `${header}\n${lines.join("\n")}\n${footer}`.trim();
    }
  }

  // Raw base64 without PEM wrapper
  if (!hasBegin) {
    const clean = key.replace(/[\s"']+/g, "");
    const lines = clean.match(/.{1,64}/g) || [];
    // Prefer PKCS#8 wrapper
    return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
  }

  // Ensure header/footer are separated by newlines and body is wrapped at 64 chars
  key = key
    .replace(/(-----BEGIN [A-Z ]+-----)\s*/, "$1\n")
    .replace(/\s*(-----END [A-Z ]+-----)/, "\n$1");

  const match = key.match(/-----BEGIN [A-Z ]+-----\n([\s\S]+)\n-----END [A-Z ]+-----/);
  if (match) {
    const b64 = match[1].replace(/\s+/g, "");
    const lines = b64.match(/.{1,64}/g) || [];
    const header = key.match(/-----BEGIN [A-Z ]+-----/)[0];
    const footer = key.match(/-----END [A-Z ]+-----/)[0];
    return `${header}\n${lines.join("\n")}\n${footer}`.trim();
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
  const apiKeyId = process.env.KALSHI_API_KEY_ID || process.env.NEXT_PUBLIC_KALSHI_API_KEY_ID;
  const privateKey = process.env.KALSHI_PRIVATE_KEY;

  if (!apiKeyId || !privateKey) {
    throw new Error("Kalshi API credentials not configured");
  }

  // Kalshi expects a millisecond timestamp (string)
  const timestamp = Date.now().toString();
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
    process.env.KALSHI_API_KEY_ID || process.env.NEXT_PUBLIC_KALSHI_API_KEY_ID &&
    process.env.KALSHI_PRIVATE_KEY
  );
}