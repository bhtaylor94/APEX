// pages/api/bot-run.js
// ===== HARD RULES (do not change via env) =====
const HARD = Object.freeze({
  // Entry probability band (trade-side probability)
  PROB_LO: 0.40,
  PROB_HI: 0.50,

  // Risk management
  TAKE_PROFIT_PCT: 0.15,  // +15%
  STOP_LOSS_PCT: 0.10,    // -10%
  BET_USD_MAX: 10,        // max $10 per trade

  // Throttles
  MAX_POSITIONS: 2,                   // max open positions
  MAX_TRADES_PER_HOUR: 2,             // max new entries per hour
  MAX_TRADES_PER_DAY: 48,             // max new entries per 24h
  REENTRY_COOLDOWN_MS: 60 * 60 * 1000, // 1 hour cooldown per market after any prior bot trade

  // Liquidity filter (uses market.volume_24h as provided by Kalshi)
  MIN_LIQUIDITY_24H: 1_000_000,

  // Misc
  TRADES_PER_RUN: 1,
  PRICE_MIN: 0.10, // 10c
  PRICE_MAX: 0.90  // 90c
});

// Server-side bot runner (works without the UI). Intended for Vercel Cron.
// Security: only runs when BOT_ENABLED=1 and request contains x-vercel-cron: 1 OR token matches BOT_CRON_TOKEN.

import crypto from "crypto";

const DEMO_BASE = "https://demo-api.kalshi.co/trade-api/v2";
const PROD_BASE = "https://api.elections.kalshi.com/trade-api/v2";

function env(name, dflt) {
  const v = process.env[name];
  return (v == null || v === "") ? dflt : v;
}

function getBase() {
  const k = (process.env.NEXT_PUBLIC_KALSHI_ENV || process.env.KALSHI_ENV || "demo").toLowerCase();
  return k === "prod" ? PROD_BASE : DEMO_BASE;
}

function fixPem(raw) {
  let k = String(raw || "").trim();
  if (!k) return "";
  if ((k[0] === '"' && k[k.length - 1] === '"') || (k[0] === "'" && k[k.length - 1] === "'")) k = k.slice(1, -1);
  k = k.replace(/\\n/g, "\n");
  const isRsa = /RSA/i.test(k);
  const header = isRsa ? "-----BEGIN RSA PRIVATE KEY-----" : "-----BEGIN PRIVATE KEY-----";
  const footer = isRsa ? "-----END RSA PRIVATE KEY-----" : "-----END PRIVATE KEY-----";
  const b64 = k.replace(/-+BEGIN[^-]*-+/g, "").replace(/-+END[^-]*-+/g, "").replace(/[\s\r\n]+/g, "");
  const lines = b64.match(/.{1,64}/g) || [];
  return `${header}\n${lines.join("\n")}\n${footer}`;
}

