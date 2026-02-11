import { useState, useEffect, useCallback, useRef } from "react";
import Head from "next/head";

// ═══════════════════════════════════════════════════════════════
// APEX BOT — Kalshi Automated Trading Bot
// Weather + Economic markets | Persistent storage | Account linking
// ═══════════════════════════════════════════════════════════════

const PUB_API = "https://api.elections.kalshi.com/trade-api/v2";
const NWS_API = "https://api.weather.gov";

// Weather city configs
const CITIES = [
  { series: "KXHIGHNY", label: "NYC", station: "KNYC", lat: 40.7789, lon: -73.9692 },
  { series: "KXHIGHCHI", label: "CHI", station: "KORD", lat: 41.9742, lon: -87.9073 },
  { series: "KXHIGHMIA", label: "MIA", station: "KMIA", lat: 25.7959, lon: -80.287 },
  { series: "KXHIGHAUS", label: "AUS", station: "KAUS", lat: 30.1945, lon: -97.6699 },
];

// Economic market series
const ECON_SERIES = [
  { series: "KXCPI", label: "CPI" },
  { series: "KXPAYROLLS", label: "Jobs" },
  { series: "KXUNEMPLOY", label: "Unemployment" },
  { series: "KXFED", label: "Fed Rate" },
  { series: "KXGDP", label: "GDP" },
  { series: "KXPCE", label: "PCE" },
  { series: "KXTSA", label: "TSA" },
];

// ─── Helpers ──────────────────────────────────────────────────

const f1 = (n) => Number(n).toFixed(1);
const f0 = (n) => Number(n).toFixed(0);
const usd = (n) => `$${Number(n).toFixed(2)}`;
const normCDF = (x, mean, std) => {
  const z = (x - mean) / std;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const p =
    0.3989422804 *
    Math.exp((-z * z) / 2) *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
};

// ─── Storage ──────────────────────────────────────────────────

const STORE_KEY = "apex_bot_data";

function loadStore() {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveStore(data) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(data));
  } catch {}
}

// ─── API Calls ────────────────────────────────────────────────

async function pubGet(path, params = {}) {
  const u = new URL(`${PUB_API}${path}`);
  Object.entries(params).forEach(
    ([k, v]) => v != null && u.searchParams.set(k, v)
  );
  try {
    const r = await fetch(u);
    return r.ok ? r.json() : null;
  } catch {
    return null;
  }
}

async function authGet(path, method = "GET", body = null) {
  try {
    const r = await fetch("/api/kalshi", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, method, body }),
    });
    const data = await r.json();
    if (data.error === "no_keys") return { noKeys: true };
    return data;
  } catch {
    return null;
  }
}

async function nwsGet(path) {
  try {
    const r = await fetch(`${NWS_API}${path}`, {
      headers: { "User-Agent": "ApexBot/1.0" },
    });
    return r.ok ? r.json() : null;
  } catch {
    return null;
  }
}

// ─── Weather Engine ───────────────────────────────────────────

async function getForecast(city) {
  const [pt, obs] = await Promise.all([
    nwsGet(`/points/${city.lat},${city.lon}`),
    nwsGet(`/stations/${city.station}/observations/latest`),
  ]);
  let nwsHigh = null,
    hourlyMax = null,
    desc = null;
  if (pt?.properties?.forecast) {
    const fc = await nwsGet(pt.properties.forecast.replace(NWS_API, ""));
    const today = fc?.properties?.periods?.find((p) => p.isDaytime);
    nwsHigh = today?.temperature ?? null;
    desc = today?.shortForecast ?? null;
  }
  if (pt?.properties?.forecastHourly) {
    const hc = await nwsGet(pt.properties.forecastHourly.replace(NWS_API, ""));
    const dh = hc?.properties?.periods
      ?.filter((p) => p.isDaytime)
      ?.slice(0, 12);
    if (dh?.length) hourlyMax = Math.max(...dh.map((h) => h.temperature));
  }
  const cur =
    obs?.properties?.temperature?.value != null
      ? Math.round(obs.properties.temperature.value * (9 / 5) + 32)
      : null;
  const srcs = [];
  if (nwsHigh != null) srcs.push({ t: nwsHigh, w: 0.45 });
  if (hourlyMax != null) srcs.push({ t: hourlyMax, w: 0.35 });
  if (cur != null && nwsHigh != null)
    srcs.push({
      t: Math.round(cur + (nwsHigh - cur) * 0.55),
      w: 0.2,
    });
  const tw = srcs.reduce((s, x) => s + x.w, 0);
  const ensemble =
    tw > 0
      ? Math.round(srcs.reduce((s, x) => s + x.t * x.w, 0) / tw)
      : nwsHigh;
  const sigma =
    srcs.length >= 2
      ? Math.max(
          1.5,
          Math.sqrt(
            srcs.reduce((s, x) => s + (x.t - ensemble) ** 2, 0) / srcs.length
          )
        )
      : 3;
  return { ensemble, sigma, cur, nwsHigh, hourlyMax, desc };
}

