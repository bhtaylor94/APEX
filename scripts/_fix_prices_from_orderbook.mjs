import fs from "fs";

const file = process.env.FILE || "scripts/run-bot.mjs";
let s = fs.readFileSync(file, "utf8");

/**
 * 1) Ensure getOrderbook is imported from ./kalshi.js
 *    We only touch the import line that references "./kalshi.js".
 */
s = s.replace(
  /import\s*\{\s*([^}]+)\s*\}\s*from\s*["']\.\/kalshi\.js["'];/m,
  (m, inner) => {
    const parts = inner.split(",").map(x => x.trim()).filter(Boolean);
    if (!parts.includes("getOrderbook")) parts.push("getOrderbook");
    // de-dupe
    const dedup = [...new Set(parts)];
    return `import { ${dedup.join(", ")} } from "./kalshi.js";`;
  }
);

/**
 * 2) Inject pricing fallback right after Selected market log.
 *    Anchor: the line that starts with console.log("Selected market:"
 */
const anchorRe = /console\.log\(\s*["']Selected market:["']\s*,/m;
const anchorIdx = s.search(anchorRe);
if (anchorIdx === -1) {
  console.error("PATCH FAILED: Could not find 'Selected market' log.");
  process.exit(1);
}

// Find end of that console.log(...) statement (the next ');' after anchor)
const afterAnchor = s.indexOf(");", anchorIdx);
if (afterAnchor === -1) {
  console.error("PATCH FAILED: Could not locate end of Selected market console.log.");
  process.exit(1);
}

const injectAt = afterAnchor + 2;

// Prevent double-inject
if (s.includes("ORDERBOOK_PRICE_FALLBACK_V1")) {
  console.log("Already patched (ORDERBOOK_PRICE_FALLBACK_V1 present).");
  process.exit(0);
}

const block = `

  // === ORDERBOOK_PRICE_FALLBACK_V1 ===
  // Kalshi listMarkets can return null asks/bids. Derive executable prices from orderbook for selected.ticker.
  try {
    const missingPx =
      (selected?.yesAsk == null) ||
      (selected?.noAsk == null)  ||
      (selected?.bestYesBid == null) ||
      (selected?.bestNoBid == null);

    if (missingPx && selected?.ticker) {
      const _ob = await getOrderbook(selected.ticker, 1);

      // Orderbook shape we expect: { yes: [{ price }...], no: [{ price }...] }
      const _yesAsk = _ob?.yes?.[0]?.price ?? null;
      const _noAsk  = _ob?.no?.[0]?.price  ?? null;

      // Best bid is top-of-book *bid*; if your API returns bids separately, adapt here.
      // Many Kalshi orderbooks return bids in the same arrays but on the opposite side.
      // We'll safely read best bids if present.
      const _bestYesBid = _ob?.yes_bid?.[0]?.price ?? _ob?.best_yes_bid ?? null;
      const _bestNoBid  = _ob?.no_bid?.[0]?.price  ?? _ob?.best_no_bid  ?? null;

      // Only fill missing fields; do not overwrite if snapshot had values
      if (selected.yesAsk == null) selected.yesAsk = _yesAsk;
      if (selected.noAsk  == null) selected.noAsk  = _noAsk;

      if (selected.bestYesBid == null) selected.bestYesBid = _bestYesBid;
      if (selected.bestNoBid  == null) selected.bestNoBid  = _bestNoBid;

      console.log("Orderbook pricing filled:", {
        yesAsk: selected.yesAsk,
        noAsk: selected.noAsk,
        bestYesBid: selected.bestYesBid,
        bestNoBid: selected.bestNoBid
      });
    }
  } catch (e) {
    console.log("Orderbook pricing fetch failed (continuing):", e?.message ?? e);
  }
  // === END ORDERBOOK_PRICE_FALLBACK_V1 ===
`;

s = s.slice(0, injectAt) + block + s.slice(injectAt);

/**
 * 3) Make sure "selected" is mutable (const -> let) ONLY where it is declared.
 *    We only change the first occurrence of: const selected = ...
 */
s = s.replace(/const\s+selected\s*=\s*/m, "let selected = ");

fs.writeFileSync(file, s, "utf8");
console.log("✅ Patched run-bot.mjs: fill yes/no asks from orderbook after selection.");
