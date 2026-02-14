import { kvGetJson, kvSetJson } from "./kv.mjs";
import { getBTCSignal } from "./signal.mjs";
import { listMarkets, getOrderbook, deriveYesNoFromOrderbook, createOrder } from "./kalshi.mjs";

// ---- ORDERBOOK PRICING (source of truth) ----
function derivePricesFromOrderbook(ob) {
  // Kalshi orderbook commonly returns arrays like:
  // { yes: [{price: 25, count: ...}], no: [{price: 75, ...}], ... }
  // Some variants use best_* fields; we handle both.
  const yesAsk = ob?.yes?.[0]?.price ?? ob?.yes_asks?.[0]?.price ?? ob?.yesAsk ?? null;
  const noAsk  = ob?.no?.[0]?.price  ?? ob?.no_asks?.[0]?.price  ?? ob?.noAsk  ?? null;

  const bestYesBid =
    ob?.yes_bids?.[0]?.price ?? ob?.yesBid ?? ob?.bestYesBid ?? null;

  const bestNoBid =
    ob?.no_bids?.[0]?.price ?? ob?.noBid ?? ob?.bestNoBid ?? null;

  return { yesAsk, noAsk, bestYesBid, bestNoBid };
}


// Guard: prevent ReferenceError if code references selected outside main()
let selected = null;


// Hoisted to avoid TDZ (Cannot access before initialization)


function resolveTicker() {
  return (
    ((typeof selectedMarket !== "undefined") && selectedMarket && selectedMarket.ticker) ||
    ((typeof selected !== "undefined") && selected && selected.ticker) ||
    ((typeof market !== "undefined") && market && market.ticker) ||
    ((typeof picked !== "undefined") && picked && picked.ticker) ||
    ((typeof candidate !== "undefined") && candidate && candidate.ticker) ||
    ((typeof best !== "undefined") && best && best.ticker) ||
    null
  );
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
  // Ensure we have a ticker for orderbook pricing
  if (!tickerForOB) tickerForOB = resolveTicker();
  // Robust ticker resolution (prevents ReferenceError if a name doesn't exist in this scope)
  tickerForOB =
    ((typeof selectedMarket !== "undefined") && selectedMarket && selectedMarket.ticker) ||
    ((typeof selected !== "undefined") && selected && selected.ticker) ||
    ((typeof market !== "undefined") && market && market.ticker) ||
    ((typeof picked !== "undefined") && picked && picked.ticker) ||
    ((typeof candidate !== "undefined") && candidate && candidate.ticker) ||
    ((typeof best !== "undefined") && best && best.ticker) ||
    null;

  if (!tickerForOB) { tickerForOB = selected?.ticker || tickerForOB; tickerForOB = selected?.ticker || tickerForOB;

// [PATCH] removed illegal top-level return:     return;
  }
const ob = await getOrderbook((tickerForOB || selected?.ticker), 1);

// Kalshi orderbook shape: { yes: [{price,count}...], no: [{price,count}...] }
const yesAsk = ob?.yes?.[0]?.price ?? null;
const noAsk  = ob?.no?.[0]?.price  ?? null;
const bestYesBid = (ob?.yes && ob.yes.length) ? ob.yes[ob.yes.length - 1].price : null;
const bestNoBid  = (ob?.no  && ob.no.length)  ? ob.no[ob.no.length - 1].price  : null;

console.log("Orderbook pricing:", { yesAsk, noAsk, bestYesBid, bestNoBid });
}
// ---- FIX: derive executable pricing from orderbook BEFORE askCents guard ----
let askCents = (typeof askCents !== 'undefined') ? askCents : null;
const obPricing = await getOrderbook(selected.ticker, 1);
const yesAskOB = obPricing?.yes?.[0]?.price ?? null;
const noAskOB  = obPricing?.no?.[0]?.price ?? null;
askCents = (side === 'yes') ? yesAskOB : noAskOB;
console.log('Orderbook pricing:', { yesAskOB, noAskOB, askCents });

if (askCents == null || askCents <= 0 || askCents >= 99) {

console.log("No trade — missing/invalid askCents:", askCents);
// [PATCH] removed illegal top-level return:     return;
  }
  if (askCents > cfg.maxEntryPriceCents) {
    console.log(`No trade — askCents ${askCents}¢ > maxEntryPriceCents ${cfg.maxEntryPriceCents}¢`);
// [PATCH] removed illegal top-level return:     return;
  }
  console.log(`Edge check: predYES=${predYes}¢ predNO=${predNo}¢ yesAsk=${yesAsk}¢ noAsk=${noAsk}¢ edgeYES=${edgeYes}¢ edgeNO=${edgeNo}¢ chosen=${side.toUpperCase()} edge=${edge}¢ minEdge=${cfg.minEdge}¢`);

  if (edge < cfg.minEdge) {
    console.log("No trade — edge too small.");
// [PATCH] removed illegal top-level return:     return;
  }

  const count = clamp(cfg.maxContracts, 1, cfg.maxContracts);

  console.log(`Decision: BUY ${side.toUpperCase()} ${count}x ${m.ticker} @ ${askCents}¢ (mode=${cfg.mode})`);

  if (cfg.mode === "live") {
    const out = await createOrder({
      ticker: m.ticker,
      action: "buy",
      side,
      count,
      priceCents: askCents,
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
    entryPriceCents: askCents,
    openedTs: nowTs()
  });
  await kvSetJson("bot:last_action", { ts: nowTs(), type:"entry", ticker:m.ticker, side, count, askCents });
  console.log("Saved bot:position");
// [PATCH] removed stray top-level brace: }

main().catch(e => {
  console.error("Bot runner failed:", e?.message || e);
  process.exit(1);
});
