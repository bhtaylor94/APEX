import fs from "fs";

const file = "scripts/kalshi.js";
let s = fs.readFileSync(file, "utf8");

// Ensure we have a single canonical base (docs host)
const baseLine = 'const KALSHI_BASE_URL = process.env.KALSHI_API_BASE_URL || "https://api.elections.kalshi.com/trade-api/v2";\n';

// Insert base constant near top if missing
if (!s.includes("KALSHI_BASE_URL")) {
  // put after imports
  s = s.replace(/(^\s*import .*?\n)+/m, (m) => m + "\n" + baseLine + "\n");
}

// Normalize any hardcoded base urls (defensive)
s = s.replace(/https:\/\/(trading-api|api)\.kalshi\.com(\/trade-api\/v2)?/g, "https://api.elections.kalshi.com/trade-api/v2");
s = s.replace(/https:\/\/api\.elections\.kalshi\.com\/trade-api\/v2\/trade-api\/v2/g, "https://api.elections.kalshi.com/trade-api/v2");

// Patch kalshiFetch-style URL building to: BASE + cleanPath
// This is robust even if your file is slightly different.
s = s.replace(
  /const\s+url\s*=\s*new\s+URL\([^;]+\);\s*/m,
  [
    'const cleanPath = (path || "").startsWith("/trade-api/v2") ? (path || "").replace("/trade-api/v2","") : (path || "");',
    'const url = new URL(KALSHI_BASE_URL + cleanPath);'
  ].join("\n") + "\n"
);

// If you build url via string concat, normalize that too
s = s.replace(
  /const\s+url\s*=\s*['"`]\$\{?baseUrl\}?\$\{?path\}?['"`];/g,
  'const cleanPath = (path || "").startsWith("/trade-api/v2") ? (path || "").replace("/trade-api/v2","") : (path || "");\nconst url = KALSHI_BASE_URL + cleanPath;'
);

// Add safe headers (does not affect signature in most schemes)
if (!s.includes('"User-Agent"') && !s.includes("'User-Agent'")) {
  s = s.replace(
    /headers\s*=\s*new\s+Headers\(\s*\{\s*/m,
    'headers = new Headers({\n    "User-Agent": "apex-bot/1.0",\n    "Accept": "application/json",\n'
  );
}

fs.writeFileSync(file, s, "utf8");
console.log("✅ Patched scripts/kalshi.js to use KALSHI_API_BASE_URL + normalized /trade-api/v2 paths");
