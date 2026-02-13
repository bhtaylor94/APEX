import BotControlPanel from "../components/BotControlPanel";
// pages/index.js — Apex BTC Bot Dashboard
import { useState, useEffect, useCallback, useRef } from "react";
import Head from "next/head";

// ── Client-side signal engine (mirrors lib/btc-engine.js) ──
const E = {
  sma: (d, p) => d.length < p ? null : d.slice(-p).reduce((s, v) => s + v, 0) / p,
  ema: (d, p) => {
    if (d.length < p) return null;
    const k = 2 / (p + 1);
    let e = d.slice(0, p).reduce((s, v) => s + v, 0) / p;
    for (let i = p; i < d.length; i++) e = d[i] * k + e * (1 - k);
    return e;
  },
  rsi: (c, p = 14) => {
    if (c.length < p + 1) return 50;
    const ch = []; for (let i = 1; i < c.length; i++) ch.push(c[i] - c[i - 1]);
    const r = ch.slice(-p); let g = 0, l = 0;
    for (const x of r) { if (x > 0) g += x; else l += Math.abs(x); }
    if (l === 0) return 100;
    return 100 - 100 / (1 + g / p / (l / p));
  },
  macd: (c) => {
    const e12 = E.ema(c, 12), e26 = E.ema(c, 26);
    if (!e12 || !e26) return { macd: 0, signal: 0, histogram: 0 };
    const ml = e12 - e26, mH = [];
    const k12 = 2 / 13, k26 = 2 / 27;
    let a = c.slice(0, 12).reduce((s, v) => s + v, 0) / 12;
    let b = c.slice(0, 26).reduce((s, v) => s + v, 0) / 26;
    for (let i = 26; i < c.length; i++) { a = c[i] * k12 + a * (1 - k12); b = c[i] * k26 + b * (1 - k26); mH.push(a - b); }
    const sig = mH.length >= 9 ? E.ema(mH, 9) : ml;
    return { macd: ml, signal: sig || 0, histogram: ml - (sig || 0) };
  },
  mom: (c, p = 10) => c.length < p + 1 ? 0 : ((c[c.length - 1] - c[c.length - 1 - p]) / c[c.length - 1 - p]) * 100,
  bb: (c, p = 20, m = 2) => {
    if (c.length < p) return null;
    const avg = E.sma(c, p), sl = c.slice(-p);
    const std = Math.sqrt(sl.reduce((s, v) => s + (v - avg) ** 2, 0) / p);
    return { upper: avg + m * std, middle: avg, lower: avg - m * std, percentB: (c[c.length - 1] - (avg - m * std)) / (m * 2 * std) };
  },
  vwm: (k, p = 10) => {
    if (k.length < p) return 0;
    const r = k.slice(-p); let ws = 0, tv = 0;
    for (let i = 1; i < r.length; i++) { ws += ((r[i].close - r[i - 1].close) / r[i - 1].close) * r[i].volume; tv += r[i].volume; }
    return tv > 0 ? (ws / tv) * 100 : 0;
  },
  signals: (klines) => {
    if (!klines || klines.length < 30) return { direction: "neutral", confidence: 0, compositeScore: 0, signals: {} };
    const c = klines.map(k => k.close), p = c[c.length - 1];
    const rsi = E.rsi(c, 14), macd = E.macd(c), mom5 = E.mom(c, 5), bb = E.bb(c, 20, 2), vwm = E.vwm(klines, 10), s5 = E.sma(c, 5), s20 = E.sma(c, 20);
    const sc = {};
    sc.rsi = rsi > 75 ? -0.8 : rsi > 65 ? -0.3 : rsi < 25 ? 0.8 : rsi < 35 ? 0.3 : 0;
    sc.macd = macd.histogram > 0 && macd.macd > macd.signal ? 0.6 : macd.histogram < 0 && macd.macd < macd.signal ? -0.6 : macd.histogram > 0 ? 0.2 : -0.2;
    sc.momentum = mom5 > 0.3 ? 0.7 : mom5 > 0.1 ? 0.3 : mom5 < -0.3 ? -0.7 : mom5 < -0.1 ? -0.3 : 0;
    sc.bb = bb ? (bb.percentB > 1 ? -0.8 : bb.percentB > 0.8 ? -0.4 : bb.percentB < 0 ? 0.8 : bb.percentB < 0.2 ? 0.4 : 0) : 0;
    sc.vwm = vwm > 0.2 ? 0.5 : vwm < -0.2 ? -0.5 : 0;
    sc.maCross = s5 && s20 ? ((s5 - s20) / s20 > 0.001 ? 0.4 : (s5 - s20) / s20 < -0.001 ? -0.4 : 0) : 0;
    const w = { rsi: 0.2, macd: 0.2, momentum: 0.25, bb: 0.15, vwm: 0.1, maCross: 0.1 };
    let comp = 0; for (const [k, s] of Object.entries(sc)) comp += s * (w[k] || 0);
    const dir = comp > 0.15 ? "up" : comp < -0.15 ? "down" : "neutral";
    const conf = Math.min(Math.abs(comp) / 0.6, 1);
    return {
      direction: dir, confidence: conf, compositeScore: comp, currentPrice: p,
      signals: { rsi: { value: rsi, score: sc.rsi }, macd: { value: macd, score: sc.macd }, momentum: { value: mom5, score: sc.momentum }, bb: { value: bb, score: sc.bb }, vwm: { value: vwm, score: sc.vwm }, maCross: { value: s5 && s20 ? { s5, s20 } : null, score: sc.maCross } },
    };
  },
};

