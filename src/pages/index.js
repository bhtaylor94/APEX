import { useState, useEffect, useCallback, useRef } from "react";
import Head from "next/head";


async function kGet(path, params = {}) {
  try {
    const r = await fetch("/api/kalshi_public", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, params }),
    });
    return r.ok ? r.json() : null;
  } catch {
    return null;
  }
}


// ═══════════════════════════════════════════════════════════════
// APEX BOT v3 — Universal Kalshi Strategy Engine
// Scans ALL market categories • 6 Proven Strategy Engines
// ═══════════════════════════════════════════════════════════════

const PUB = "https://api.elections.kalshi.com/trade-api/v2";
const NWS = "https://api.weather.gov";

// ═══ MARKET UNIVERSE — Every Kalshi Category ═══
const WEATHER_CITIES = [
  { series: "KXHIGHNY", label: "NYC", station: "KNYC", lat: 40.7789, lon: -73.9692 },
  { series: "KXHIGHCHI", label: "CHI", station: "KORD", lat: 41.9742, lon: -87.9073 },
  { series: "KXHIGHMIA", label: "MIA", station: "KMIA", lat: 25.7959, lon: -80.287 },
  { series: "KXHIGHAUS", label: "AUS", station: "KAUS", lat: 30.1945, lon: -97.6699 },
  { series: "KXHIGHLA", label: "LA", station: "KLAX", lat: 33.9425, lon: -118.408 },
  { series: "KXHIGHDEN", label: "DEN", station: "KDEN", lat: 39.8561, lon: -104.6737 },
];

const ECON_SERIES = [
  { series: "KXCPI", label: "CPI", desc: "Consumer Price Index", src: "Cleveland Fed Nowcast" },
  { series: "KXPAYROLLS", label: "Jobs", desc: "Nonfarm Payrolls", src: "ADP Report" },
  { series: "KXUNEMPLOY", label: "Unemp", desc: "Unemployment Rate", src: "BLS" },
  { series: "KXFED", label: "Fed", desc: "Fed Funds Rate", src: "CME FedWatch" },
  { series: "KXGDP", label: "GDP", desc: "Gross Domestic Product", src: "Atlanta Fed GDPNow" },
  { series: "KXPCE", label: "PCE", desc: "Personal Consumption", src: "Cleveland Fed" },
  { series: "KXTSA", label: "TSA", desc: "TSA Passenger Volume", src: "TSA.gov historical" },
  { series: "KXINITCLAIMS", label: "Claims", desc: "Initial Jobless Claims", src: "DOL" },
];

// Strategy tags

function tradePriceForSide(yesPrice, side) {
  return side === "yes" ? yesPrice : 1 - yesPrice;
}

function tradeProbForSide(probYes, side) {
  return side === "yes" ? probYes : 1 - probYes;
}

function inProbBand(p, lo = 0.40, hi = 0.50) {
  return typeof p === "number" && p >= lo && p <= hi;
}

const STRAT = {
  WEATHER: "WX_EDGE",         // NWS ensemble vs market
  FLB: "FAV_LONGSHOT",        // Favorite-longshot bias exploitation
  ME_ARB: "ME_ARBITRAGE",     // Mutually exclusive event arbitrage
  VOL_SPIKE: "VOL_SPIKE",     // Volume spike momentum
  SPREAD: "SPREAD_FADE",      // Wide spread fade (buy at bid when spread > 8)
  ECON: "ECON_EDGE",          // Economic data nowcast edge
};

const f1 = n => Number(n).toFixed(1);
const f0 = n => Number(n).toFixed(0);
const usd = n => `$${Number(n).toFixed(2)}`;
const pct = n => `${Math.round(n * 100)}%`;
const normCDF = (x, mean, std) => {
  if (std <= 0) return x >= mean ? 1 : 0;
  const z = (x - mean) / std;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const p = 0.3989422804 * Math.exp(-z * z / 2) * t *
    (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
};

// Kelly criterion: f* = (bp - q) / b where b=odds, p=win prob, q=lose prob
function shouldTradePrice(price) {
  return typeof price === "number" && price >= 0.10 && price <= 0.90;
}

function kellyFraction(prob, price, fraction = 0.25) {
  const b = (1 - price) / price; // payout odds
  const f = (b * prob - (1 - prob)) / b;
  return Math.max(0, Math.min(0.15, f * fraction)); // cap at 15% bankroll
}

// Storage
const SK = "apex_v3";
const load = () => { try { return JSON.parse(localStorage.getItem(SK)) || {}; } catch { return {}; } };
const save = d => { try { localStorage.setItem(SK, JSON.stringify(d)); } catch {} };

// API
async function authReq(path, method = "GET", body = null) {
  try {
    const r = await fetch("/api/kalshi", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, method, body }),
    });
    const d = await r.json();
    return d.error === "no_keys" ? { noKeys: true } : d;
  } catch { return null; }
}
async function nwsGet(path, params = {}) {
  try {
    const r = await fetch("/api/nws", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, params }),
    });
    return r.ok ? r.json() : null;
  } catch {
    return null;
  }
}

// ═══ STRATEGY ENGINES ═══

// 1. WEATHER EDGE — NWS ensemble vs Kalshi price
async function wxForecast(city) {
  // Current forecast/obs from NWS via server proxy (avoids CORS + ensures proper headers)
  const cur = await fetch("/api/weather_current", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lat: city.lat, lon: city.lon, station: city.station }),
  }).then(r => r.ok ? r.json() : null);

  // Historical daily highs from NOAA CDO (10-year +/-10d window), cached server-side
  const hist = await fetch("/api/weather_history", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lat: city.lat, lon: city.lon, years: 10, windowDays: 10 }),
  }).then(r => r.ok ? r.json() : null);

  if (!cur) return null;

  // Combine current forecast with historical distribution to get a more data-driven sigma.
  // If NOAA history is available, use its std (bounded) as uncertainty.
  const sig = (hist && typeof hist.std === "number" && hist.std > 0)
    ? Math.max(1.5, Math.min(12, hist.std))
    : cur.sig;

  // Center on current ensemble estimate; history mainly informs uncertainty.
  const ens = cur.ens;

  return { ...cur, ens, sig, hist };
}