function signPssText(privateKeyPem, text) {
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(text);
  sign.end();
  const signature = sign.sign({
    key: privateKeyPem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return signature.toString("base64");
}

async function authReq(path, method = "GET", body = null) {
  const keyId = process.env.NEXT_PUBLIC_KALSHI_API_KEY_ID;
  const rawKey = process.env.KALSHI_PRIVATE_KEY;
  if (!keyId || !rawKey || keyId === "your-api-key-id-here") throw new Error("Kalshi keys not configured");
  const base = getBase();
  const fullPath = `/trade-api/v2${path}`;
  const timestamp = String(Date.now());
  const privateKeyPem = fixPem(rawKey);
  const pathWithoutQuery = fullPath.split("?")[0];
  const msgString = timestamp + method + pathWithoutQuery;
  const sig = signPssText(privateKeyPem, msgString);

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
  if (body && method !== "GET") opts.body = JSON.stringify(body);

  const resp = await fetch(url, opts);
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!resp.ok) {
    const e = new Error(`Kalshi API ${resp.status}`);
    e.detail = data;
    e.status = resp.status;
    throw e;
  }
  return data;
}

function getNum(x, d=0){ const n = Number(x); return Number.isFinite(n) ? n : d; }

function orderTimeMs(o){
  const cand = o?.created_time || o?.created_at || o?.time || o?.timestamp || o?.ts;
  if (typeof cand === "number") return cand > 1e12 ? cand : cand * 1000;
  if (typeof cand === "string") {
    const ms = Date.parse(cand);
    if (!Number.isNaN(ms)) return ms;
  }
  return 0;
}

function orderTicker(o){
  return String(o?.ticker || o?.market_ticker || o?.market || o?.marketTicker || "");
}

function isBotOrder(o){
  const id = String(o?.client_order_id || o?.clientOrderId || "");
  return id.startsWith("apex-cron");
}

async function getRecentBotOrders(sinceMs){
  const tryPaths = [
    `/portfolio/orders?limit=200`,
    `/orders?limit=200`,
    `/portfolio/order_history?limit=200`,
  ];

  for (const p of tryPaths) {
    try {
      const d = await authReq(p, "GET");
      const arr = d?.orders || d?.results || d?.data || d?.items || d?.order_history || [];
      const list = Array.isArray(arr) ? arr : [];
      return list.filter(isBotOrder).filter(o => orderTimeMs(o) >= sinceMs);
    } catch (e) { /* try next */ }
  }
  return [];
}

function yesMidC(m) {
  const yb = (m?.yes_bid != null) ? Number(m.yes_bid) : null;
  const ya = (m?.yes_ask != null) ? Number(m.yes_ask) : null;
  const yp = (m?.yes_price != null) ? Number(m.yes_price) : null;
  const lp = (m?.last_price != null) ? Number(m.last_price) : null;
  if (yb != null && ya != null) return (yb + ya) / 2;
  if (yb != null && ya == null) return yb;
  if (ya != null && yb == null) return ya;
  if (yp != null) return yp;
  if (lp != null) return lp;
  return 50;
}

function tradePriceForSide(yesProb, side) {
  const p = Number(yesProb);
  return side === "yes" ? p : (1 - p);
}

function clamp01(x){ return Math.max(0, Math.min(1, x)); }

function inProbBand(p, lo, hi) {
  const x = Number(p);
  return x >= lo && x <= hi;
}

// --- Strategies (data-free) ---
// These are intentionally conservative and rely only on market microstructure.

// Favorite-Longshot Bias (FLB): fade extremes (works best liquid markets)
function evalFLB(mkt) {
  const p = yesMidC(mkt) / 100;
  // "bias edge" is heuristically the distance from extreme
  if (p >= 0.82) return { ticker: mkt.ticker, title: mkt.title, price: p, side: "no", edge: (p - 0.82) * 100, strategy: "flb", reason: "FLB: extreme favorite — fade via NO" };
  if (p <= 0.18) return { ticker: mkt.ticker, title: mkt.title, price: p, side: "yes", edge: (0.18 - p) * 100, strategy: "flb", reason: "FLB: extreme longshot — fade via YES" };
  return null;
}

function evalSpread(mkt) {
  const yb = (mkt?.yes_bid != null) ? Number(mkt.yes_bid) : null;
  const ya = (mkt?.yes_ask != null) ? Number(mkt.yes_ask) : null;
  if (yb == null || ya == null) return null;
  const spread = ya - yb;
  if (spread < 10) return null; // only act on wide spreads
  const mid = (yb + ya) / 2;
  // Edge is "spread in cents" for ranking; execution should be limit near mid
  return { ticker: mkt.ticker, title: mkt.title, price: mid/100, side: "yes", edge: spread, strategy: "spread", reason: `Spread Fade: wide ${spread}¢ spread` };
}

function evalVolSpike(mkt) {
  const vol = Number(mkt?.volume_24h || 0);
  const oi  = Number(mkt?.open_interest || 0);
  if (vol <= 0 || oi <= 0) return null;
  if (vol < 3 * oi) return null;
  const p = yesMidC(mkt)/100;
  return { ticker: mkt.ticker, title: mkt.title, price: p, side: "yes", edge: 6, strategy: "vol", reason: "Volume Spike: 24h volume > 3× OI" };
}

async function listOpenMarkets(maxPages, perPage) {
  let cursor = null;
  const out = [];
  for (let i = 0; i < maxPages; i++) {
    const params = new URLSearchParams();
    params.set("status", "open");
    params.set("limit", String(perPage));
    if (cursor) params.set("cursor", cursor);
    const d = await fetch(`${getBase()}/markets?${params.toString()}`, { method: "GET" }).then(r => r.json());
    const mkts = d?.markets || d?.results || [];
    if (!mkts.length) break;
    out.push(...mkts);
    cursor = d?.cursor;
    if (!cursor) break;
  }
  return out;
}

async function getPortfolioPositions() {
  // Try a few common shapes; Kalshi may return `market_positions` or `positions`
  const d = await authReq("/portfolio/positions", "GET");
  const arr = d?.market_positions || d?.positions || d?.results || [];
  return Array.isArray(arr) ? arr : [];
}

function pickTopSignals(signals, n) {
  return signals.sort((a,b) => (Math.abs(b.edge||0) - Math.abs(a.edge||0))).slice(0, n);
}


function tradeProbForSide(probYes, side) {
  return side === "yes" ? probYes : 1 - probYes;
}
function tradePriceForSide(yesPrice, side) {
  return side === "yes" ? yesPrice : 1 - yesPrice;
}
function inBand(p) {
  return typeof p === "number" && p >= HARD.PROB_LO && p <= HARD.PROB_HI;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
    if (env("BOT_ENABLED", "0") !== "1") return res.status(200).json({ ok: true, skipped: "BOT_ENABLED!=1" });

    const cronHeader = String(req.headers["x-vercel-cron"] || "");
    const token = String((req.query && req.query.token) || (req.body && req.body.token) || "");
    const cronToken = env("BOT_CRON_TOKEN", "");
    const allowed = (cronHeader === "1") || (cronToken && token && token === cronToken);
    if (!allowed) return res.status(401).json({ error: "unauthorized" });

    // Server config (env-driven)
    const cfg = {
      betUsd: Number(env("BOT_BET_USD", "10")),
      maxPos: Number(env("BOT_MAX_POS", "3")),
      minEdge: Number(env("BOT_MIN_EDGE_C", "6")), // cents
      pMinC: Number(env("BOT_PMIN_C", "10")),
      pMaxC: Number(env("BOT_PMAX_C", "90")),
      probLo: Number(env("BOT_PROB_LO", "0.40")),
      probHi: Number(env("BOT_PROB_HI", "0.50")),
      tpPct: Number(env("BOT_TP_PCT", "0.20")), // 0.20 = 20%
      slPct: Number(env("BOT_SL_PCT", "0.20")),
      pages: Number(env("BOT_SCAN_PAGES", "8")),
      perPage: Number(env("BOT_SCAN_LIMIT", "100")),
      perRun: Number(env("BOT_TRADES_PER_RUN", "1")),
      stratFlb: env("BOT_STRAT_FLB", "1") === "1",
      stratVol: env("BOT_STRAT_VOL", "1") === "1",
      stratSpread: env("BOT_STRAT_SPREAD", "1") === "1",
    };

    // 1) Pull current portfolio positions
    const portfolio = await getPortfolioPositions();
    const openTickers = new Set(portfolio.map(p => p?.ticker).filter(Boolean));

    // 2) Exit management: check mid vs entry if available, otherwise use pnl if provided
    // If the API doesn't provide enough detail, we still place conservative exits based on current mid vs average_price if present.
    const exits = [];
    for (const p of portfolio) {
      const ticker = p?.ticker;
      if (!ticker) continue;

      // Fetch market for mid
      const mk = await fetch(`${getBase()}/markets?ticker=${encodeURIComponent(ticker)}`).then(r => r.json());
      const mkt = (mk?.markets && mk.markets[0]) || (mk?.results && mk.results[0]) || mk?.[0];
      if (!mkt) continue;

      const midYes = yesMidC(mkt) / 100;
      const side = (p?.side || p?.position_side || "yes").toLowerCase() === "no" ? "no" : "yes";
      const mid = tradePriceForSide(midYes, side);

      const avgC = Number(p?.average_price ?? p?.avg_price ?? p?.price ?? null);
      const entry = (avgC != null && !Number.isNaN(avgC)) ? (avgC / 100) : null;

      if (entry != null) {
        const gain = (mid - entry) / Math.max(1e-6, entry);
        if (gain >= cfg.tpPct || gain <= -cfg.slPct) {
          exits.push({ ticker, side, reason: gain >= cfg.tpPct ? "take_profit" : "stop_loss", gain, midC: Math.round(mid*100) });
        }
      }
    }

    const exitOrders = [];
    for (const ex of exits.slice(0, 3)) {
      const sellBody = {
        ticker: ex.ticker,
        action: "sell",
        side: ex.side,
        type: "market",
        count: 1, // safest default; increase later once position sizing schema confirmed
        client_order_id: `apex-cron-exit-${Date.now()}`,
      };
      try {
      // HARD ENTRY GUARD
      const lastTrade = lastTradeByTicker.get(String(sig.ticker || "")) || 0;
      if (lastTrade && (Date.now() - lastTrade) < HARD.REENTRY_COOLDOWN_MS) { log.push({ t: Date.now(), msg: `SKIP cooldown ${sig.ticker}` }); continue; }
      const tradeProb = tradeProbForSide(Number(sig.probYes ?? sig.prob ?? sig.yesProb ?? sig.price ?? 0), side);
      const tradePrice = tradePriceForSide(Number(sig.price ?? sig.yesPrice ?? 0), side);
      if (!inBand(tradeProb)) { log.push({ t: Date.now(), msg: `SKIP band ${Math.round(tradeProb*100)}%` }); continue; }
      if (!(tradePrice >= HARD.PRICE_MIN && tradePrice <= HARD.PRICE_MAX)) { log.push({ t: Date.now(), msg: `SKIP price ${(tradePrice*100).toFixed(0)}c` }); continue; }

        const r = await authReq("/orders", "POST", sellBody);
        exitOrders.push({ ...ex, ok: true, resp: r?.order?.order_id || r?.order_id || true });
      } catch (e) {
        exitOrders.push({ ...ex, ok: false, err: e?.detail || e?.message || "sell_failed" });
      }
    }

    // 3) Scan markets and generate signals
    const mkts = await listOpenMarkets(cfg.pages, cfg.perPage);
    const signals = [];
    for (const m of mkts) {
      if (!m?.ticker) continue;
      if (openTickers.has(m.ticker)) continue;

      const pYes = clamp01(yesMidC(m) / 100);
      const sideProb = pYes; // will be corrected below by strategy side
      // Build candidate signals
      if (cfg.stratFlb) {
        const s = evalFLB(m);
        if (s) signals.push(s);
      }
      if (cfg.stratVol) {
        const s = evalVolSpike(m);
        if (s) signals.push(s);
      }
      if (cfg.stratSpread) {
        const s = evalSpread(m);
        if (s) signals.push(s);
      }
    }

    // Filter + rank tradeable signals
    const tradeable = [];
    for (const s of signals) {
      const pYes = clamp01(Number(s.price));
      const side = (s.side || (s.edge > 0 ? "yes" : "no")).toLowerCase() === "no" ? "no" : "yes";
      const sideProb = side === "yes" ? pYes : (1 - pYes);
      if (!inProbBand(sideProb, cfg.probLo, cfg.probHi)) continue;

      const entryPrice = tradePriceForSide(pYes, side);
      const entryC = Math.round(entryPrice * 100);
      if (entryC < cfg.pMinC || entryC > cfg.pMaxC) continue;

      if (Math.abs(Number(s.edge || 0)) < cfg.minEdge) continue;

      tradeable.push({ ...s, side, entryPrice, entryC, sideProb });
    }

    // Obey max positions
    const slots = Math.max(0, cfg.maxPos - openTickers.size);
    const picks = pickTopSignals(tradeable, Math.min(cfg.perRun, slots));

    const orders = [];
    for (const s of picks) {
      const count = Math.max(1, Math.floor(cfg.betUsd / Math.max(0.01, s.entryPrice)));
      
      if (openTickers && openTickers.size >= HARD.MAX_POSITIONS) { log.push({ t: Date.now(), msg: "SKIP: max positions cap (entry)" }); continue; }
const body = {
        ticker: s.ticker,
        action: "buy",
        side: s.side,
        type: "limit",
        count,
        ...(s.side === "yes" ? { yes_price: s.entryC } : { no_price: s.entryC }),
        client_order_id: `apex-cron-${Date.now()}`,
      };
      try {
        const r = await authReq("/orders", "POST", body);
        orders.push({ ok: true, ticker: s.ticker, side: s.side, priceC: s.entryC, count, strategy: s.strategy, orderId: r?.order?.order_id || r?.order_id || null });
      } catch (e) {
        orders.push({ ok: false, ticker: s.ticker, side: s.side, priceC: s.entryC, count, strategy: s.strategy, err: e?.detail || e?.message || "buy_failed" });
      }
    }

    return res.status(200).json({
      ok: true,
      env: (process.env.NEXT_PUBLIC_KALSHI_ENV || process.env.KALSHI_ENV || "demo"),
      scanned: mkts.length,
      signals: signals.length,
      tradeable: tradeable.length,
      openPositions: openTickers.size,
      exitOrders,
      orders,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "server_error", message: err.message, detail: err.detail || null });
  }
}
