/**
 * CommonJS wrapper so GitHub Actions can run `node scripts/run-bot.js`
 * even when the actual runner is ESM.
 */
(async () => {
  try {
    await import("./run-bot.mjs");
  } catch (err) {
    console.error("Runner failed:", err && (err.stack || err));
    process.exit(1);
  }
})();