// ─── Strategy Engine ──────────────────────────────────────────

function evaluateWeather(market, wx, cfg) {
  const price = (market.yes_price || market.last_price || 50) / 100;
  const vol = market.volume || 0;
  const title = market.title || "";
  if (vol < cfg.minVol || price < cfg.pMin / 100 || price > cfg.pMax / 100)
    return null;
  const m = title.match(
    /(\d+)\s*°?\s*F?\s*(or\s*(above|below|higher|lower|more|less))?/i
  );
  if (!m || !wx?.ensemble) return null;
  const thresh = parseInt(m[1]);
  const above = !/below|lower|less|under/i.test(title);
  const raw = above
    ? 1 - normCDF(thresh, wx.ensemble, wx.sigma)
    : normCDF(thresh, wx.ensemble, wx.sigma);
  const prob = Math.max(0.02, Math.min(0.98, raw));
  const edge = (prob - price) * 100;
  let side = null;
  if (edge >= cfg.minEdge) side = "yes";
  else if (edge <= -cfg.minEdge) side = "no";
  if (!side) return null;
  const cost = side === "yes" ? price : 1 - price;
  const contracts = Math.floor(cfg.bet / cost);
  if (contracts < 1) return null;
  return {
    ticker: market.ticker,
    title,
    price,
    prob,
    edge,
    side,
    contracts,
    cost: contracts * cost,
    profit: contracts * (1 - cost),
    tp: Math.min(99, Math.round(price * 100 + cfg.tp)),
    sl: Math.max(1, Math.round(price * 100 - cfg.sl)),
    vol,
    city: "",
    type: "weather",
    reason: `${wx.ensemble}°F ±${f1(wx.sigma)} vs ${thresh}°F → model ${f0(prob * 100)}% vs mkt ${f0(price * 100)}¢`,
  };
}

function evaluateEcon(market, cfg) {
  // For economic markets without a data model, we use price zone strategy:
  // Buy NO on extreme prices (>85¢) — "favorites hold" from research
  // Flag markets in sweet spot (40-60¢) for manual review
  const price = (market.yes_price || market.last_price || 50) / 100;
  const vol = market.volume || 0;
  const title = market.title || "";
  if (vol < cfg.minVol) return null;
  if (price < cfg.pMin / 100 || price > cfg.pMax / 100) return null;

  // We can't model economic events like weather, so we flag high-volume
  // markets in the tradeable range for the user
  return {
    ticker: market.ticker,
    title,
    price,
    prob: null,
    edge: null,
    side: null,
    contracts: 0,
    cost: 0,
    profit: 0,
    tp: 0,
    sl: 0,
    vol,
    city: "",
    type: "econ",
    reason: `Vol: ${vol} • Price: ${f0(price * 100)}¢ — needs manual analysis or AI model`,
  };
}

// ═══════════════════════════════════════════════════════════════
// APP
// ═══════════════════════════════════════════════════════════════

