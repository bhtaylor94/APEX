import { kvGetJson, kvSetJson } from "./kv.mjs";
import { getBTCSignal } from "./signal.mjs";
import { listMarkets, getOrderbook, deriveYesNoFromOrderbook, createOrder } from "./kalshi.mjs";
/**
 * Kalshi markets list often does NOT include executable ask/bid prices.
 * Orderbook is the source of truth for YES/NO asks/bids.
 * Returns cents (integers) or null when unavailable.
 */
async function getExecutablePricesFromOrderbook(ticker) {
  try {
    const ob = await getOrderbook(ticker, 1);

    // Support a few common shapes defensively:
    // - { yes: [{price}], no: [{price}] }
    // - { yes_asks: [{price}], no_asks: [{price}] }
    // - { yes_bids: [{price}], no_bids: [{price}] }
    const yesAsk =
      ob?.yes?.[0]?.price ??
      ob?.yes_asks?.[0]?.price ??
      ob?.yesAsk ??
      null;

    const noAsk =
      ob?.no?.[0]?.price ??
      ob?.no_asks?.[0]?.price ??
      ob?.noAsk ??
      null;

    const bestYesBid =
      ob?.yes_bids?.[0]?.price ??
      ob?.yesBid ??
      ob?.bestYesBid ??
      null;

    const bestNoBid =
      ob?.no_bids?.[0]?.price ??
      ob?.noBid ??
      ob?.bestNoBid ??
      null;

    // Force integer cents when possible
    const toInt = (v) => (typeof v === "number" && Number.isFinite(v)) ? Math.trunc(v) : null;

    return {
      yesAsk: toInt(yesAsk),
      noAsk: toInt(noAsk),
      bestYesBid: toInt(bestYesBid),
      bestNoBid: toInt(bestNoBid),
    };
  } catch (e) {
    console.log("Orderbook pricing unavailable:", String(e?.message || e));
    return { yesAsk: null, noAsk: null, bestYesBid: null, bestNoBid: null };
  }
}


function centsToUsd(c) { return (c/100); }

function nowTs() { return Date.now(); }

function defaultConfig() {
  return {
    enabled: true,
    mode: "paper",             // "paper" or "live"
    seriesTicker: "KXBTC15M",
    tradeSizeUsd: 5,
    maxContracts: 5,
    minConfidence: 0.15,
    minEdge: 5,
    maxEntryPriceCents: 85,
    takeProfitPct: 0.20,
    stopLossPct: 0.12,
    cooldownMinutes: 8,
    maxTradesPerDay: 10,
    dailyMaxLossUsd: 25,
    maxOpenPositions: 1
  };
}

function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }

async function loadConfig() {
  const cfg = await kvGetJson("bot:config");
  return { ...defaultConfig(), ...(cfg || {}) };
}

async function loadPosition() {
  return await kvGetJson("bot:position");
}

async function savePosition(pos) {
  return await kvSetJson("bot:position", pos);
}

async function clearPosition() {
  return await kvSetJson("bot:position", null);
}

function computePnL(pos, bestBidCents) {
  // Rough mark-to-bid PnL ignoring fees:
  // If long YES: profit per contract = bestBid - entry
  // If long NO:  profit per contract = bestBid - entry
  const per = (bestBidCents - pos.entryPriceCents);
  const usd = centsToUsd(per * pos.count);
  return usd;
}

async function tryExit(cfg, pos) {
  if (!pos) return { exited:false };

  // Fetch orderbook for the position ticker
  const ob = await getOrderbook(pos.ticker);
  const { bestYesBid, bestNoBid } = deriveYesNoFromOrderbook(ob);

  const bestBid = (pos.side === "yes") ? bestYesBid : bestNoBid;
  if (bestBid == null) {
    console.log("HOLD — no bid to exit on yet.");
    return { exited:false };
  }

  const pnlUsd = computePnL(pos, bestBid);
  const entryUsd = centsToUsd(pos.entryPriceCents * pos.count);
  const takeUsd = entryUsd * cfg.takeProfitPct;
  const stopUsd = -entryUsd * cfg.stopLossPct;

  console.log(`POSITION: ${pos.side.toUpperCase()} ${pos.count}x ${pos.ticker} entry=${pos.entryPriceCents}¢ bestBid=${bestBid}¢ pnl≈$${pnlUsd.toFixed(2)} TP=$${takeUsd.toFixed(2)} SL=$${stopUsd.toFixed(2)}`);

  if (pnlUsd >= takeUsd || pnlUsd <= stopUsd) {
    const reason = pnlUsd >= takeUsd ? "TAKE_PROFIT" : "STOP_LOSS";
    console.log(`EXIT (${reason}): SELL ${pos.side.toUpperCase()} ${pos.count}x ${pos.ticker} @ ${bestBid}¢`);

    if (cfg.mode === "live") {
      const out = await createOrder({
        ticker: pos.ticker,
        action: "sell",
        side: pos.side,
        count: pos.count,
        priceCents: bestBid,
        tif: "fill_or_kill",
        postOnly: false
      });
      console.log("EXIT ORDER RESULT:", JSON.stringify(out, null, 2));
    } else {
      console.log("PAPER: exit order skipped (paper mode).");
    }

    await clearPosition();
    await kvSetJson("bot:last_action", { ts: nowTs(), type:"exit", reason, pnlUsd });
    return { exited:true };
  }

  return { exited:false };
}

function pickBestMarketCandidate(markets) {
  // Filter active BTC15M tickers only
  const btc = markets.filter(m => (m.ticker || "").startsWith("KXBTC15M-") && (m.status === "active" || m.status === "open" || m.status === "trading" || m.status === "live"));
  // Prefer high volume
  btc.sort((a,b)=>(b.volume||0)-(a.volume||0));
  return btc[0] || null;
}

