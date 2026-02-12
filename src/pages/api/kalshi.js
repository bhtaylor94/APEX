import crypto from "crypto";

const PROD_ROOT = "https://api.elections.kalshi.com/trade-api/v2";
const DEMO_ROOT = "https://demo-api.kalshi.co/trade-api/v2";

const ALLOWED = new Map([
  ["GET", new Set([
    "/portfolio/balance",
    "/portfolio/positions",
    "/portfolio/orders",
    "/portfolio/fills",
  ])],
  ["POST", new Set([
    "/orders",
    "/orders/cancel",
  ])],
]);

function getRoot() {
  return (process.env.KALSHI_ENV || "demo") === "prod"
    ? PROD_ROOT
    : DEMO_ROOT;
}

function requireAuth(req, res) {
  const token = process.env.ADMIN_TOKEN;
  const auth = req.headers.authorization || "";
  if (!token || auth !== `Bearer ${token}`) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

function isAllowed(method, path) {
  return ALLOWED.has(method) && ALLOWED.get(method).has(path);
}

function signRequest(timestamp, method, path, privateKey) {
  const msg = `${timestamp}${method}${path}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(msg);
  signer.end();
  return signer.sign({
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString("base64");
}

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") return res.status(405).end();

  const { path, method, body } = req.body || {};
  const m = (method || "").toUpperCase();
  const p = String(path || "");

  if (!isAllowed(m, p)) {
    return res.status(403).json({ error: "Path not allowed", method: m, path: p });
  }

  const ts = Date.now();
  const sig = signRequest(ts, m, p, process.env.KALSHI_PRIVATE_KEY);

  const r = await fetch(getRoot() + p, {
    method: m,
    headers: {
      "Content-Type": "application/json",
      "KALSHI-ACCESS-KEY": process.env.KALSHI_KEY_ID,
      "KALSHI-ACCESS-TIMESTAMP": String(ts),
      "KALSHI-ACCESS-SIGNATURE": sig,
    },
    body: m === "GET" ? undefined : JSON.stringify(body || {}),
  });

  const text = await r.text();
  res.status(r.status).send(text);
}