// ── Helpers ──
const fmt = (cents) => { const d = cents / 100; return d >= 0 ? `$${d.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `-$${Math.abs(d).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; };
const fmtUSD = (n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ── Sparkline ──
function PriceChart({ klines }) {
  if (!klines || klines.length < 2) return null;
  const closes = klines.slice(-60).map(k => k.close);
  const min = Math.min(...closes), max = Math.max(...closes), range = max - min || 1;
  const h = 80, w = 300;
  const pts = closes.map((c, i) => `${(i / (closes.length - 1)) * w},${h - ((c - min) / range) * h}`).join(" ");
  const color = closes[closes.length - 1] >= closes[0] ? "var(--green)" : "var(--red)";
  return (
    <svg width={w} height={h + 10} viewBox={`0 -5 ${w} ${h + 10}`} style={{ overflow: "visible" }}>
      <defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity="0.15" /><stop offset="100%" stopColor={color} stopOpacity="0" /></linearGradient></defs>
      <polygon points={`0,${h} ${pts} ${w},${h}`} fill="url(#cg)" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
      <circle cx={w} cy={parseFloat(pts.split(" ").pop().split(",")[1])} r="3" fill={color} />
    </svg>
  );
}

// ── Signal Gauge ──
function Gauge({ label, value, score, format }) {
  const color = score > 0.3 ? "var(--green)" : score < -0.3 ? "var(--red)" : "var(--yellow)";
  return (
    <div style={{ padding: "10px 12px", background: "var(--surface)", borderRadius: "8px", border: "1px solid var(--border)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "5px" }}>
        <span style={{ fontSize: "10px", color: "var(--dim)", textTransform: "uppercase", letterSpacing: "0.5px" }}>{label}</span>
        <span style={{ fontSize: "12px", color, fontWeight: 700 }}>{format ? format(value) : typeof value === "number" ? value.toFixed(1) : "--"}</span>
      <BotControlPanel /></div>
      <div style={{ height: "3px", background: "var(--border)", borderRadius: "2px", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${((score + 1) / 2) * 100}%`, background: color, borderRadius: "2px", transition: "width 0.3s" }} />
      </div>
    </div>
  );
}

// ── Trade Entry ──
function TradeEntry({ trade, i }) {
  const isWin = trade.profit > 0;
  const isPending = trade.status === "open" || trade.status === "submitted";
  const borderColor = isPending ? "var(--blue)" : isWin ? "var(--green)" : "var(--red)";
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px",
      background: "linear-gradient(135deg, #0d0d0f 0%, #141418 100%)", borderLeft: `3px solid ${borderColor}`,
      borderRadius: "8px", animation: `slideIn 0.3s ease ${i * 0.05}s both`,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{trade.title || trade.ticker}</div>
        <div style={{ display: "flex", gap: "6px", marginTop: "3px", flexWrap: "wrap" }}>
          <span style={{ fontSize: "10px", fontWeight: 700, padding: "1px 6px", borderRadius: "3px", background: trade.side === "yes" ? "rgba(52,211,153,0.12)" : "rgba(248,113,113,0.12)", color: trade.side === "yes" ? "var(--green)" : "var(--red)", textTransform: "uppercase" }}>{trade.side}</span>
          <span style={{ fontSize: "10px", color: "var(--muted)" }}>{trade.count}x @ {trade.price}¢</span>
          <span style={{ fontSize: "10px", color: "var(--muted)" }}>{trade.reason}</span>
        </div>
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div style={{ fontSize: "13px", fontWeight: 700, color: isPending ? "var(--blue)" : isWin ? "var(--green)" : "var(--red)" }}>
          {isPending ? trade.status.toUpperCase() : fmt(trade.profit || 0)}
        </div>
        <div style={{ fontSize: "9px", color: "var(--muted)" }}>{new Date(trade.timestamp).toLocaleTimeString()}</div>
      </div>
    </div>
  );
}

// ── Main Dashboard ──
export default function Dashboard() {
  const [botActive, setBotActive] = useState(false);
  const [btcData, setBtcData] = useState(null);
  const [klines, setKlines] = useState([]);
  const [signal, setSignal] = useState(null);
  const [trades, setTrades] = useState([]);
  const [markets, setMarkets] = useState([]);
  const [balance, setBalance] = useState(null);
  const [positions, setPositions] = useState([]);
  const [settlements, setSettlements] = useState([]);
  const [connected, setConnected] = useState(false);
  const [config, setConfig] = useState({
    minConfidence: 45, minEdge: 5, maxContracts: 50, maxCostPerTrade: 5000, maxTradesPerHour: 10,
  });
  const [logs, setLogs] = useState([]);
  const [scanCount, setScanCount] = useState(0);
  const intervalRef = useRef(null);
  const tradeHistoryRef = useRef([]);

  const addLog = useCallback((msg, type = "info") => {
    setLogs(prev => [{ msg, type, ts: Date.now() }, ...prev].slice(0, 300));
  }, []);

  // ── Data fetchers (all go through API routes) ──

  const fetchBTC = useCallback(async () => {
    try {
      const res = await fetch("/api/btc-price?interval=1m&limit=100");
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setBtcData({ price: data.price, priceChange: data.priceChange, priceChangePct: data.priceChangePct, volume24h: data.volume24h, high24h: data.high24h, low24h: data.low24h });
      setKlines(data.klines);
      const sig = E.signals(data.klines);
      setSignal(sig);
      return { klines: data.klines, signal: sig };
    } catch (e) {
      addLog(`BTC fetch error: ${e.message}`, "error");
      return null;
    }
  }, [addLog]);

  const fetchBalance = useCallback(async () => {
    try {
      const res = await fetch("/api/kalshi/balance");
      const data = await res.json();
      if (data.error === "no_keys") { setConnected(false); return; }
      if (data.error) throw new Error(data.error);
      setBalance(data);
      setConnected(true);
    } catch (e) {
      addLog(`Balance error: ${e.message}`, "error");
      setConnected(false);
    }
  }, [addLog]);

  const fetchMarkets = useCallback(async () => {
    try {
      // Search multiple BTC series
      const allMarkets = [];
      const seriesTickers = ["KXBTCUD", "KXBTCUDR", "KXBTC15"];

      for (const st of seriesTickers) {
        try {
          const res = await fetch(`/api/kalshi/markets?series_ticker=${st}&status=open&limit=20`);
          const data = await res.json();
          const ms = Array.isArray(data?.markets) ? data.markets : [];
          if (ms.length) allMarkets.push(...ms);
        } catch { /* skip */ }
      }

      // Also do a broad search for any open BTC markets
      try {
        const res = await fetch("/api/kalshi/markets?status=open&limit=100");
        const data = await res.json();
        const all = Array.isArray(data?.markets) ? data.markets : [];
        const btcOnes = all.filter(m => {
          const t = (m.title || "").toLowerCase();
          return (t.includes("bitcoin") || t.includes("btc")) && (t.includes("up or down") || t.includes("above") || t.includes("price today") || t.includes("price range"));
        });
        for (const m of btcOnes) {
          if (!allMarkets.find(x => x.ticker === m.ticker)) allMarkets.push(m);
        }
      } catch { /* skip */ }

      setMarkets(allMarkets);
      return allMarkets;
    } catch (e) {
      addLog(`Markets error: ${e.message}`, "error");
      return [];
    }
  }, [addLog]);

  const fetchPositions = useCallback(async () => {
    try {
      const res = await fetch("/api/kalshi/positions");
      const data = await res.json();
      setPositions(data.market_positions || []);
    } catch { /* skip */ }
  }, []);

  const fetchSettlements = useCallback(async () => {
    try {
      const res = await fetch("/api/kalshi/settlements?limit=50");
      const data = await res.json();
      setSettlements(data.settlements || []);
    } catch { /* skip */ }
  }, []);

  // ── Order execution ──
  const placeOrder = useCallback(async (ticker, side, count, price) => {
    try {
      const body = {
        ticker, side, action: "buy", count, type: "limit",
        [side === "yes" ? "yes_price" : "no_price"]: price,
      };
      const res = await fetch("/api/kalshi/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      return data;
    } catch (e) {
      addLog(`Order failed: ${e.message}`, "error");
      throw e;
    }
  }, [addLog]);

  // ── Bot scan cycle ──
  const runScan = useCallback(async () => {
    if (!botActive) return;

    addLog("Scanning...", "info");
    const btcResult = await fetchBTC();
    if (!btcResult) return;

    const { signal: sig } = btcResult;
    const mkts = await fetchMarkets();
    await fetchPositions();
    await fetchSettlements();
    await fetchBalance();

    setScanCount(c => c + 1);

    if (sig.direction === "neutral") {
      addLog(`NEUTRAL (score: ${sig.compositeScore.toFixed(3)}) — no trade`, "info");
      return;
    }

    addLog(
      `Signal: ${sig.direction.toUpperCase()} (${Math.round(sig.confidence * 100)}% conf, score: ${sig.compositeScore.toFixed(3)})`,
      sig.confidence > 0.5 ? "success" : "info"
    );

    // Rate limit check
    const hourAgo = Date.now() - 3600000;
    const recentCount = tradeHistoryRef.current.filter(t => t.timestamp > hourAgo).length;
    if (recentCount >= config.maxTradesPerHour) {
      addLog("Hourly trade limit reached", "warn");
      return;
    }

    // Evaluate each market for opportunities
    for (const market of mkts) {
      const title = (market.title || "").toLowerCase();
      const isUpDown = title.includes("up or down") || title.includes("up/down");
      if (!isUpDown) continue; // Focus on up/down markets

      const baseProbability = 0.5 + sig.confidence * 0.35;
      let side, marketPrice;

      if (sig.direction === "up") {
        side = "yes";
        marketPrice = market.yes_ask || market.last_price || 50;
      } else {
        side = "no";
        marketPrice = market.no_ask || (100 - (market.last_price || 50));
      }

      // Skip if no valid price
      if (!marketPrice || marketPrice <= 0 || marketPrice >= 99) continue;

      const predictedProb = Math.round(baseProbability * 100);
      const edge = predictedProb - marketPrice;

      if (edge < config.minEdge) {
        addLog(`${market.ticker}: edge ${edge}¢ < ${config.minEdge}¢`, "info");
        continue;
      }

      if (sig.confidence * 100 < config.minConfidence) continue;

      // Cooldown check — don't trade same ticker within 60s
      const lastOnTicker = tradeHistoryRef.current.find(
        t => t.ticker === market.ticker && Date.now() - t.timestamp < 60000
      );
      if (lastOnTicker) {
        addLog(`${market.ticker}: cooldown active`, "info");
        continue;
      }

      // Quarter-Kelly sizing
      const p = baseProbability;
      const kelly = (p * (100 - marketPrice) - (1 - p) * marketPrice) / (100 - marketPrice);
      const contracts = Math.min(
        Math.max(1, Math.floor(kelly * 0.25 * 100)),
        config.maxContracts,
        Math.floor(config.maxCostPerTrade / marketPrice)
      );

      if (contracts < 1) continue;

      addLog(`TRADE: ${side.toUpperCase()} ${contracts}x ${market.ticker} @ ${marketPrice}¢ (edge: ${edge}¢)`, "trade");

      const trade = {
        ticker: market.ticker,
        title: market.title,
        side, count: contracts, price: marketPrice, edge,
        confidence: Math.round(sig.confidence * 100),
        reason: `${sig.direction.toUpperCase()} ${edge}¢ edge`,
        timestamp: Date.now(),
        status: "submitting",
        profit: 0,
      };

      // Execute the order
      try {
        const result = await placeOrder(market.ticker, side, contracts, marketPrice);
        trade.orderId = result.order?.order_id;
        trade.status = result.order?.status || "submitted";
        addLog(`Order filled: ${result.order?.order_id} (${result.order?.status})`, "success");
      } catch (e) {
        trade.status = "failed";
        trade.error = e.message;
      }

      tradeHistoryRef.current = [trade, ...tradeHistoryRef.current];
      setTrades(prev => [trade, ...prev]);

      // Only one trade per scan cycle to be conservative
      break;
    }
  }, [botActive, fetchBTC, fetchMarkets, fetchPositions, fetchSettlements, fetchBalance, placeOrder, config, addLog]);

  // ── Effects ──

  // Initial load
  useEffect(() => {
    fetchBTC();
    fetchBalance();
    fetchMarkets();
    fetchPositions();
    fetchSettlements();
  }, []);

  // BTC price refresh every 10s
  useEffect(() => {
    const id = setInterval(fetchBTC, 10000);
    return () => clearInterval(id);
  }, [fetchBTC]);

  // Bot loop — scan every 30s when active
  useEffect(() => {
    if (botActive) {
      addLog("Bot ACTIVATED — scanning every 30s", "success");
      runScan();
      intervalRef.current = setInterval(runScan, 30000);
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
        addLog("Bot STOPPED", "warn");
      }
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [botActive]);

  // ── Computed ──
  const totalPnL = settlements.reduce((sum, s) => {
    const cost = s.yes_count > 0 ? s.yes_total_cost : s.no_total_cost;
    return sum + (s.revenue - cost);
  }, 0);

  const env = process.env.NEXT_PUBLIC_KALSHI_ENV || "prod";

  return (
    <>
      <Head><title>Apex BTC Bot — Kalshi Autonomous Trader</title></Head>
      <div style={{ minHeight: "100vh" }}>

        {/* ── Header ── */}
        <div style={{
          borderBottom: "1px solid var(--border)", padding: "12px 24px",
          background: "rgba(6,6,8,0.95)", backdropFilter: "blur(20px)", position: "sticky", top: 0, zIndex: 50,
        }}>
          <div style={{ maxWidth: "1200px", margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
              <span style={{ fontSize: "18px", fontWeight: 900, letterSpacing: "-0.5px", background: "linear-gradient(135deg, #818cf8, #34d399)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                APEX BTC BOT
              </span>

              <button onClick={() => setBotActive(!botActive)} style={{
                padding: "6px 16px", borderRadius: "8px", border: "none", cursor: "pointer",
                fontSize: "12px", fontWeight: 700, letterSpacing: "0.5px",
                background: botActive ? "linear-gradient(135deg, #dc2626, #ef4444)" : "linear-gradient(135deg, #059669, #34d399)",
                color: "#fff", transition: "all 0.2s", animation: botActive ? "glow 2s infinite" : "none",
              }}>
                {botActive ? "STOP BOT" : "START BOT"}
              </button>

              {botActive && (
                <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                  <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: "var(--green)", animation: "pulse 1s infinite" }} />
                  <span style={{ fontSize: "11px", color: "var(--green)", fontWeight: 600 }}>LIVE</span>
                </div>
              )}

              {connected ? (
                <div style={{ display: "flex", alignItems: "center", gap: "5px", padding: "3px 8px", background: "rgba(52,211,153,0.08)", borderRadius: "6px", border: "1px solid rgba(52,211,153,0.15)" }}>
                  <div style={{ width: "5px", height: "5px", borderRadius: "50%", background: "var(--green)" }} />
                  <span style={{ fontSize: "10px", color: "var(--green)", fontWeight: 600 }}>CONNECTED</span>
                </div>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: "5px", padding: "3px 8px", background: "rgba(248,113,113,0.08)", borderRadius: "6px", border: "1px solid rgba(248,113,113,0.15)" }}>
                  <span style={{ fontSize: "10px", color: "var(--red)", fontWeight: 600 }}>NO API KEYS</span>
                </div>
              )}

              <span style={{ fontSize: "10px", color: env === "prod" ? "var(--red)" : "var(--yellow)", fontWeight: 700, padding: "2px 6px", background: env === "prod" ? "rgba(248,113,113,0.08)" : "rgba(251,191,36,0.08)", borderRadius: "4px" }}>
                {env.toUpperCase()}
              </span>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "20px" }}>
              {btcData && (
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: "18px", fontWeight: 800 }}>{fmtUSD(btcData.price)}</div>
                  <div style={{ fontSize: "11px", color: btcData.priceChangePct >= 0 ? "var(--green)" : "var(--red)", fontWeight: 600 }}>
                    {btcData.priceChangePct >= 0 ? "+" : ""}{btcData.priceChangePct.toFixed(2)}%
                  </div>
                </div>
              )}
              {balance && connected && (
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: "10px", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.5px" }}>Balance</div>
                  <div style={{ fontSize: "14px", fontWeight: 700, color: "var(--green)" }}>{fmt(balance.balance)}</div>
                </div>
              )}
              <div style={{ fontSize: "10px", color: "var(--muted)", textAlign: "right" }}>
                <div>Scans: {scanCount}</div>
                <div>Trades: {trades.length}</div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Content ── */}
        <div style={{ maxWidth: "1200px", margin: "0 auto", padding: "20px 24px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 320px", gap: "14px" }}>

            {/* ── Col 1: BTC Price + Signals ── */}
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <div style={{ background: "var(--surface)", borderRadius: "12px", border: "1px solid var(--border)", padding: "16px" }}>
                <div style={{ fontSize: "10px", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "1px", marginBottom: "8px" }}>BTC/USDT — 1m</div>
                <PriceChart klines={klines} />
                {btcData && (
                  <div style={{ display: "flex", gap: "14px", marginTop: "8px", fontSize: "10px", color: "var(--dim)" }}>
                    <span>H: {fmtUSD(btcData.high24h)}</span>
                    <span>L: {fmtUSD(btcData.low24h)}</span>
                    <span>Vol: {btcData.volume24h.toFixed(0)} BTC</span>
                  </div>
                )}
              </div>

              <div style={{ background: "var(--surface)", borderRadius: "12px", border: "1px solid var(--border)", padding: "16px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                  <span style={{ fontSize: "10px", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "1px" }}>Signal Engine</span>
                  {signal && (
                    <span style={{ fontSize: "12px", fontWeight: 800, padding: "3px 10px", borderRadius: "6px", background: signal.direction === "up" ? "rgba(52,211,153,0.12)" : signal.direction === "down" ? "rgba(248,113,113,0.12)" : "rgba(255,255,255,0.04)", color: signal.direction === "up" ? "var(--green)" : signal.direction === "down" ? "var(--red)" : "var(--dim)" }}>
                      {signal.direction.toUpperCase()} {Math.round(signal.confidence * 100)}%
                    </span>
                  )}
                </div>
                {signal?.signals && (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                    <Gauge label="RSI" value={signal.signals.rsi?.value} score={signal.signals.rsi?.score || 0} format={v => v?.toFixed(1)} />
                    <Gauge label="MACD" value={signal.signals.macd?.value?.histogram} score={signal.signals.macd?.score || 0} format={v => v?.toFixed(2)} />
                    <Gauge label="Momentum" value={signal.signals.momentum?.value} score={signal.signals.momentum?.score || 0} format={v => `${v?.toFixed(2)}%`} />
                    <Gauge label="Bollinger" value={signal.signals.bb?.value?.percentB} score={signal.signals.bb?.score || 0} format={v => v?.toFixed(2)} />
                    <Gauge label="Vol Momentum" value={signal.signals.vwm?.value} score={signal.signals.vwm?.score || 0} format={v => v?.toFixed(3)} />
                    <Gauge label="MA Cross" value={null} score={signal.signals.maCross?.score || 0} format={() => signal.signals.maCross?.score > 0 ? "Bullish" : signal.signals.maCross?.score < 0 ? "Bearish" : "Flat"} />
                  </div>
                )}
                {signal && (
                  <div style={{ marginTop: "10px", padding: "8px 10px", background: "rgba(255,255,255,0.02)", borderRadius: "6px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                      <span style={{ fontSize: "10px", color: "var(--dim)" }}>Composite</span>
                      <span style={{ fontSize: "12px", fontWeight: 700 }}>{signal.compositeScore.toFixed(3)}</span>
                    </div>
                    <div style={{ height: "5px", background: "var(--border)", borderRadius: "3px", position: "relative" }}>
                      <div style={{ position: "absolute", height: "100%", borderRadius: "3px", transition: "all 0.3s", left: "50%", width: `${Math.abs(signal.compositeScore) / 0.6 * 50}%`, transform: signal.compositeScore < 0 ? "translateX(-100%)" : "none", background: signal.compositeScore > 0 ? "var(--green)" : "var(--red)" }} />
                      <div style={{ position: "absolute", left: "50%", top: "-1px", width: "1px", height: "7px", background: "var(--muted)" }} />
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* ── Col 2: Markets + Trades + Settlements ── */}
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <div style={{ background: "var(--surface)", borderRadius: "12px", border: "1px solid var(--border)", padding: "16px" }}>
                <div style={{ fontSize: "10px", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "1px", marginBottom: "8px" }}>BTC Markets ({markets.length})</div>
                <div style={{ maxHeight: "160px", overflow: "auto" }}>
                  {markets.length === 0 && <div style={{ fontSize: "11px", color: "var(--dark)", padding: "16px 0", textAlign: "center" }}>No open BTC markets found</div>}
                  {markets.slice(0, 12).map((m, i) => (
                    <div key={m.ticker} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: i < Math.min(markets.length, 12) - 1 ? "1px solid rgba(255,255,255,0.03)" : "none" }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: "11px", color: "#94a3b8", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.title || m.ticker}</div>
                        <div style={{ fontSize: "9px", color: "var(--dark)" }}>{m.ticker}</div>
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        <div style={{ fontSize: "12px", fontWeight: 700 }}>{m.yes_bid || m.last_price || "--"}¢</div>
                        <div style={{ fontSize: "9px", color: "var(--muted)" }}>vol: {m.volume || 0}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Open Positions */}
              {positions.length > 0 && (
                <div style={{ background: "var(--surface)", borderRadius: "12px", border: "1px solid var(--border)", padding: "16px" }}>
                  <div style={{ fontSize: "10px", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "1px", marginBottom: "8px" }}>Open Positions ({positions.length})</div>
                  <div style={{ maxHeight: "120px", overflow: "auto" }}>
                    {positions.map((p, i) => (
                      <div key={p.ticker || i} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid rgba(255,255,255,0.02)", fontSize: "11px" }}>
                        <span style={{ color: "#94a3b8" }}>{p.ticker}</span>
                        <span style={{ color: "var(--text)", fontWeight: 600 }}>{p.position} contracts</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Trade history */}
              <div style={{ background: "var(--surface)", borderRadius: "12px", border: "1px solid var(--border)", padding: "16px", flex: 1 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
                  <span style={{ fontSize: "10px", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "1px" }}>Bot Trades ({trades.length})</span>
                  {settlements.length > 0 && (
                    <span style={{ fontSize: "11px", fontWeight: 700, color: totalPnL >= 0 ? "var(--green)" : "var(--red)" }}>
                      Settled P&L: {totalPnL >= 0 ? "+" : ""}{fmt(totalPnL)}
                    </span>
                  )}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "5px", maxHeight: "250px", overflow: "auto" }}>
                  {trades.length === 0 && (
                    <div style={{ fontSize: "11px", color: "var(--dark)", padding: "24px 0", textAlign: "center" }}>
                      {botActive ? "Waiting for signals..." : "Start the bot to begin trading"}
                    </div>
                  )}
                  {trades.map((t, i) => <TradeEntry key={`${t.ticker}-${t.timestamp}`} trade={t} i={i} />)}
                </div>
              </div>
            </div>

            {/* ── Col 3: Config + Log ── */}
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <div style={{ background: "var(--surface)", borderRadius: "12px", border: "1px solid var(--border)", padding: "16px" }}>
                <div style={{ fontSize: "10px", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "1px", marginBottom: "10px" }}>Configuration</div>
                {[
                  { key: "minConfidence", label: "Min Confidence", unit: "%", min: 10, max: 90, step: 5 },
                  { key: "minEdge", label: "Min Edge", unit: "¢", min: 1, max: 20, step: 1 },
                  { key: "maxContracts", label: "Max Contracts", unit: "", min: 1, max: 200, step: 5 },
                  { key: "maxCostPerTrade", label: "Max Cost/Trade", unit: "", min: 500, max: 50000, step: 500, fmt: v => fmt(v) },
                  { key: "maxTradesPerHour", label: "Max Trades/Hr", unit: "", min: 1, max: 50, step: 1 },
                ].map(item => (
                  <div key={item.key} style={{ marginBottom: "10px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "3px" }}>
                      <span style={{ fontSize: "10px", color: "var(--dim)" }}>{item.label}</span>
                      <span style={{ fontSize: "11px", fontWeight: 600 }}>{item.fmt ? item.fmt(config[item.key]) : config[item.key]}{item.unit}</span>
                    </div>
                    <input type="range" min={item.min} max={item.max} step={item.step} value={config[item.key]}
                      onChange={e => setConfig(c => ({ ...c, [item.key]: parseInt(e.target.value) }))}
                      style={{ width: "100%", accentColor: "#818cf8", height: "4px" }} />
                  </div>
                ))}
              </div>

              <div style={{ background: "var(--surface)", borderRadius: "12px", border: "1px solid var(--border)", padding: "16px", flex: 1 }}>
                <div style={{ fontSize: "10px", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "1px", marginBottom: "6px" }}>Activity Log</div>
                <div style={{ maxHeight: "350px", overflow: "auto" }}>
                  {logs.map((log, i) => (
                    <div key={i} style={{ fontSize: "10px", padding: "2px 0", color: log.type === "error" ? "var(--red)" : log.type === "trade" ? "var(--blue)" : log.type === "success" ? "var(--green)" : log.type === "warn" ? "var(--yellow)" : "var(--muted)", borderBottom: "1px solid rgba(255,255,255,0.015)" }}>
                      <span style={{ color: "var(--dark)", marginRight: "5px" }}>{new Date(log.ts).toLocaleTimeString()}</span>
                      {log.msg}
                    </div>
                  ))}
                  {logs.length === 0 && <div style={{ fontSize: "10px", color: "var(--dark)", textAlign: "center", padding: "16px 0" }}>No activity</div>}
                </div>
              </div>
            </div>
          </div>

          {/* ── Warning banner ── */}
          <div style={{ marginTop: "16px", padding: "14px 16px", background: "rgba(251,191,36,0.04)", borderRadius: "10px", border: "1px solid rgba(251,191,36,0.1)", fontSize: "11px", color: "var(--yellow)", lineHeight: 1.6 }}>
            <strong>LIVE TRADING:</strong> This bot places real orders on Kalshi when activated. It uses fill-or-kill orders on BTC "Up or Down" 15-minute markets. Start with low Max Contracts and Max Cost/Trade settings. Monitor closely for the first few sessions. Trading involves risk of loss.
          </div>

          <div style={{ marginTop: "10px", textAlign: "center", fontSize: "10px", color: "#1e293b", letterSpacing: "1px", padding: "10px" }}>
            APEX BTC BOT · Kalshi · {new Date().getFullYear()}
          </div>
        </div>
      </div>
    </>
  );
}