async function main() {
  const cfg = await loadConfig();
  console.log("CONFIG:", cfg);

  if (!cfg.enabled) {
    console.log("Bot disabled. Set bot:config.enabled=true to run.");
    return;
  }

  // 1) Exit logic first (sell-to-close)
  const pos = await loadPosition();
  if (pos) {
    const ex = await tryExit(cfg, pos);
    if (ex.exited) return; // do not re-enter same minute
  }

  // 2) Enforce max open positions
  const pos2 = await loadPosition();
  if (pos2) {
    console.log("MaxOpenPositions: position exists, skipping entry.");
    return;
  }

  // 3) Signal
  const sig = await getBTCSignal();
  console.log("SIGNAL:", sig);

  if (sig.direction === "neutral") {
    const allowNeutral = cfg.allowNeutralTrades === true;
    if (!allowNeutral) {
      console.log("No trade — neutral signal.");
      return;
    }

    // Neutral policy: choose direction using momentum (RSI as tie-breaker)
    const mom = Number(sig.mom ?? 0);
    const rsi = Number(sig.rsi ?? 50);
    const momDeadband = Number(cfg.neutralMomDeadband ?? 0.00010);

    let neutralDir = "neutral";
    if (mom > momDeadband) neutralDir = "up";
    else if (mom < -momDeadband) neutralDir = "down";
    else neutralDir = (rsi >= 50 ? "up" : "down");

    console.log("Neutral override: mom=" + mom + " rsi=" + rsi + " => direction=" + neutralDir.toUpperCase());
    sig.direction = neutralDir;
  }
  if (sig.confidence < cfg.minConfidence) {
    console.log(`No trade — confidence ${sig.confidence} < minConfidence ${cfg.minConfidence}`);
    return;
  }

  // 4) Markets
  const mkResp = await listMarkets({ seriesTicker: cfg.seriesTicker, status: "open", limit: 200 });
  const markets = Array.isArray(mkResp?.markets) ? mkResp.markets : [];
  console.log(`Markets source: series(${cfg.seriesTicker}) — found: ${markets.length}`);

  const m = pickBestMarketCandidate(markets);
  if (!m) {
    console.log("No tradable markets found for series:", cfg.seriesTicker);
    return;
  }

  // 5) Derive tradable ask from orderbook (reliable)
  const ob = await getOrderbook(m.ticker);
  const { yesAsk, noAsk, bestYesBid, bestNoBid } = deriveYesNoFromOrderbook(ob);

  const predYes = 50 + Math.round(sig.confidence * 35); // 50..85ish
  const predNo  = 100 - predYes;

  // Choose the best edge between YES and NO
  const edgeYes = (yesAsk != null) ? (predYes - yesAsk) : -999;
  const edgeNo  = (noAsk  != null) ? (predNo  - noAsk)  : -999;

  let side = null;
  let ask = null;
  let edge = null;

  if (edgeYes >= edgeNo) { side="yes"; ask=yesAsk; edge=edgeYes; }
  else { side="no"; ask=noAsk; edge=edgeNo; }

  console.log("Selected market:", {
    ticker: m.ticker,
    status: m.status,
    volume: m.volume || 0,
    yesAsk, noAsk,
    bestYesBid, bestNoBid
  });
  // --- Orderbook pricing (SOURCE OF TRUTH) ---
  const px = await getExecutablePricesFromOrderbook(selected.ticker);

  // Use orderbook-derived executable prices (ignore listMarkets pricing fields)
// askCents used for entry pricing
console.log("Orderbook pricing:", { yesAsk, noAsk, bestYesBid, bestNoBid, askCents });


  if (askCents == null || askCents <= 0 || askCents >= 99) {
    console.log("No trade — missing/invalid ask:", ask);
    return;
  }
  if (ask > cfg.maxEntryPriceCents) {
    console.log(`No trade — ask ${ask}¢ > maxEntryPriceCents ${cfg.maxEntryPriceCents}¢`);
    return;
  }
  console.log(`Edge check: predYES=${predYes}¢ predNO=${predNo}¢ yesAsk=${yesAsk}¢ noAsk=${noAsk}¢ edgeYES=${edgeYes}¢ edgeNO=${edgeNo}¢ chosen=${side.toUpperCase()} edge=${edge}¢ minEdge=${cfg.minEdge}¢`);

  if (edge < cfg.minEdge) {
    console.log("No trade — edge too small.");
    return;
  }

  const count = clamp(cfg.maxContracts, 1, cfg.maxContracts);

  console.log(`Decision: BUY ${side.toUpperCase()} ${count}x ${m.ticker} @ ${ask}¢ (mode=${cfg.mode})`);

  if (cfg.mode === "live") {
    const out = await createOrder({
      ticker: m.ticker,
      action: "buy",
      side,
      count,
      priceCents: ask,
      tif: "fill_or_kill",
      postOnly: false
    });
    console.log("ORDER RESULT:", JSON.stringify(out, null, 2));
  } else {
    console.log("PAPER: buy skipped (paper mode).");
  }

  // Save position so we can sell-to-close next minute
  await savePosition({
    ticker: m.ticker,
    side,
    count,
    entryPriceCents: ask,
    openedTs: nowTs()
  });
  await kvSetJson("bot:last_action", { ts: nowTs(), type:"entry", ticker:m.ticker, side, count, ask });
  console.log("Saved bot:position");
}

main().catch(e => {
  console.error("Bot runner failed:", e?.message || e);
  process.exit(1);
});
