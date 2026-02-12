// pages/api/debug.js
// Temporary debug endpoint — shows key format info without exposing the actual key

export default function handler(req, res) {
  const rawKey = process.env.KALSHI_PRIVATE_KEY || "";
  const keyId = process.env.NEXT_PUBLIC_KALSHI_API_KEY_ID || "";
  const env = process.env.NEXT_PUBLIC_KALSHI_ENV || "";

  // Analyze the key without exposing it
  const info = {
    keyIdPresent: !!keyId,
    keyIdFirst8: keyId ? keyId.substring(0, 8) + "..." : "missing",
    envValue: env,
    keyLength: rawKey.length,
    hasBeginPrivateKey: rawKey.includes("-----BEGIN PRIVATE KEY-----"),
    hasBeginRsaPrivateKey: rawKey.includes("-----BEGIN RSA PRIVATE KEY-----"),
    hasAnyBegin: rawKey.includes("-----BEGIN"),
    hasRealNewlines: rawKey.includes("\n"),
    hasEscapedNewlines: rawKey.includes("\\n"),
    hasCarriageReturn: rawKey.includes("\r"),
    first40: rawKey.substring(0, 40),
    last40: rawKey.substring(rawKey.length - 40),
    lineCount: rawKey.split("\n").length,
    // Show what it looks like after our fix attempt
    afterFixFirst80: rawKey.replace(/\\n/g, "\n").trim().substring(0, 80),
  };

  res.status(200).json(info);
}