function evalWeatherMkt(mkt, wx) {
  const price = (mkt.yes_bid != null ? (mkt.yes_bid + (mkt.yes_ask || mkt.yes_bid)) / 2 : mkt.yes_price || mkt.last_price || 50) / 100;
  const vol = mkt.volume || 0;
  const title = mkt.title || "";
  const m = title.match(/(\d+)\s*°?\s*F?\s*(or\s*(above|below|higher|lower|more|less))?/i);
  if (!m || !wx?.ens) return null;
  const thresh = parseInt(m[1]);
  const above = !/below|lower|less|under/i.test(title);
  const raw = above ? 1 - normCDF(thresh, wx.ens, wx.sig) : normCDF(thresh, wx.ens, wx.sig);
  const prob = Math.max(0.001, Math.min(0.999, raw));
  const edge = (prob - price) * 100;
  const kelly = kellyFraction(prob, price);
  return {
    ticker: mkt.ticker, title, price, prob, edge, vol, thresh, above, kelly,
    strategy: STRAT.WEATHER, confidence: Math.min(1, Math.abs(edge) / 15),
    reason: `Forecast ${wx.ens}°F → ${thresh}°F threshold. Model ${f0(prob*100)}% vs Mkt ${f0(price*100)}¢`,
  };
}

// 2. FAVORITE-LONGSHOT BIAS — Academic research shows high-price contracts (>80¢) win MORE
// often than implied, while low-price (<20¢) win LESS. Exploit by buying favorites, fading longshots.
function evalFLB(mkt) {
  const price = (mkt.yes_price || mkt.last_price || 50) / 100;
  const vol = mkt.volume || 0;
  if (vol < 20) return null; // need volume for this to be meaningful
  // FLB: contracts 82-95¢ historically win ~3-5% more than price implies
  // Contracts 5-18¢ historically win ~5-10% LESS than price implies
  let edge = 0, side = "yes", reason = "";
  if (price >= 0.82 && price <= 0.95) {
    const bias = 0.03 + (price - 0.82) * 0.15; // ~3-5% bias
    edge = bias * 100;
    reason = `FLB: Favorites at ${f0(price*100)}¢ historically win ${f1(bias*100+price*100)}% (bias +${f1(bias*100)}%)`;
  } else if (price >= 0.05 && price <= 0.18) {
    const bias = 0.05 + (0.18 - price) * 0.4; // ~5-10% bias
    edge = bias * 100;
    side = "no";
    reason = `FLB: Longshot at ${f0(price*100)}¢ historically wins only ${f1(price*100-bias*100)}% (fade for +${f1(bias*100)}¢ edge)`;
  } else {
    return null;
  }
  const kelly = kellyFraction(side === "yes" ? price + edge/100 : 1 - price + edge/100, side === "yes" ? price : 1 - price);
  return {
    ticker: mkt.ticker, title: mkt.title, price, edge, vol, side, kelly,
    strategy: STRAT.FLB, confidence: Math.min(1, edge / 8),
    reason,
  };
}

// 3. MUTUALLY EXCLUSIVE ARBITRAGE — If event has mutually_exclusive markets,
// sum of all YES prices should equal 100¢. If sum < 100 or > 100, arb exists.
function evalMEArb(event) {
  if (!event?.mutually_exclusive || !event?.markets?.length) return [];
  const mkts = event.markets.filter(m => m.status === "active" || m.status === "open");
  if (mkts.length < 2) return [];
  const totalYes = mkts.reduce((s, m) => s + ((m.yes_price || m.last_price || 50) / 100), 0);
  const signals = [];
  // If sum > 1.02, buy NO on all (guaranteed profit = sum - 1.00 minus fees)
  if (totalYes > 1.03) {
    const profit = (totalYes - 1.0) * 100;
    signals.push({
      ticker: mkts[0].ticker, title: `ME-ARB: ${event.title}`,
      price: totalYes, edge: profit, vol: mkts.reduce((s, m) => s + (m.volume || 0), 0),
      strategy: STRAT.ME_ARB, confidence: Math.min(1, profit / 10),
      reason: `Sum of YES = ${f1(totalYes * 100)}¢ > 100¢. Buy all NO → guaranteed ${f1(profit)}¢ profit`,
      side: "no", kelly: 0.05, arbMkts: mkts.map(m => m.ticker),
    });
  }
  // If sum < 0.97, buy YES on all
  if (totalYes < 0.97) {
    const profit = (1.0 - totalYes) * 100;
    signals.push({
      ticker: mkts[0].ticker, title: `ME-ARB: ${event.title}`,
      price: totalYes, edge: profit, vol: mkts.reduce((s, m) => s + (m.volume || 0), 0),
      strategy: STRAT.ME_ARB, confidence: Math.min(1, profit / 10),
      reason: `Sum of YES = ${f1(totalYes * 100)}¢ < 100¢. Buy all YES → guaranteed ${f1(profit)}¢ profit`,
      side: "yes", kelly: 0.05, arbMkts: mkts.map(m => m.ticker),
    });
  }
  return signals;
}

// 4. VOLUME SPIKE — Detect sudden volume surge relative to open interest (smart money)
function evalVolSpike(mkt) {
  const vol24 = mkt.volume_24h || 0;
  const oi = mkt.open_interest || 1;
  const price = (mkt.yes_price || mkt.last_price || 50) / 100;
  if (vol24 < 50 || price < 0.1 || price > 0.9) return null;
  const ratio = vol24 / Math.max(oi, 1);
  // If 24h volume > 3x open interest, something big is happening
  if (ratio < 3) return null;
  // Volume surge near recent price move suggests informed trading
  const edge = Math.min(15, ratio * 1.5);
  return {
    ticker: mkt.ticker, title: mkt.title, price, edge, vol: vol24,
    strategy: STRAT.VOL_SPIKE, confidence: Math.min(1, ratio / 10),
    reason: `Volume spike: ${vol24} contracts in 24h vs ${oi} OI (${f1(ratio)}x ratio). Smart money moving.`,
    side: price > 0.5 ? "yes" : "no", kelly: 0.02, // conservative on momentum
  };
}

// 5. SPREAD ANALYSIS — Wide bid-ask spreads indicate inefficiency. Place limit orders in the gap.
function evalSpread(mkt) {
  const bid = mkt.yes_bid || 0;
  const ask = mkt.yes_ask || 100;
  const spread = ask - bid;
  const mid = (bid + ask) / 2;
  const vol = mkt.volume || 0;
  if (spread < 6 || bid < 5 || ask > 95 || vol < 5) return null; // need meaningful spread
  // Place limit at midpoint — capture half the spread
  const edge = spread / 2;
  return {
    ticker: mkt.ticker, title: mkt.title, price: mid / 100, edge, vol,
    strategy: STRAT.SPREAD, confidence: Math.min(1, spread / 20),
    reason: `Wide spread: bid ${bid}¢ / ask ${ask}¢ (${spread}¢ gap). Limit at ${f0(mid)}¢ captures ~${f0(edge)}¢`,
    side: "yes", kelly: 0.03, limitPrice: Math.round(mid),
  };
}

