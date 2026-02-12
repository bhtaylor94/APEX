// pages/api/debug.js
// Temporary debug endpoint — shows key format info without exposing the actual key

function fixPem(raw) {
  let k = raw.trim();
  if ((k[0] === '"' && k[k.length - 1] === '"') || (k[0] === "'" && k[k.length - 1] === "'")) {
    k = k.slice(1, -1);
  }
  k = k.replace(/\\n/g, "\n");
  const isRsa = /RSA/i.test(k);
  const header = isRsa ? "-----BEGIN RSA PRIVATE KEY-----" : "-----BEGIN PRIVATE KEY-----";
  const footer = isRsa ? "-----END RSA PRIVATE KEY-----" : "-----END PRIVATE KEY-----";
  let b64 = k
    .replace(/-+BEGIN[^-]*-+/g, "")
    .replace(/-+END[^-]*-+/g, "")
    .replace(/[\s\r\n]+/g, "");
  const lines = b64.match(/.{1,64}/g) || [];
  return `${header}\n${lines.join("\n")}\n${footer}`;
}

export default function handler(req, res) {
  const rawKey = process.env.KALSHI_PRIVATE_KEY || "";
  const keyId = process.env.NEXT_PUBLIC_KALSHI_API_KEY_ID || "";
  const env = process.env.NEXT_PUBLIC_KALSHI_ENV || "";

  const fixed = rawKey ? fixPem(rawKey) : "";
  const fixedLines = fixed.split("\n");

  const info = {
    keyIdPresent: !!keyId,
    keyIdFirst8: keyId ? keyId.substring(0, 8) + "..." : "missing",
    envValue: env,
    raw: {
      length: rawKey.length,
      first40: rawKey.substring(0, 40),
      last40: rawKey.substring(rawKey.length - 40),
      lineCount: rawKey.split("\n").length,
    },
    fixed: {
      length: fixed.length,
      lineCount: fixedLines.length,
      first80: fixed.substring(0, 80),
      last80: fixed.substring(fixed.length - 80),
      line1: fixedLines[0],
      line2start: fixedLines[1] ? fixedLines[1].substring(0, 20) + "..." : "missing",
      lastLine: fixedLines[fixedLines.length - 1],
    },
    // Try to actually parse it
    parseTest: "not run",
  };

  try {
    const crypto = require("crypto");
    const sign = crypto.createSign("RSA-SHA256");
    sign.update("test");
    sign.end();
    sign.sign({
      key: fixed,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    });
    info.parseTest = "SUCCESS — key parses and signs correctly";
  } catch (err) {
    info.parseTest = `FAILED: ${err.message}`;
  }

  res.status(200).json(info);
}