export default function ApexBot() {
  const [tab, setTab] = useState("bot");
  const [on, setOn] = useState(false);
  const [signals, setSignals] = useState([]);
  const [econMarkets, setEconMarkets] = useState([]);
  const [positions, setPositions] = useState([]);
  const [log, setLog] = useState([]);
  const [wx, setWx] = useState({});
  const [st, setSt] = useState({ trades: 0, wins: 0, pnl: 0, scans: 0 });
  const [scanning, setScanning] = useState(false);
  const [lastScan, setLastScan] = useState(null);
  const [account, setAccount] = useState(null); // { balance, portfolio }
  const [connected, setConnected] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);

  const [cfg, setCfg] = useState({
    bet: 10,
    minEdge: 5,
    pMin: 15,
    pMax: 85,
    tp: 8,
    sl: 12,
    maxPos: 5,
    minVol: 50,
    interval: 60,
    auto: false,
  });

  const upCfg = (k, v) => setCfg((c) => ({ ...c, [k]: v }));

  // ── Load persisted data on mount ──
  useEffect(() => {
    const stored = loadStore();
    if (stored) {
      if (stored.log) setLog(stored.log);
      if (stored.stats) setSt(stored.stats);
      if (stored.positions) setPositions(stored.positions);
      if (stored.cfg) setCfg((c) => ({ ...c, ...stored.cfg }));
    }
    // Check if API keys are configured
    authGet("/portfolio/balance").then((data) => {
      if (data?.noKeys) {
        setConnected(false);
      } else if (data?.balance != null) {
        setConnected(true);
        setAccount(data);
      }
      setCheckingAuth(false);
    });
  }, []);

  // ── Persist on changes ──
  useEffect(() => {
    saveStore({ log, stats: st, positions, cfg });
  }, [log, st, positions, cfg]);

  // ── Scan ──
  const scan = useCallback(async () => {
    setScanning(true);
    const sigs = [],
      econ = [],
      wc = {};

    // Weather markets
    for (const c of CITIES) {
      const w = await getForecast(c);
      if (w) wc[c.station] = w;
      const d = await pubGet("/markets", {
        series_ticker: c.series,
        status: "open",
        limit: 50,
      });
      for (const mkt of d?.markets || []) {
        const s = evaluateWeather(mkt, w, cfg);
        if (s) {
          s.city = c.label;
          sigs.push(s);
        }
      }
    }

    // Economic markets
    for (const ec of ECON_SERIES) {
      const d = await pubGet("/markets", {
        series_ticker: ec.series,
        status: "open",
        limit: 30,
      });
      for (const mkt of d?.markets || []) {
        const e = evaluateEcon(mkt, cfg);
        if (e) {
          e.city = ec.label;
          econ.push(e);
        }
      }
    }

    sigs.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));
    econ.sort((a, b) => b.vol - a.vol);

    setWx(wc);
    setSignals(sigs);
    setEconMarkets(econ.slice(0, 20));
    setLastScan(new Date());
    setSt((s) => ({ ...s, scans: s.scans + 1 }));

    // Auto-trade weather signals
    if (cfg.auto) {
      const avail = cfg.maxPos - positions.length;
      for (const s of sigs.slice(0, Math.max(0, avail))) {
        if (!positions.find((p) => p.ticker === s.ticker)) execTrade(s);
      }
    }

    // Refresh account balance if connected
    if (connected) {
      const bal = await authGet("/portfolio/balance");
      if (bal?.balance != null) setAccount(bal);
    }

    setScanning(false);
  }, [cfg, positions, connected]);

  const execTrade = async (s) => {
    const entryPrice = s.side === "yes" ? s.price : 1 - s.price;
    const pos = {
      ...s,
      entryPrice,
      entryTime: Date.now(),
      id: Date.now(),
    };

    // If connected, try to place real order
    if (connected) {
      const orderBody = {
        ticker: s.ticker,
        action: "buy",
        side: s.side,
        type: "limit",
        count: s.contracts,
        yes_price: s.side === "yes" ? Math.round(s.price * 100) : undefined,
        no_price: s.side === "no" ? Math.round((1 - s.price) * 100) : undefined,
        client_order_id: `apex-${Date.now()}`,
      };
      const result = await authGet("/portfolio/orders", "POST", orderBody);
      if (result?.order) {
        pos.orderId = result.order.order_id;
        pos.live = true;
      }
    }

    setPositions((p) => [...p, pos]);
    pushLog("OPEN", s, entryPrice);
    setSt((prev) => ({ ...prev, trades: prev.trades + 1 }));
  };

  const closePos = (id) => {
    setPositions((prev) => {
      const p = prev.find((x) => x.id === id);
      if (p) pushLog("CLOSE", p, p.entryPrice);
      return prev.filter((x) => x.id !== id);
    });
  };

  const pushLog = (type, d, price) => {
    setLog((l) =>
      [
        {
          type,
          city: d.city,
          ticker: d.ticker,
          side: d.side,
          qty: d.contracts,
          price,
          edge: d.edge,
          reason: d.reason,
          live: d.live || false,
          time: new Date().toISOString(),
        },
        ...l,
      ].slice(0, 500)
    );
  };

  // ── Bot loop ──
  useEffect(() => {
    if (!on) return;
    scan();
    const iv = setInterval(scan, cfg.interval * 1000);
    return () => clearInterval(iv);
  }, [on, scan, cfg.interval]);

  const wr = st.trades > 0 ? (st.wins / st.trades) * 100 : 0;

  // ── Colors ──
  const g = "#34d399",
    r = "#f87171",
    b = "#60a5fa",
    y = "#fbbf24",
    dm = "#4b5563",
    bg = "#0a0f1a",
    cd = "#111827",
    bd = "#1f2937",
    tx = "#e5e7eb";

  return (
    <>
      <Head>
        <title>Apex Bot — Kalshi Trading</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='14' font-size='14'>⚡</text></svg>" />
      </Head>

      <div
        style={{
          minHeight: "100vh",
          background: bg,
          color: tx,
          fontFamily: "'SF Mono', Menlo, 'Courier New', monospace",
          maxWidth: 480,
          margin: "0 auto",
        }}
      >
        <style>{`
          *{box-sizing:border-box;margin:0;padding:0}
          @keyframes glow{0%,100%{opacity:1}50%{opacity:.3}}
          input[type=range]{width:100%;height:3px;-webkit-appearance:none;appearance:none;background:${bd};border-radius:2px;outline:none}
          input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;border-radius:50%;background:${b};cursor:pointer;border:2px solid ${bg}}
          ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:${bd};border-radius:2px}
        `}</style>

        {/* ── Header ── */}
        <div style={{ padding: "14px 16px 10px" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: on ? g : dm,
                  boxShadow: on ? `0 0 8px ${g}` : "none",
                  animation: on ? "glow 1.5s infinite" : "none",
                }}
              />
              <span style={{ fontSize: 16, fontWeight: 800, letterSpacing: 2 }}>
                APEX
              </span>
              {connected && (
                <span
                  style={{
                    fontSize: 9,
                    padding: "2px 6px",
                    borderRadius: 4,
                    background: g + "20",
                    color: g,
                    fontWeight: 700,
                  }}
                >
                  LIVE
                </span>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span
                style={{
                  fontSize: 16,
                  fontWeight: 800,
                  color: st.pnl >= 0 ? g : r,
                }}
              >
                {st.pnl >= 0 ? "+" : ""}
                {usd(st.pnl)}
              </span>
              <button
                onClick={() => setOn(!on)}
                style={{
                  padding: "8px 22px",
                  borderRadius: 8,
                  border: "none",
                  fontSize: 11,
                  fontWeight: 800,
                  letterSpacing: 2,
                  cursor: "pointer",
                  background: on ? r : g,
                  color: "#000",
                }}
              >
                {on ? "STOP" : "START"}
              </button>
            </div>
          </div>

          {/* Account bar */}
          {connected && account && (
            <div
              style={{
                marginTop: 8,
                padding: "6px 10px",
                background: g + "10",
                borderRadius: 6,
                fontSize: 10,
                color: g,
                display: "flex",
                justifyContent: "space-between",
              }}
            >
              <span>
                Balance: {usd((account.balance || 0) / 100)}
              </span>
              <span>
                {process.env.NEXT_PUBLIC_KALSHI_ENV === "prod"
                  ? "PRODUCTION"
                  : "DEMO"}
              </span>
            </div>
          )}

          {/* Stats */}
          <div
            style={{
              display: "flex",
              marginTop: 10,
              background: cd,
              borderRadius: 10,
              overflow: "hidden",
            }}
          >
            {[
              { l: "TRADES", v: st.trades },
              { l: "WIN%", v: st.trades > 0 ? f0(wr) : "—" },
              { l: "OPEN", v: `${positions.length}/${cfg.maxPos}` },
              { l: "FOUND", v: signals.length },
            ].map((s, i) => (
              <div
                key={i}
                style={{
                  flex: 1,
                  textAlign: "center",
                  padding: "10px 0",
                  borderRight: i < 3 ? `1px solid ${bd}` : "none",
                }}
              >
                <div
                  style={{
                    fontSize: 8,
                    color: dm,
                    letterSpacing: 1.5,
                    marginBottom: 3,
                  }}
                >
                  {s.l}
                </div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>{s.v}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Tabs ── */}
        <div style={{ display: "flex", padding: "0 16px", gap: 4 }}>
          {[
            { id: "bot", label: "Bot" },
            { id: "econ", label: "Econ" },
            { id: "settings", label: "Settings" },
            { id: "log", label: `Log` },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                flex: 1,
                padding: "10px 0",
                border: "none",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 1,
                textTransform: "uppercase",
                background: tab === t.id ? cd : "transparent",
                color: tab === t.id ? tx : dm,
                borderRadius: "8px 8px 0 0",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div style={{ padding: "12px 16px 24px" }}>
          {/* ═══ BOT TAB ═══ */}
          {tab === "bot" && (
            <>
              {/* Weather strip */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 6,
                  marginBottom: 14,
                }}
              >
                {CITIES.map((c) => {
                  const w = wx[c.station];
                  return (
                    <div
                      key={c.station}
                      style={{
                        padding: "10px 12px",
                        background: cd,
                        borderRadius: 8,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "baseline",
                        }}
                      >
                        <span
                          style={{
                            fontSize: 12,
                            fontWeight: 800,
                            letterSpacing: 1,
                          }}
                        >
                          {c.label}
                        </span>
                        {w?.cur != null && (
                          <span
                            style={{
                              fontSize: 20,
                              fontWeight: 800,
                              color: "#38bdf8",
                            }}
                          >
                            {w.cur}°
                          </span>
                        )}
                      </div>
                      {w?.ensemble != null ? (
                        <div style={{ fontSize: 10, color: dm, marginTop: 4 }}>
                          High{" "}
                          <span style={{ color: y, fontWeight: 700 }}>
                            {w.ensemble}°
                          </span>{" "}
                          ±{f1(w.sigma)}
                          {w.desc && (
                            <span style={{ opacity: 0.6 }}> • {w.desc}</span>
                          )}
                        </div>
                      ) : (
                        <div style={{ fontSize: 10, color: dm, marginTop: 4 }}>
                          {scanning ? "..." : "—"}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Scan button */}
              <button
                onClick={() => !scanning && scan()}
                disabled={scanning}
                style={{
                  width: "100%",
                  padding: 10,
                  marginBottom: 14,
                  borderRadius: 8,
                  border: `1px solid ${bd}`,
                  background: cd,
                  color: scanning ? dm : b,
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: "pointer",
                  letterSpacing: 1,
                }}
              >
                {scanning
                  ? "⟳ SCANNING..."
                  : `SCAN NOW${lastScan ? ` • ${Math.round((Date.now() - lastScan) / 1000)}s` : ""}`}
              </button>

              {/* Signals */}
              {signals.length === 0 ? (
                <div
                  style={{
                    padding: 32,
                    textAlign: "center",
                    color: dm,
                    background: cd,
                    borderRadius: 10,
                    fontSize: 12,
                    lineHeight: 1.8,
                  }}
                >
                  {lastScan
                    ? "No weather opportunities found"
                    : "Press START or SCAN NOW"}
                </div>
              ) : (
                <div style={{ marginBottom: 16 }}>
                  <div
                    style={{
                      fontSize: 9,
                      color: dm,
                      letterSpacing: 2,
                      marginBottom: 8,
                      fontWeight: 700,
                    }}
                  >
                    WEATHER SIGNALS
                  </div>
                  {signals.map((s, i) => {
                    const inPos = positions.find(
                      (p) => p.ticker === s.ticker
                    );
                    return (
                      <div
                        key={s.ticker + i}
                        style={{
                          padding: "10px 12px",
                          marginBottom: 4,
                          background: cd,
                          borderRadius: 8,
                          borderLeft: `3px solid ${s.side === "yes" ? g : r}`,
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "flex-start",
                            gap: 8,
                          }}
                        >
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div
                              style={{
                                fontSize: 11,
                                fontWeight: 600,
                                lineHeight: 1.4,
                                marginBottom: 3,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                display: "-webkit-box",
                                WebkitLineClamp: 2,
                                WebkitBoxOrient: "vertical",
                              }}
                            >
                              {s.title}
                            </div>
                            <div style={{ fontSize: 9, color: dm }}>
                              {s.reason}
                            </div>
                          </div>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              flexShrink: 0,
                            }}
                          >
                            <div style={{ textAlign: "right" }}>
                              <div
                                style={{
                                  fontSize: 18,
                                  fontWeight: 800,
                                  color:
                                    Math.abs(s.edge) >= 10 ? g : y,
                                  lineHeight: 1,
                                }}
                              >
                                {s.edge > 0 ? "+" : ""}
                                {f1(s.edge)}
                              </div>
                              <div
                                style={{
                                  fontSize: 8,
                                  color: dm,
                                  letterSpacing: 1,
                                  marginTop: 2,
                                }}
                              >
                                {s.contracts}× {s.side.toUpperCase()}
                              </div>
                            </div>
                            <button
                              onClick={() => !inPos && execTrade(s)}
                              disabled={
                                !!inPos ||
                                positions.length >= cfg.maxPos
                              }
                              style={{
                                padding: "8px 12px",
                                borderRadius: 6,
                                border: "none",
                                fontSize: 10,
                                fontWeight: 800,
                                cursor: "pointer",
                                letterSpacing: 1,
                                background: inPos
                                  ? dm + "40"
                                  : s.side === "yes"
                                    ? g
                                    : r,
                                color: inPos ? dm : "#000",
                                opacity:
                                  !!inPos ||
                                  positions.length >= cfg.maxPos
                                    ? 0.3
                                    : 1,
                              }}
                            >
                              {inPos ? "IN" : "BUY"}
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Positions */}
              {positions.length > 0 && (
                <div>
                  <div
                    style={{
                      fontSize: 9,
                      color: dm,
                      letterSpacing: 2,
                      marginBottom: 8,
                      fontWeight: 700,
                    }}
                  >
                    POSITIONS
                  </div>
                  {positions.map((p) => {
                    const mins = Math.floor(
                      (Date.now() - p.entryTime) / 60000
                    );
                    return (
                      <div
                        key={p.id}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "10px 12px",
                          marginBottom: 4,
                          background: cd,
                          borderRadius: 8,
                        }}
                      >
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 700 }}>
                            <span
                              style={{
                                color: p.side === "yes" ? g : r,
                              }}
                            >
                              {p.side.toUpperCase()}
                            </span>
                            <span style={{ color: dm }}> • </span>
                            {p.city} • {p.contracts}× @{" "}
                            {f0(p.entryPrice * 100)}¢
                            {p.live && (
                              <span
                                style={{
                                  fontSize: 8,
                                  color: g,
                                  marginLeft: 4,
                                }}
                              >
                                LIVE
                              </span>
                            )}
                          </div>
                          <div
                            style={{
                              fontSize: 9,
                              color: dm,
                              marginTop: 2,
                            }}
                          >
                            TP {p.tp}¢ SL {p.sl}¢ •{" "}
                            {mins < 60
                              ? `${mins}m`
                              : `${Math.floor(mins / 60)}h${mins % 60}m`}
                          </div>
                        </div>
                        <button
                          onClick={() => closePos(p.id)}
                          style={{
                            padding: "6px 10px",
                            borderRadius: 5,
                            border: `1px solid ${bd}`,
                            background: "transparent",
                            color: dm,
                            fontSize: 10,
                            cursor: "pointer",
                            fontWeight: 700,
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {/* ═══ ECON TAB ═══ */}
          {tab === "econ" && (
            <>
              <div
                style={{
                  fontSize: 9,
                  color: dm,
                  letterSpacing: 2,
                  marginBottom: 8,
                  fontWeight: 700,
                }}
              >
                ECONOMIC MARKETS
              </div>
              {econMarkets.length === 0 ? (
                <div
                  style={{
                    padding: 32,
                    textAlign: "center",
                    color: dm,
                    background: cd,
                    borderRadius: 10,
                    fontSize: 12,
                    lineHeight: 1.8,
                  }}
                >
                  {lastScan
                    ? "No economic markets in your price range"
                    : "Run a scan to load economic markets"}
                </div>
              ) : (
                econMarkets.map((m, i) => (
                  <div
                    key={m.ticker + i}
                    style={{
                      padding: "10px 12px",
                      marginBottom: 4,
                      background: cd,
                      borderRadius: 8,
                      borderLeft: `3px solid ${b}`,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "flex-start",
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: 11,
                            fontWeight: 600,
                            lineHeight: 1.4,
                            marginBottom: 3,
                          }}
                        >
                          <span
                            style={{
                              fontSize: 9,
                              padding: "1px 5px",
                              borderRadius: 3,
                              background: b + "20",
                              color: b,
                              marginRight: 6,
                            }}
                          >
                            {m.city}
                          </span>
                          {m.title}
                        </div>
                        <div style={{ fontSize: 9, color: dm }}>
                          Vol: {m.vol}
                        </div>
                      </div>
                      <div
                        style={{
                          fontSize: 16,
                          fontWeight: 800,
                          color: tx,
                          flexShrink: 0,
                        }}
                      >
                        {f0(m.price * 100)}¢
                      </div>
                    </div>
                  </div>
                ))
              )}
              <div
                style={{
                  marginTop: 12,
                  padding: 12,
                  background: cd,
                  borderRadius: 8,
                  fontSize: 10,
                  color: dm,
                  lineHeight: 1.7,
                }}
              >
                Economic markets are shown for awareness. Unlike weather, there&apos;s
                no free real-time data model to compare prices against. Use
                Cleveland Fed CPI Nowcast, CME FedWatch, and ADP reports to find
                your own edge before trading these.
              </div>
            </>
          )}

          {/* ═══ SETTINGS TAB ═══ */}
          {tab === "settings" && (
            <>
              {/* Account Status */}
              <div
                style={{
                  padding: 14,
                  background: cd,
                  borderRadius: 10,
                  marginBottom: 16,
                  border: `1px solid ${connected ? g + "40" : bd}`,
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: connected ? g : y,
                    marginBottom: 8,
                  }}
                >
                  {checkingAuth
                    ? "Checking connection..."
                    : connected
                      ? "✓ Account Connected"
                      : "Account Not Linked"}
                </div>
                {!connected && !checkingAuth && (
                  <div
                    style={{ fontSize: 10, color: dm, lineHeight: 1.8 }}
                  >
                    To link your Kalshi account:
                    <br />
                    1. Go to{" "}
                    <span style={{ color: b }}>
                      kalshi.com/account/profile
                    </span>
                    <br />
                    2. Scroll to &quot;API Keys&quot; → Create New API Key
                    <br />
                    3. Save the Private Key file and note the Key ID
                    <br />
                    4. Add to your{" "}
                    <span style={{ color: b }}>.env.local</span> file:
                    <br />
                    <br />
                    <code
                      style={{
                        display: "block",
                        padding: 8,
                        background: bg,
                        borderRadius: 4,
                        fontSize: 9,
                        lineHeight: 1.6,
                        wordBreak: "break-all",
                      }}
                    >
                      NEXT_PUBLIC_KALSHI_API_KEY_ID=your-key-id
                      <br />
                      KALSHI_PRIVATE_KEY=&quot;-----BEGIN RSA PRIVATE
                      KEY-----
                      <br />
                      ...your key...
                      <br />
                      -----END RSA PRIVATE KEY-----&quot;
                      <br />
                      NEXT_PUBLIC_KALSHI_ENV=demo
                    </code>
                    <br />
                    5. Restart the app (
                    <span style={{ color: b }}>npm run dev</span>)
                    <br />
                    6. Use <span style={{ color: y }}>demo</span> first, then
                    change to <span style={{ color: g }}>prod</span> when ready
                  </div>
                )}
                {connected && account && (
                  <div style={{ fontSize: 11, color: tx }}>
                    Balance:{" "}
                    <span style={{ fontWeight: 700 }}>
                      {usd((account.balance || 0) / 100)}
                    </span>
                  </div>
                )}
              </div>

              {/* Sliders */}
              {[
                {
                  hd: "ENTRY",
                  items: [
                    { k: "bet", l: "Bet Size", u: "$", mn: 1, mx: 200, s: 1 },
                    {
                      k: "minEdge",
                      l: "Min Edge",
                      u: "¢",
                      mn: 1,
                      mx: 25,
                      s: 1,
                    },
                    {
                      k: "pMin",
                      l: "Price Floor",
                      u: "¢",
                      mn: 1,
                      mx: 50,
                      s: 1,
                    },
                    {
                      k: "pMax",
                      l: "Price Ceiling",
                      u: "¢",
                      mn: 50,
                      mx: 99,
                      s: 1,
                    },
                    {
                      k: "minVol",
                      l: "Min Volume",
                      u: "",
                      mn: 0,
                      mx: 2000,
                      s: 50,
                    },
                  ],
                },
                {
                  hd: "EXIT",
                  items: [
                    {
                      k: "tp",
                      l: "Take Profit",
                      u: "¢",
                      mn: 2,
                      mx: 40,
                      s: 1,
                    },
                    {
                      k: "sl",
                      l: "Stop Loss",
                      u: "¢",
                      mn: 2,
                      mx: 40,
                      s: 1,
                    },
                  ],
                },
                {
                  hd: "BOT",
                  items: [
                    {
                      k: "maxPos",
                      l: "Max Positions",
                      u: "",
                      mn: 1,
                      mx: 20,
                      s: 1,
                    },
                    {
                      k: "interval",
                      l: "Scan Interval",
                      u: "s",
                      mn: 15,
                      mx: 300,
                      s: 15,
                    },
                  ],
                },
              ].map((gr) => (
                <div key={gr.hd} style={{ marginBottom: 20 }}>
                  <div
                    style={{
                      fontSize: 9,
                      fontWeight: 800,
                      color: dm,
                      letterSpacing: 2,
                      marginBottom: 12,
                    }}
                  >
                    {gr.hd}
                  </div>
                  {gr.items.map((f) => (
                    <div key={f.k} style={{ marginBottom: 16 }}>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          marginBottom: 8,
                        }}
                      >
                        <span style={{ fontSize: 12, color: "#94a3b8" }}>
                          {f.l}
                        </span>
                        <span style={{ fontSize: 14, fontWeight: 800 }}>
                          {cfg[f.k]}
                          {f.u}
                        </span>
                      </div>
                      <input
                        type="range"
                        min={f.mn}
                        max={f.mx}
                        step={f.s}
                        value={cfg[f.k]}
                        onChange={(e) => upCfg(f.k, +e.target.value)}
                      />
                    </div>
                  ))}
                </div>
              ))}

              {/* Auto toggle */}
              <div
                style={{
                  padding: 14,
                  background: cd,
                  borderRadius: 10,
                  marginBottom: 14,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <span style={{ fontSize: 12, fontWeight: 700 }}>
                  Auto-execute
                </span>
                <div
                  onClick={() => upCfg("auto", !cfg.auto)}
                  style={{
                    width: 44,
                    height: 24,
                    borderRadius: 12,
                    padding: 2,
                    cursor: "pointer",
                    background: cfg.auto ? g : bd,
                    transition: "background 0.2s",
                  }}
                >
                  <div
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: "50%",
                      background: "#fff",
                      transform: cfg.auto
                        ? "translateX(20px)"
                        : "translateX(0)",
                      transition: "transform 0.2s",
                    }}
                  />
                </div>
              </div>

              <button
                onClick={() => {
                  setSt({ trades: 0, wins: 0, pnl: 0, scans: 0 });
                  setLog([]);
                  setPositions([]);
                  setSignals([]);
                  setEconMarkets([]);
                  localStorage.removeItem(STORE_KEY);
                }}
                style={{
                  width: "100%",
                  marginTop: 8,
                  padding: 10,
                  borderRadius: 8,
                  border: `1px solid ${bd}`,
                  background: "transparent",
                  color: r,
                  fontSize: 10,
                  fontWeight: 700,
                  cursor: "pointer",
                  letterSpacing: 1,
                }}
              >
                RESET EVERYTHING
              </button>
            </>
          )}

          {/* ═══ LOG TAB ═══ */}
          {tab === "log" && (
            <>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 10,
                }}
              >
                <span
                  style={{
                    fontSize: 9,
                    color: dm,
                    letterSpacing: 2,
                    fontWeight: 700,
                  }}
                >
                  {log.length} ENTRIES
                </span>
                <button
                  onClick={() => {
                    const blob = new Blob(
                      [JSON.stringify(log, null, 2)],
                      { type: "application/json" }
                    );
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `apex-log-${new Date().toISOString().slice(0, 10)}.json`;
                    a.click();
                  }}
                  style={{
                    padding: "4px 10px",
                    borderRadius: 4,
                    border: `1px solid ${bd}`,
                    background: "transparent",
                    color: dm,
                    fontSize: 9,
                    cursor: "pointer",
                  }}
                >
                  EXPORT
                </button>
              </div>

              {log.length === 0 ? (
                <div
                  style={{
                    padding: 40,
                    textAlign: "center",
                    color: dm,
                    fontSize: 12,
                  }}
                >
                  No trades yet
                </div>
              ) : (
                log.map((l, i) => (
                  <div
                    key={i}
                    style={{
                      padding: "8px 10px",
                      marginBottom: 3,
                      background: cd,
                      borderRadius: 6,
                      borderLeft: `3px solid ${l.type === "OPEN" ? b : g}`,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          gap: 6,
                          alignItems: "center",
                          fontSize: 10,
                        }}
                      >
                        <span
                          style={{
                            fontWeight: 800,
                            color: l.type === "OPEN" ? b : g,
                          }}
                        >
                          {l.type}
                        </span>
                        {l.side && (
                          <span
                            style={{
                              color: l.side === "yes" ? g : r,
                            }}
                          >
                            {l.side.toUpperCase()}
                          </span>
                        )}
                        <span style={{ color: dm }}>
                          {l.city} {l.qty}×
                        </span>
                        {l.live && (
                          <span
                            style={{
                              fontSize: 8,
                              color: g,
                              fontWeight: 700,
                            }}
                          >
                            LIVE
                          </span>
                        )}
                      </div>
                      <span style={{ fontSize: 9, color: dm }}>
                        {new Date(l.time).toLocaleTimeString()}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: 9,
                        color: dm,
                        marginTop: 2,
                        opacity: 0.7,
                      }}
                    >
                      {l.reason?.slice(0, 70)}
                    </div>
                  </div>
                ))
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