// 6. ECONOMIC EDGE — Markets that are close to settlement with known data signals
function evalEconMkt(mkt, seriesInfo) {
  const price = (mkt.yes_price || mkt.last_price || 50) / 100;
  const vol = mkt.volume || 0;
  const close = mkt.close_time ? new Date(mkt.close_time) : null;
  const hoursToClose = close ? (close - Date.now()) / 3600000 : 999;
  // Flag high-volume econ markets closing soon as opportunities for edge w/ external data
  return {
    ticker: mkt.ticker, title: mkt.title || "", price, vol,
    cat: seriesInfo.label, catDesc: seriesInfo.desc, src: seriesInfo.src,
    hoursToClose: Math.round(hoursToClose),
    strategy: STRAT.ECON,
  };
}

// ═══ COLORS ═══
const C = {
  bg: "#060b18", cd: "#0d1526", bd: "#1a2540", tx: "#e2e8f0",
  dm: "#475569", g: "#34d399", r: "#f87171", b: "#60a5fa",
  y: "#fbbf24", cy: "#22d3ee", p: "#a78bfa", o: "#fb923c",
};

const stratColor = {
  [STRAT.WEATHER]: C.cy,
  [STRAT.FLB]: C.p,
  [STRAT.ME_ARB]: C.g,
  [STRAT.VOL_SPIKE]: C.o,
  [STRAT.SPREAD]: C.b,
  [STRAT.ECON]: C.y,
};
const stratLabel = {
  [STRAT.WEATHER]: "WEATHER",
  [STRAT.FLB]: "FAV/LONG",
  [STRAT.ME_ARB]: "ARB",
  [STRAT.VOL_SPIKE]: "VOL SPIKE",
  [STRAT.SPREAD]: "SPREAD",
  [STRAT.ECON]: "ECON",
};

const Pill = ({ color, children }) => (
  <span style={{ display: "inline-block", padding: "1px 6px", borderRadius: 4, fontSize: 8, fontWeight: 800, background: color + "25", color, letterSpacing: 0.5, marginRight: 4 }}>{children}</span>
);

// ═══ APP ══════════════════════════════════════════════════════

export default function Apex() {
  const [tab, setTab] = useState("signals");
  const [on, setOn] = useState(false);
  const [signals, setSignals] = useState([]); // ALL strategy signals
  const [econMkts, setEconMkts] = useState([]);
  const [positions, setPositions] = useState([]);
  const [log, setLog] = useState([]);
  const [st, setSt] = useState({ trades: 0, wins: 0, pnl: 0, scans: 0 });
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState("");
  const [scanProgress, setScanProgress] = useState(0);
  const [lastScan, setLastScan] = useState(null);
  const [bal, setBal] = useState(null);
  const [connected, setConnected] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [authErr, setAuthErr] = useState(null);
  const [stratFilter, setStratFilter] = useState("all");
  const [scanStats, setScanStats] = useState({ markets: 0, events: 0, signals: 0 });

  const [cfg, setCfg] = useState({
    bet: 10, minEdge: 3, pMin: 10, pMax: 90, tp: 8, sl: 12,
    maxPos: 5, minVol: 0, interval: 120, auto: false, minConfidence: 0.3,
    // Strategy toggles
    wxOn: true, flbOn: true, arbOn: true, volOn: true, spreadOn: true, econOn: true,
  });
  const up = (k, v) => setCfg(c => ({ ...c, [k]: v }));

  // Load saved data
  useEffect(() => {
    const d = load();
    if (d.log) setLog(d.log);
    if (d.st) setSt(d.st);
    if (d.positions) setPositions(d.positions);
    if (d.cfg) setCfg(c => ({ ...c, ...d.cfg }));
    authReq("/portfolio/balance").then(d => {
      if (d && !d.noKeys && !d.error && d.balance != null) {
        setConnected(true); setBal(d.balance);
      } else if (d && d.error && d.error !== "no_keys") setAuthErr(d);
      setAuthChecked(true);
    });
  }, []);

  useEffect(() => { save({ log, st, positions, cfg }); }, [log, st, positions, cfg]);

  // ═══ UNIVERSAL SCANNER ═══
  const scanAll = useCallback(async () => {
    setScanning(true);
    const allSignals = [];
    let totalMkts = 0, totalEvents = 0;

    // ── Phase 1: Weather Markets ──
    if (cfg.wxOn) {
      setScanMsg("☁ Scanning weather markets...");
      setScanProgress(10);
      for (const city of WEATHER_CITIES) {
        setScanMsg(`☁ ${city.label}: getting forecast...`);
        const wx = await wxForecast(city);
        if (!wx?.ens) continue;
        const d = await kGet("/markets", { series_ticker: city.series, status: "open", limit: 100 });
        for (const mkt of d?.markets || []) {
          totalMkts++;
          const sig = evalWeatherMkt(mkt, wx);
          if (sig && Math.abs(sig.edge) >= cfg.minEdge) {
            sig.city = city.label;
            allSignals.push(sig);
          }
        }
      }
    }

    // ── Phase 2: Scan ALL open events for FLB, Volume Spike, Spread, and ME-Arb ──
    setScanMsg("📊 Scanning all open markets...");
    setScanProgress(35);
    let cursor = null;
    let pages = 0;
    const maxPages = 10; // ~1000 markets max
    while (pages < maxPages) {
      const params = { status: "open", limit: 100 };
      if (cursor) params.cursor = cursor;
      const d = await kGet("/markets", params);
      if (!d?.markets?.length) break;
      for (const mkt of d.markets) {
        totalMkts++;
        // FLB strategy
        if (cfg.flbOn) {
          const flb = evalFLB(mkt);
          if (flb && flb.edge >= cfg.minEdge) allSignals.push(flb);
        }
        // Volume spike
        if (cfg.volOn) {
          const vs = evalVolSpike(mkt);
          if (vs) allSignals.push(vs);
        }
        // Spread analysis
        if (cfg.spreadOn) {
          const sp = evalSpread(mkt);
          if (sp && sp.edge >= cfg.minEdge) allSignals.push(sp);
        }
      }
      cursor = d.cursor;
      if (!cursor) break;
      pages++;
      setScanMsg(`📊 Scanning markets... page ${pages + 1} (${totalMkts} markets)`);
      setScanProgress(35 + pages * 5);
    }

    // ── Phase 3: ME-Arb on events ──
    if (cfg.arbOn) {
      setScanMsg("🔄 Checking mutually exclusive events for arbitrage...");
      setScanProgress(75);
      // Scan events with high volume that are mutually exclusive
      const evD = await kGet("/events", { status: "open", limit: 50 });
      for (const ev of evD?.events || []) {
        totalEvents++;
        if (ev.mutually_exclusive && ev.markets?.length >= 2) {
          const arbSigs = evalMEArb(ev);
          allSignals.push(...arbSigs);
        }
      }
    }

    // ── Phase 4: Economic markets ──
    if (cfg.econOn) {
      setScanMsg("💰 Scanning economic markets...");
      setScanProgress(85);
      const econResults = [];
      for (const ec of ECON_SERIES) {
        const d = await kGet("/markets", { series_ticker: ec.series, status: "open", limit: 50 });
        for (const mkt of d?.markets || []) {
          totalMkts++;
          const em = evalEconMkt(mkt, ec);
          econResults.push(em);
        }
      }
      econResults.sort((a, b) => b.vol - a.vol);
      setEconMkts(econResults);
    }

    // Sort all signals by absolute edge descending
    allSignals.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));

    // Deduplicate by ticker (keep highest edge)
    const seen = new Set();
    const deduped = allSignals.filter(s => {
      if (seen.has(s.ticker)) return false;
      seen.add(s.ticker);
      return true;
    });

    setSignals(deduped);
    setScanStats({ markets: totalMkts, events: totalEvents, signals: deduped.length });
    setSt(prev => ({ ...prev, scans: prev.scans + 1 }));
    setLastScan(Date.now());
    setScanMsg(`✓ Found ${deduped.length} signals across ${totalMkts} markets`);
    setScanProgress(100);
    setScanning(false);

    // Auto-execute if enabled
    if (cfg.auto && connected) {
      const topSignals = deduped.filter(s =>
        s.confidence >= cfg.minConfidence &&
        Math.abs(s.edge) >= cfg.minEdge &&
        s.price >= cfg.pMin / 100 && s.price <= cfg.pMax / 100
      ).slice(0, cfg.maxPos - positions.length);
      for (const sig of topSignals) {
        if (!positions.find(p => p.ticker === sig.ticker)) {
          if (!inProbBand(tradeProbForSide(sig.prob, sig.side || (sig.edge > 0 ? 'yes' : 'no')), 0.40, 0.50)) { addLog('SKIP prob band (40–50%)'); } else { await execTrade(sig); }
        }
      }
    }

    // Refresh balance
    if (connected) {
      const b = await authReq("/portfolio/balance");
      if (b?.balance != null) setBal(b.balance);
    }
  }, [cfg, positions, connected]);

  // Trading
  
