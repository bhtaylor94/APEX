import { kvGetJson, kvSetJson } from "./kv.mjs";

async function getExecutablePricesFromOrderbook(ticker) {
  const ob = await getOrderbook(ticker, 1);

  // If your file already has a helper, prefer it.
  if (typeof deriveYesNoFromOrderbook === "function") {
    const out = deriveYesNoFromOrderbook(ob);
    return {
      yesAsk: out?.yesAsk ?? null,
      noAsk: out?.noAsk ?? null,
      bestYesBid: out?.bestYesBid ?? null,
      bestNoBid: out?.bestNoBid ?? null
    };
  }

  // Raw fallback: interpret top of book if present
  const yesAsk = ob?.yes?.[0]?.price ?? null;
  const noAsk  = ob?.no?.[0]?.price ?? null;

  // Some Kalshi shapes separate bids/asks; if you only have one side array,
  // we at least return the same top level as "best bid" when bids are not provided.
  const bestYesBid = ob?.yes_bid?.[0]?.price ?? ob?.yes?.[0]?.price ?? null;
  const bestNoBid  = ob?.no_bid?.[0]?.price  ?? ob?.no?.[0]?.price  ?? null;

  return { yesAsk, noAsk, bestYesBid, bestNoBid };
}
import { getBTCSignal } from "./signal.mjs";
import { listMarkets, getOrderbook, deriveYesNoFromOrderbook, createOrder } from "./kalshi.mjs";

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
  let { yesAsk, noAsk, bestYesBid, bestNoBid } = deriveYesNoFromOrderbook(ob);

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
  // ---- Always derive executable prices from orderbook (series response often has null asks/bids) ----
  const px = await getExecutablePricesFromOrderbook(selected.ticker);
  yesAsk = (selected.yesAsk ?? px.yesAsk ?? null);
  noAsk = (selected.noAsk ?? px.noAsk ?? null);
  bestYesBid = (selected.bestYesBid ?? px.bestYesBid ?? null);
  bestNoBid = (selected.bestNoBid ?? px.bestNoBid ?? null);

  // Use side to pick the executable ask for entry
  const askCents = (side === "yes") ? yesAsk : noAsk;

  console.log("Orderbook pricing:", { yesAsk, noAsk, bestYesBid, bestNoBid, askCents });


  if (ask == null || ask <= 0 || ask >= 99) {
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
