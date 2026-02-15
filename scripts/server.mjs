import http from "http";
import { runBotCycle } from "./run-bot-clean.mjs";
import { kvGetJson } from "./kv.js";

const PORT = Number(process.env.PORT || 3001);

// Prevent concurrent bot runs
let running = false;

async function handleRun() {
  if (running) {
    return { status: 429, body: { ok: false, error: "Bot cycle already running" } };
  }
  running = true;
  const start = Date.now();
  try {
    const result = await runBotCycle();
    const elapsed = Date.now() - start;
    return {
      status: 200,
      body: { ok: true, action: result?.action, elapsed_ms: elapsed, log: result?.log || [] },
    };
  } catch (e) {
    return { status: 500, body: { ok: false, error: e?.message || String(e) } };
  } finally {
    running = false;
  }
}

async function handleHealth() {
  try {
    const [stats, config, position] = await Promise.all([
      kvGetJson("bot:daily_stats"),
      kvGetJson("bot:config"),
      kvGetJson("bot:position"),
    ]);
    return {
      status: 200,
      body: {
        status: "ok",
        timestamp: new Date().toISOString(),
        enabled: !!config?.enabled,
        mode: config?.mode || "paper",
        hasPosition: !!(position?.ticker),
        position: position?.ticker ? {
          ticker: position.ticker,
          side: position.side,
          entry: position.entryPriceCents,
          count: position.count,
        } : null,
        dailyStats: stats || null,
      },
    };
  } catch (e) {
    return { status: 500, body: { status: "error", error: e?.message || String(e) } };
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  let result;
  if (path === "/run" && (req.method === "GET" || req.method === "POST")) {
    result = await handleRun();
  } else if (path === "/health" && req.method === "GET") {
    result = await handleHealth();
  } else {
    result = { status: 404, body: { error: "Not found. Use GET /run or GET /health" } };
  }

  res.writeHead(result.status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result.body));
});

server.listen(PORT, () => {
  console.log("APEX bot server running on port " + PORT);
  console.log("  GET /run    — trigger bot cycle");
  console.log("  GET /health — status + daily stats");
});