const execTrade = async (s) => {
    // Never trade tail probabilities / lotto contracts (server also enforces 10c–90c)
    const side = s.side || (s.edge > 0 ? "yes" : "no");
    const entryPrice = tradePriceForSide(s.price, side);
    const tradeProb = tradeProbForSide(s.prob, side);
    const marketYesProb = Number(s.price); // market-implied YES probability

    // Only trade if implied probability is in the 40–50% band
    if (!inProbBand(marketYesProb, 0.40, 0.50)) {
      addLog(`SKIP prob band (market YES): ${Math.round(marketYesProb * 100)}% (requires 40–50%)`);
      return;
    }

    // Enforce UI price floor/ceiling against the ACTUAL side price we will trade
    if (!shouldTradePrice(entryPrice) || entryPrice < cfg.pMin || entryPrice > cfg.pMax) {
      addLog(`SKIP price gate: ${(entryPrice * 100).toFixed(0)}c (allowed ${(cfg.pMin*100).toFixed(0)}c–${(cfg.pMax*100).toFixed(0)}c)`);
      return;
    }

    const contracts = s.contracts || Math.max(1, Math.floor(cfg.bet / entryPrice));
    if (contracts < 1) return;

    // Take-profit is treated as % gain (e.g. 20 => 20% gain)
    const tpPct = Math.max(0, (cfg.tp || 0) / 100);
    const slPct = Math.max(0, (cfg.sl || 0) / 100);

    const pos = {
      ...s,
      side,
      entryPrice,
      tradeProb,
      contracts,
      tpPct,
      slPct,
      entryTime: Date.now(),
      id: Date.now(),
      live: false,
    };

    if (connected) {
      const body = {
        ticker: s.ticker,
        action: "buy",
        side,
        type: "limit",
        count: contracts,
        ...(side === "yes"
          ? { yes_price: s.limitPrice || Math.round(s.price * 100) }
          : { no_price: s.limitPrice || Math.round((1 - s.price) * 100) }),
        client_order_id: `apex-${Date.now()}`,
      };

      // NOTE: Kalshi create order endpoint is /orders
      const r = await authReq("/orders", "POST", body);
      if (r?.order) {
        pos.orderId = r.order.order_id;
        pos.live = true;
      } else if (r?.order_id) {
        pos.orderId = r.order_id;
        pos.live = true;
      }
    }

    setPositions((p) => [...p, pos]);
    pushLog("OPEN", { ...pos });
    setSt((prev) => ({ ...prev, trades: prev.trades + 1 }));
  };

  
  const closePos = async (id, pnl = 0) => {
    const p = positions.find(x => x.id === id);
    if (!p) return;

    // If connected, send a sell order (limit at current mid). Then optimistically remove from UI.
    if (connected && p.live) {
      try {
        const mkts = await kGet("/markets", { ticker: p.ticker });
        const mkt = mkts?.markets?.[0] || mkts?.results?.[0] || mkts?.[0];
        const yesMidC =
          mkt?.yes_bid != null
            ? (mkt.yes_bid + (mkt.yes_ask || mkt.yes_bid)) / 2
            : (mkt?.yes_price || mkt?.last_price || 50);

        const yesMid = yesMidC / 100;

        const body = {
          ticker: p.ticker,
          action: "sell",
          side: p.side,
          type: "limit",
          count: p.contracts,
          ...(p.side === "yes"
            ? { yes_price: Math.round(yesMid * 100) }
            : { no_price: Math.round((1 - yesMid) * 100) }),
          client_order_id: `apex-close-${Date.now()}`,
        };

        await authReq("/orders", "POST", body);
      } catch {}
    }

    setPositions(prev => {
      const hit = prev.find(x => x.id === id);
      if (hit) {
        pushLog("CLOSE", hit);
        setSt(s => ({ ...s, pnl: s.pnl + pnl, wins: s.wins + (pnl > 0 ? 1 : 0) }));
      }
      return prev.filter(x => x.id !== id);
    });
  };


  const pushLog = (type, d) => {
    setLog(l => [{
      type, strat: d.strategy, ticker: d.ticker, side: d.side,
      qty: d.contracts, price: d.entryPrice || d.price, edge: d.edge,
      reason: d.reason || "", live: d.live, time: new Date().toISOString(),
    }, ...l].slice(0, 500));
  };

  // Bot loop
  useEffect(() => {
    if (!on) return;
    scanAll();
    const iv = setInterval(scanAll, cfg.interval * 1000);
    return () => clearInterval(iv);
  }, [on, scanAll, cfg.interval]);

  // Derived
  const filteredSignals = stratFilter === "all"
    ? signals
    : signals.filter(s => s.strategy === stratFilter);
  const tradeable = filteredSignals.filter(s =>
    Math.abs(s.edge) >= cfg.minEdge &&
    s.confidence >= cfg.minConfidence &&
    s.price >= cfg.pMin / 100 && s.price <= cfg.pMax / 100 &&
    (cfg.minVol === 0 || s.vol >= cfg.minVol)
  );
  const totalUnreal = positions.reduce((s, p) => s + (p.unrealPnl || 0), 0);
  const wr = st.trades > 0 ? (st.wins / st.trades * 100) : 0;

  // Count by strategy
  const stratCounts = {};
  signals.forEach(s => { stratCounts[s.strategy] = (stratCounts[s.strategy] || 0) + 1; });

  const tabs = ["signals", "econ", "positions", "log", "settings"];

  return (<>
    <Head><title>APEX v3</title><meta name="viewport" content="width=device-width, initial-scale=1" /></Head>
    <div style={{ maxWidth: 480, margin: "0 auto", minHeight: "100vh", background: C.bg, color: C.tx, fontFamily: "-apple-system, system-ui, sans-serif" }}>
      {/* Header */}
      <div style={{ padding: "12px 16px", borderBottom: `1px solid ${C.bd}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <span style={{ fontSize: 16, fontWeight: 900, letterSpacing: 2 }}>APEX</span>
            <span style={{ fontSize: 9, color: C.dm, marginLeft: 6 }}>v3</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ textAlign: "right" }}>
              <span style={{ fontSize: 16, fontWeight: 800, color: (st.pnl + totalUnreal) >= 0 ? C.g : C.r }}>
                {(st.pnl + totalUnreal) >= 0 ? "+" : ""}{usd(st.pnl + totalUnreal)}
              </span>
            </div>
            <button onClick={() => setOn(!on)} style={{
              padding: "6px 16px", borderRadius: 20, border: "none",
              background: on ? C.r : C.g, color: "#000",
              fontSize: 10, fontWeight: 900, cursor: "pointer",
            }}>{on ? "STOP" : "START"}</button>
          </div>
        </div>
        {/* Status bar */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, padding: "4px 0" }}>
          {!authChecked ? <span style={{ fontSize: 10, color: C.dm }}>Checking...</span>
            : connected ? <span style={{ fontSize: 10, color: C.g }}>● Connected • {usd((bal || 0) / 100)}</span>
            : authErr ? <span style={{ fontSize: 10, color: C.r, cursor: "pointer" }} onClick={() => setTab("settings")}>✕ Error → Settings</span>
            : <span style={{ fontSize: 10, color: C.y, cursor: "pointer" }} onClick={() => setTab("settings")}>○ Not connected → Setup</span>
          }
          <div style={{ fontSize: 9, color: C.dm }}>
            {scanStats.signals > 0 && <>{scanStats.signals} signals • {scanStats.markets} mkts</>}
          </div>
        </div>
        {/* Scan progress */}
        {scanning && (
          <div style={{ marginTop: 4 }}>
            <div style={{ height: 2, background: C.bd, borderRadius: 1, overflow: "hidden" }}>
              <div style={{ height: "100%", background: C.b, width: `${scanProgress}%`, transition: "width 0.3s" }} />
            </div>
            <div style={{ fontSize: 8, color: C.dm, marginTop: 2 }}>{scanMsg}</div>
          </div>
        )}
      </div>

      {/* Stats bar */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", textAlign: "center", padding: "8px 16px", borderBottom: `1px solid ${C.bd}` }}>
        {[
          { l: "TRADES", v: st.trades },
          { l: "WIN%", v: st.trades > 0 ? `${f0(wr)}%` : "—" },
          { l: "OPEN", v: `${positions.length}/${cfg.maxPos}` },
          { l: "SIGNALS", v: signals.length },
        ].map(x => (
          <div key={x.l}>
            <div style={{ fontSize: 8, color: C.dm, letterSpacing: 1.5 }}>{x.l}</div>
            <div style={{ fontSize: 14, fontWeight: 800 }}>{x.v}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", borderBottom: `1px solid ${C.bd}`, overflowX: "auto" }}>
        {tabs.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            flex: 1, padding: "10px 0", border: "none", background: "transparent",
            color: tab === t ? C.b : C.dm, fontSize: 10, fontWeight: 700, cursor: "pointer",
            borderBottom: tab === t ? `2px solid ${C.b}` : "2px solid transparent",
            letterSpacing: 1, textTransform: "uppercase",
          }}>{t}</button>
        ))}
      </div>

      {/* Content */}
      <div style={{ padding: 16, paddingBottom: 80 }}>

        {/* ═══ SIGNALS TAB ═══ */}
        {tab === "signals" && (<>
          {/* Manual scan button */}
          <button onClick={() => !scanning && scanAll()} disabled={scanning} style={{
            width: "100%", padding: 12, marginBottom: 12, borderRadius: 8,
            border: `1px solid ${C.bd}`, background: scanning ? C.bd : C.cd,
            color: scanning ? C.dm : C.b, fontSize: 12, fontWeight: 800, cursor: "pointer",
          }}>
            {scanning ? `⟳ SCANNING... (${scanProgress}%)` : "⚡ SCAN ALL MARKETS"}
          </button>

          {/* Strategy filter pills */}
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 12 }}>
            <button onClick={() => setStratFilter("all")} style={{
              padding: "4px 10px", borderRadius: 12, border: `1px solid ${stratFilter === "all" ? C.b : C.bd}`,
              background: stratFilter === "all" ? C.b + "20" : "transparent",
              color: stratFilter === "all" ? C.b : C.dm, fontSize: 9, fontWeight: 700, cursor: "pointer",
            }}>ALL ({signals.length})</button>
            {Object.entries(STRAT).map(([key, val]) => {
              const count = stratCounts[val] || 0;
              if (count === 0) return null;
              return (
                <button key={val} onClick={() => setStratFilter(stratFilter === val ? "all" : val)} style={{
                  padding: "4px 10px", borderRadius: 12,
                  border: `1px solid ${stratFilter === val ? stratColor[val] : C.bd}`,
                  background: stratFilter === val ? stratColor[val] + "20" : "transparent",
                  color: stratFilter === val ? stratColor[val] : C.dm,
                  fontSize: 9, fontWeight: 700, cursor: "pointer",
                }}>{stratLabel[val]} ({count})</button>
              );
            })}
          </div>

          {/* Signal cards */}
          {tradeable.length > 0 && (
            <div style={{ fontSize: 9, color: C.g, letterSpacing: 2, marginBottom: 8, fontWeight: 700 }}>
              ✓ {tradeable.length} TRADEABLE SIGNALS
            </div>
          )}

          {(stratFilter !== "all" ? filteredSignals : tradeable).slice(0, 25).map((s, i) => {
            const side = s.side || (s.edge > 0 ? "yes" : "no");
            const inPos = positions.find(p => p.ticker === s.ticker);
            const contracts = Math.max(1, Math.floor(cfg.bet / (side === "yes" ? s.price : 1 - s.price)));
            return (
              <div key={s.ticker + i} style={{
                padding: "10px 12px", marginBottom: 4, background: C.cd, borderRadius: 8,
                borderLeft: `3px solid ${stratColor[s.strategy] || C.b}`,
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, lineHeight: 1.4, marginBottom: 3 }}>
                      <Pill color={stratColor[s.strategy]}>{stratLabel[s.strategy]}</Pill>
                      {s.city && <Pill color={C.cy}>{s.city}</Pill>}
                      {s.title?.length > 60 ? s.title.slice(0, 57) + "..." : s.title}
                    </div>
                    <div style={{ fontSize: 9, color: C.dm, lineHeight: 1.5 }}>
                      {s.reason}
                    </div>
                    {/* Confidence bar */}
                    <div style={{ marginTop: 5, display: "flex", alignItems: "center", gap: 6 }}>
                      <div style={{ flex: 1, height: 3, background: C.bd, borderRadius: 2, overflow: "hidden" }}>
                        <div style={{
                          height: "100%", borderRadius: 2,
                          width: `${Math.min(100, (s.confidence || 0) * 100)}%`,
                          background: (s.confidence || 0) >= 0.7 ? C.g : (s.confidence || 0) >= 0.4 ? C.y : C.b,
                        }} />
                      </div>
                      <span style={{ fontSize: 8, color: C.dm, flexShrink: 0 }}>
                        {(s.confidence || 0) >= 0.7 ? "HIGH" : (s.confidence || 0) >= 0.4 ? "MED" : "LOW"}
                      </span>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 16, fontWeight: 800, color: Math.abs(s.edge) >= 8 ? C.g : C.y }}>
                        {s.edge > 0 ? "+" : ""}{f1(s.edge)}¢
                      </div>
                      <div style={{ fontSize: 8, color: C.dm }}>{contracts}× {side.toUpperCase()}</div>
                    </div>
                    <button
                      onClick={() => !inPos && execTrade({ ...s, side, contracts })}
                      disabled={!!inPos || positions.length >= cfg.maxPos}
                      style={{
                        padding: "8px 10px", borderRadius: 6, border: "none",
                        fontSize: 10, fontWeight: 800, cursor: "pointer",
                        background: inPos ? C.dm + "40" : stratColor[s.strategy] || C.g,
                        color: inPos ? C.dm : "#000",
                        opacity: (!!inPos || positions.length >= cfg.maxPos) ? 0.3 : 1,
                      }}
                    >{inPos ? "IN" : "BUY"}</button>
                  </div>
                </div>
              </div>
            );
          })}

          {signals.length === 0 && !scanning && (
            <div style={{ padding: 24, textAlign: "center", background: C.cd, borderRadius: 10, lineHeight: 1.8 }}>
              <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 8 }}>6-Strategy Engine</div>
              <div style={{ fontSize: 11, color: C.dm }}>
                Press <span style={{ color: C.b }}>SCAN ALL MARKETS</span> or <span style={{ color: C.g }}>START</span> to begin.
                <br/><br/>
                <span style={{ color: C.cy }}>☁ Weather Edge</span> — NWS ensemble vs market price
                <br/><span style={{ color: C.p }}>📊 Fav-Longshot</span> — Exploit known pricing bias
                <br/><span style={{ color: C.g }}>🔄 ME-Arbitrage</span> — Risk-free mutual exclusion arb
                <br/><span style={{ color: C.o }}>📈 Volume Spike</span> — Smart money detection
                <br/><span style={{ color: C.b }}>💎 Spread Fade</span> — Wide bid-ask inefficiency
                <br/><span style={{ color: C.y }}>💰 Econ Edge</span> — Economic data nowcasts
              </div>
            </div>
          )}
        </>)}

        {/* ═══ ECON TAB ═══ */}
        {tab === "econ" && (<>
          <button onClick={() => !scanning && scanAll()} disabled={scanning} style={{
            width: "100%", padding: 10, marginBottom: 12, borderRadius: 8,
            border: `1px solid ${C.bd}`, background: C.cd, color: scanning ? C.dm : C.y,
            fontSize: 11, fontWeight: 700, cursor: "pointer",
          }}>
            {scanning ? "⟳ SCANNING..." : "SCAN ECONOMIC MARKETS"}
          </button>
          {econMkts.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", background: C.cd, borderRadius: 10, lineHeight: 1.8 }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Economic Markets</div>
              <div style={{ fontSize: 11, color: C.dm }}>
                Press scan to load CPI, Fed Rate, Jobs, GDP, Unemployment, PCE, TSA, and Claims markets.
                <br/><br/>
                Use external sources for edge:
                <br/><span style={{ color: C.b }}>Cleveland Fed</span> CPI/PCE Nowcast
                <br/><span style={{ color: C.b }}>CME FedWatch</span> for rate decisions
                <br/><span style={{ color: C.b }}>ADP Report</span> for payrolls
                <br/><span style={{ color: C.b }}>Atlanta Fed GDPNow</span> for GDP
                <br/><span style={{ color: C.b }}>TSA.gov</span> historical patterns
              </div>
            </div>
          ) : (<>
            <div style={{ fontSize: 9, color: C.dm, letterSpacing: 2, marginBottom: 8, fontWeight: 700 }}>
              {econMkts.length} MARKETS • sorted by volume
            </div>
            {econMkts.slice(0, 40).map((m, i) => (
              <div key={m.ticker + i} style={{
                padding: "8px 12px", marginBottom: 3, background: C.cd, borderRadius: 6,
                borderLeft: `3px solid ${C.y}`,
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, lineHeight: 1.4, marginBottom: 2 }}>
                      <Pill color={C.p}>{m.cat}</Pill> {m.title}
                    </div>
                    <div style={{ fontSize: 9, color: C.dm }}>
                      Vol: {m.vol} • {m.hoursToClose < 999 ? `${m.hoursToClose}h to close` : ""} • Source: {m.src}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{ fontSize: 16, fontWeight: 800 }}>{f0(m.price * 100)}¢</div>
                  </div>
                </div>
              </div>
            ))}
          </>)}
        </>)}

        {/* ═══ POSITIONS TAB ═══ */}
        {tab === "positions" && (<>
          {positions.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: C.dm, fontSize: 12 }}>
              No open positions. Scan for signals and click BUY to open trades.
            </div>
          ) : (
            <div>
              <div style={{ fontSize: 9, color: C.dm, letterSpacing: 2, marginBottom: 8, fontWeight: 700 }}>
                {positions.length} OPEN POSITION{positions.length !== 1 ? "S" : ""}
              </div>
              {positions.map(p => {
                const mins = Math.floor((Date.now() - p.entryTime) / 60000);
                const hasPnl = p.unrealPnl != null;
                return (
                  <div key={p.id} style={{
                    padding: "10px 12px", marginBottom: 4, background: C.cd, borderRadius: 8,
                    borderLeft: `3px solid ${stratColor[p.strategy] || C.bd}`,
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 11, fontWeight: 700 }}>
                          <Pill color={stratColor[p.strategy]}>{stratLabel[p.strategy]}</Pill>
                          <span style={{ color: p.side === "yes" ? C.g : C.r }}>{p.side.toUpperCase()}</span>
                          {" "}{p.contracts}× @ {f0(p.entryPrice * 100)}¢
                          {p.live && <Pill color={C.g}>LIVE</Pill>}
                        </div>
                        <div style={{ fontSize: 9, color: C.dm, marginTop: 2 }}>
                          {p.title?.slice(0, 50)} • TP {p.tp}¢ SL {p.sl}¢ • {mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h`}
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                        {hasPnl && (
                          <span style={{ fontSize: 13, fontWeight: 800, color: p.unrealPnl >= 0 ? C.g : C.r }}>
                            {p.unrealPnl >= 0 ? "+" : ""}{usd(p.unrealPnl)}
                          </span>
                        )}
                        <button onClick={() => closePos(p.id, p.unrealPnl || 0)} style={{
                          padding: "6px 10px", borderRadius: 5, border: `1px solid ${C.bd}`,
                          background: "transparent", color: C.dm, fontSize: 10, cursor: "pointer", fontWeight: 700,
                        }}>✕</button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>)}

        {/* ═══ LOG TAB ═══ */}
        {tab === "log" && (<>
          {st.trades > 0 && (
            <div style={{ padding: 14, background: C.cd, borderRadius: 10, marginBottom: 14, border: `1px solid ${C.bd}` }}>
              <div style={{ fontSize: 9, color: C.dm, letterSpacing: 2, fontWeight: 700, marginBottom: 10 }}>PERFORMANCE</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                <div><div style={{ fontSize: 8, color: C.dm }}>REALIZED</div><div style={{ fontSize: 14, fontWeight: 800, color: st.pnl >= 0 ? C.g : C.r }}>{usd(st.pnl)}</div></div>
                <div><div style={{ fontSize: 8, color: C.dm }}>WIN RATE</div><div style={{ fontSize: 14, fontWeight: 800, color: wr >= 50 ? C.g : C.r }}>{f0(wr)}%</div></div>
                <div><div style={{ fontSize: 8, color: C.dm }}>TRADES</div><div style={{ fontSize: 14, fontWeight: 800 }}>{st.trades}</div></div>
              </div>
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <span style={{ fontSize: 9, color: C.dm, letterSpacing: 2, fontWeight: 700 }}>TRADE LOG ({log.length})</span>
            <button onClick={() => { setLog([]); setSt({ trades: 0, wins: 0, pnl: 0, scans: 0 }); }} style={{
              padding: "4px 10px", borderRadius: 4, border: `1px solid ${C.bd}`, background: "transparent",
              color: C.dm, fontSize: 9, cursor: "pointer",
            }}>CLEAR</button>
          </div>
          {log.slice(0, 50).map((l, i) => (
            <div key={i} style={{ padding: "6px 10px", marginBottom: 2, background: C.cd, borderRadius: 4, fontSize: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>
                  <span style={{ color: l.type === "OPEN" ? C.g : C.r, fontWeight: 700 }}>{l.type}</span>
                  {" "}<Pill color={stratColor[l.strat] || C.dm}>{stratLabel[l.strat] || "?"}</Pill>
                  {l.ticker?.slice(0, 20)} • {l.side?.toUpperCase()} {l.qty}× @ {f0((l.price || 0) * 100)}¢
                </span>
                <span style={{ color: C.dm, fontSize: 8 }}>{new Date(l.time).toLocaleTimeString()}</span>
              </div>
              {l.reason && <div style={{ fontSize: 8, color: C.dm, marginTop: 1 }}>{l.reason.slice(0, 80)}</div>}
            </div>
          ))}
        </>)}

        {/* ═══ SETTINGS TAB ═══ */}
        {tab === "settings" && (<>
          {/* Connection */}
          <div style={{ padding: 14, background: C.cd, borderRadius: 10, marginBottom: 16, border: `1px solid ${connected ? C.g + "40" : C.y + "30"}` }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: connected ? C.g : C.y, marginBottom: 8 }}>
              {connected ? "✓ Kalshi Connected" : "Link Your Kalshi Account"}
            </div>
            {connected ? (
              <div style={{ fontSize: 11 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: C.dm }}>Balance</span>
                  <span style={{ fontWeight: 800, color: C.g }}>{usd((bal || 0) / 100)}</span>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 10, color: C.dm, lineHeight: 1.9 }}>
                {authErr ? (
                  <div>
                    <div style={{ color: C.r, fontWeight: 700, marginBottom: 4 }}>Error: {authErr.message || authErr.error}</div>
                    <button onClick={() => {
                      setAuthErr(null);
                      authReq("/portfolio/balance").then(d => {
                        if (d && !d.noKeys && !d.error && d.balance != null) { setConnected(true); setBal(d.balance); }
                        else if (d?.error) setAuthErr(d);
                        setAuthChecked(true);
                      });
                    }} style={{ padding: "6px 14px", borderRadius: 6, border: `1px solid ${C.b}`, background: "transparent", color: C.b, fontSize: 10, cursor: "pointer", fontWeight: 700 }}>RETRY</button>
                  </div>
                ) : "Set env vars in Vercel: NEXT_PUBLIC_KALSHI_API_KEY_ID, KALSHI_PRIVATE_KEY, NEXT_PUBLIC_KALSHI_ENV=prod"}
              </div>
            )}
          </div>

          {/* Strategy toggles */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 9, fontWeight: 800, color: C.dm, letterSpacing: 2, marginBottom: 12 }}>STRATEGIES</div>
            {[
              { k: "wxOn", l: "☁ Weather Edge", d: "NWS ensemble forecast vs market price" },
              { k: "flbOn", l: "📊 Favorite-Longshot", d: "Buy favorites >82¢, fade longshots <18¢" },
              { k: "arbOn", l: "🔄 ME-Arbitrage", d: "Mutually exclusive event mispricing" },
              { k: "volOn", l: "📈 Volume Spike", d: "24h vol > 3× open interest = smart money" },
              { k: "spreadOn", l: "💎 Spread Fade", d: "Wide bid-ask gap limit orders" },
              { k: "econOn", l: "💰 Econ Edge", d: "Economic data markets scanner" },
            ].map(s => (
              <div key={s.k} onClick={() => up(s.k, !cfg[s.k])} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "10px 12px", marginBottom: 4, background: C.cd, borderRadius: 8, cursor: "pointer",
              }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700 }}>{s.l}</div>
                  <div style={{ fontSize: 9, color: C.dm }}>{s.d}</div>
                </div>
                <div style={{
                  width: 36, height: 20, borderRadius: 10, padding: 2,
                  background: cfg[s.k] ? C.g : C.bd, transition: "0.2s",
                }}>
                  <div style={{
                    width: 16, height: 16, borderRadius: 8, background: "#fff",
                    transform: cfg[s.k] ? "translateX(16px)" : "translateX(0)",
                    transition: "0.2s",
                  }} />
                </div>
              </div>
            ))}
          </div>

          {/* Sliders */}
          {[
            { hd: "ENTRY RULES", items: [
              { k: "bet", l: "Bet Size", u: "$", mn: 1, mx: 200, s: 1, help: "How much per trade" },
              { k: "minEdge", l: "Min Edge", u: "¢", mn: 1, mx: 25, s: 1, help: "Minimum edge to consider" },
              { k: "minConfidence", l: "Min Confidence", u: "", mn: 0, mx: 1, s: 0.1, help: "0=all signals, 1=only highest confidence" },
              { k: "pMin", l: "Price Floor", u: "¢", mn: 1, mx: 50, s: 1, help: "Skip cheap longshots" },
              { k: "pMax", l: "Price Ceiling", u: "¢", mn: 50, mx: 99, s: 1, help: "Skip expensive contracts" },
            ]},
            { hd: "EXIT & BOT", items: [
              { k: "tp", l: "Take Profit", u: "¢", mn: 2, mx: 40, s: 1 },
              { k: "sl", l: "Stop Loss", u: "¢", mn: 2, mx: 40, s: 1 },
              { k: "maxPos", l: "Max Positions", u: "", mn: 1, mx: 20, s: 1 },
              { k: "interval", l: "Scan Interval", u: "s", mn: 60, mx: 600, s: 30 },
            ]},
          ].map(gr => (
            <div key={gr.hd} style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 9, fontWeight: 800, color: C.dm, letterSpacing: 2, marginBottom: 12 }}>{gr.hd}</div>
              {gr.items.map(f => (
                <div key={f.k} style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                    <span style={{ fontSize: 11, color: "#94a3b8" }}>{f.l}</span>
                    <span style={{ fontSize: 13, fontWeight: 800 }}>{typeof cfg[f.k] === "number" ? (f.s < 1 ? cfg[f.k].toFixed(1) : cfg[f.k]) : cfg[f.k]}{f.u}</span>
                  </div>
                  <input type="range" min={f.mn} max={f.mx} step={f.s} value={cfg[f.k]}
                    onChange={e => up(f.k, Number(e.target.value))}
                    style={{ width: "100%", accentColor: C.b }} />
                  {f.help && <div style={{ fontSize: 8, color: C.dm, marginTop: 1 }}>{f.help}</div>}
                </div>
              ))}
            </div>
          ))}

          {/* Auto-trade toggle */}
          <div onClick={() => up("auto", !cfg.auto)} style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "12px", background: cfg.auto ? C.r + "15" : C.cd, borderRadius: 8, cursor: "pointer",
            border: cfg.auto ? `1px solid ${C.r}40` : `1px solid ${C.bd}`,
          }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 800, color: cfg.auto ? C.r : C.tx }}>Auto-Execute Trades</div>
              <div style={{ fontSize: 9, color: C.dm }}>Bot will automatically buy signals meeting all criteria</div>
            </div>
            <div style={{
              width: 36, height: 20, borderRadius: 10, padding: 2,
              background: cfg.auto ? C.r : C.bd,
            }}>
              <div style={{
                width: 16, height: 16, borderRadius: 8, background: "#fff",
                transform: cfg.auto ? "translateX(16px)" : "translateX(0)", transition: "0.2s",
              }} />
            </div>
          </div>
        </>)}
      </div>
    </div>
  </>);
}