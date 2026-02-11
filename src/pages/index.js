import { useState, useEffect, useCallback } from "react";
import Head from "next/head";

// ═══════════════════════════════════════════════════════════════
// APEX BOT v2 — Kalshi Automated Trading Bot
// ═══════════════════════════════════════════════════════════════

const PUB = "https://api.elections.kalshi.com/trade-api/v2";
const NWS = "https://api.weather.gov";

const CITIES = [
  { series: "KXHIGHNY", label: "NYC", station: "KNYC", lat: 40.7789, lon: -73.9692 },
  { series: "KXHIGHCHI", label: "CHI", station: "KORD", lat: 41.9742, lon: -87.9073 },
  { series: "KXHIGHMIA", label: "MIA", station: "KMIA", lat: 25.7959, lon: -80.287 },
  { series: "KXHIGHAUS", label: "AUS", station: "KAUS", lat: 30.1945, lon: -97.6699 },
];

const ECON = [
  { series: "KXCPI", label: "CPI", desc: "Consumer Price Index" },
  { series: "KXPAYROLLS", label: "Jobs", desc: "Nonfarm Payrolls" },
  { series: "KXUNEMPLOY", label: "Unemp", desc: "Unemployment Rate" },
  { series: "KXFED", label: "Fed", desc: "Fed Funds Rate" },
  { series: "KXGDP", label: "GDP", desc: "Gross Domestic Product" },
  { series: "KXPCE", label: "PCE", desc: "Personal Consumption" },
  { series: "KXTSA", label: "TSA", desc: "TSA Passenger Volume" },
];

const f1 = n => Number(n).toFixed(1);
const f0 = n => Number(n).toFixed(0);
const usd = n => `$${Number(n).toFixed(2)}`;

const normCDF = (x, mean, std) => {
  if (std <= 0) return x >= mean ? 1 : 0;
  const z = (x - mean) / std;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const p = 0.3989422804 * Math.exp(-z * z / 2) * t *
    (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
};

// Storage
const SK = "apex_v2";
const load = () => { try { return JSON.parse(localStorage.getItem(SK)) || {}; } catch { return {}; } };
const save = d => { try { localStorage.setItem(SK, JSON.stringify(d)); } catch {} };

// API helpers
async function kGet(path, params = {}) {
  const u = new URL(`${PUB}${path}`);
  Object.entries(params).forEach(([k, v]) => v != null && u.searchParams.set(k, v));
  try { const r = await fetch(u); return r.ok ? r.json() : null; } catch { return null; }
}
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
async function nwsGet(path) {
  try { const r = await fetch(`${NWS}${path}`, { headers: { "User-Agent": "Apex/2" } }); return r.ok ? r.json() : null; } catch { return null; }
}

// Weather forecast
async function forecast(city) {
  const [pt, obs] = await Promise.all([
    nwsGet(`/points/${city.lat},${city.lon}`),
    nwsGet(`/stations/${city.station}/observations/latest`),
  ]);
  let hi = null, hrMax = null, desc = null;
  if (pt?.properties?.forecast) {
    const fc = await nwsGet(pt.properties.forecast.replace(NWS, ""));
    const day = fc?.properties?.periods?.find(p => p.isDaytime);
    hi = day?.temperature ?? null; desc = day?.shortForecast ?? null;
  }
  if (pt?.properties?.forecastHourly) {
    const hc = await nwsGet(pt.properties.forecastHourly.replace(NWS, ""));
    const dh = hc?.properties?.periods?.filter(p => p.isDaytime)?.slice(0, 12);
    if (dh?.length) hrMax = Math.max(...dh.map(h => h.temperature));
  }
  const cur = obs?.properties?.temperature?.value != null
    ? Math.round(obs.properties.temperature.value * 9 / 5 + 32) : null;
  const srcs = [];
  if (hi != null) srcs.push({ t: hi, w: 0.45 });
  if (hrMax != null) srcs.push({ t: hrMax, w: 0.35 });
  if (cur != null && hi != null) srcs.push({ t: Math.round(cur + (hi - cur) * 0.55), w: 0.2 });
  const tw = srcs.reduce((s, x) => s + x.w, 0);
  const ens = tw > 0 ? Math.round(srcs.reduce((s, x) => s + x.t * x.w, 0) / tw) : hi;
  const sig = srcs.length >= 2 ? Math.max(1.5, Math.sqrt(srcs.reduce((s, x) => s + (x.t - ens) ** 2, 0) / srcs.length)) : 3;
  return { ens, sig, cur, hi, hrMax, desc };
}

// Evaluate a weather market — returns analysis for EVERY market, not just tradeable ones
function analyzeWeather(mkt, wx) {
  const price = (mkt.yes_price || mkt.last_price || 50) / 100;
  const vol = mkt.volume || 0;
  const title = mkt.title || "";
  const m = title.match(/(\d+)\s*°?\s*F?\s*(or\s*(above|below|higher|lower|more|less))?/i);
  if (!m || !wx?.ens) return null;
  const thresh = parseInt(m[1]);
  const above = !/below|lower|less|under/i.test(title);
  const raw = above ? 1 - normCDF(thresh, wx.ens, wx.sig) : normCDF(thresh, wx.ens, wx.sig);
  const prob = Math.max(0.02, Math.min(0.98, raw));
  const edge = (prob - price) * 100;
  return {
    ticker: mkt.ticker, title, price, prob, edge, vol, thresh, above,
    mktPct: f0(price * 100), modelPct: f0(prob * 100),
  };
}

// ═══ COLORS ═══
const C = {
  bg: "#060b18", cd: "#0d1526", bd: "#1a2540", tx: "#e2e8f0",
  dm: "#475569", g: "#34d399", r: "#f87171", b: "#60a5fa",
  y: "#fbbf24", cy: "#22d3ee", p: "#a78bfa",
};

// ═══ APP ══════════════════════════════════════════════════════

export default function Apex() {
  const [tab, setTab] = useState("bot");
  const [on, setOn] = useState(false);
  const [wx, setWx] = useState({});
  const [allMkts, setAllMkts] = useState([]); // ALL analyzed weather markets
  const [econMkts, setEconMkts] = useState([]); // ALL economic markets
  const [positions, setPositions] = useState([]);
  const [log, setLog] = useState([]);
  const [st, setSt] = useState({ trades: 0, wins: 0, pnl: 0, scans: 0 });
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState("");
  const [lastScan, setLastScan] = useState(null);
  const [bal, setBal] = useState(null); // account balance in cents
  const [connected, setConnected] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);

  const [cfg, setCfg] = useState({
    bet: 10, minEdge: 3, pMin: 10, pMax: 90, tp: 8, sl: 12,
    maxPos: 5, minVol: 0, interval: 90, auto: false,
  });
  const up = (k, v) => setCfg(c => ({ ...c, [k]: v }));

  // ── Load saved data ──
  useEffect(() => {
    const d = load();
    if (d.log) setLog(d.log);
    if (d.st) setSt(d.st);
    if (d.positions) setPositions(d.positions);
    if (d.cfg) setCfg(c => ({ ...c, ...d.cfg }));
    // Check auth
    authReq("/portfolio/balance").then(d => {
      if (d && !d.noKeys && d.balance != null) {
        setConnected(true); setBal(d.balance);
      }
      setAuthChecked(true);
    });
  }, []);

  // ── Save on change ──
  useEffect(() => { save({ log, st, positions, cfg }); }, [log, st, positions, cfg]);

  // ── Weather Scan ──
  const scanWeather = useCallback(async () => {
    setScanning(true); setScanMsg("Fetching forecasts...");
    const results = [], wc = {};
    let totalMkts = 0;

    for (const c of CITIES) {
      setScanMsg(`${c.label}: getting forecast...`);
      const w = await forecast(c);
      if (w) wc[c.station] = w;

      setScanMsg(`${c.label}: loading markets...`);
      const d = await kGet("/markets", { series_ticker: c.series, status: "open", limit: 100 });
      const mkts = d?.markets || [];
      totalMkts += mkts.length;

      for (const mkt of mkts) {
        const a = analyzeWeather(mkt, w);
        if (a) { a.city = c.label; results.push(a); }
      }
    }

    results.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));
    setWx(wc);
    setAllMkts(results);
    setLastScan(new Date());
    setSt(s => ({ ...s, scans: s.scans + 1 }));
    setScanMsg(results.length > 0
      ? `Found ${results.length} markets across ${totalMkts} contracts`
      : `Scanned ${totalMkts} contracts — no open weather markets right now`);
    setScanning(false);

    // Auto-trade
    if (cfg.auto) {
      const tradeable = results.filter(r =>
        Math.abs(r.edge) >= cfg.minEdge &&
        r.price >= cfg.pMin / 100 && r.price <= cfg.pMax / 100 &&
        (cfg.minVol === 0 || r.vol >= cfg.minVol)
      );
      const avail = cfg.maxPos - positions.length;
      for (const s of tradeable.slice(0, Math.max(0, avail))) {
        if (!positions.find(p => p.ticker === s.ticker)) {
          const side = s.edge > 0 ? "yes" : "no";
          execTrade({ ...s, side, contracts: Math.floor(cfg.bet / (side === "yes" ? s.price : 1 - s.price)) });
        }
      }
    }

    // Refresh balance
    if (connected) {
      const b = await authReq("/portfolio/balance");
      if (b?.balance != null) setBal(b.balance);
    }
  }, [cfg, positions, connected]);

  // ── Econ Scan ──
  const scanEcon = useCallback(async () => {
    setScanning(true); setScanMsg("Loading economic markets...");
    const results = [];
    for (const ec of ECON) {
      setScanMsg(`Loading ${ec.label}...`);
      const d = await kGet("/markets", { series_ticker: ec.series, status: "open", limit: 50 });
      for (const mkt of d?.markets || []) {
        const price = (mkt.yes_price || mkt.last_price || 50) / 100;
        const vol = mkt.volume || 0;
        results.push({
          ticker: mkt.ticker, title: mkt.title || "", price, vol,
          cat: ec.label, catDesc: ec.desc,
          closeTime: mkt.close_time,
        });
      }
    }
    results.sort((a, b) => b.vol - a.vol);
    setEconMkts(results);
    setScanMsg(`Found ${results.length} economic markets`);
    setScanning(false);
  }, []);

  // ── Full scan (both) ──
  const scanAll = useCallback(async () => {
    await scanWeather();
    await scanEcon();
  }, [scanWeather, scanEcon]);

  // ── Trading ──
  const execTrade = async (s) => {
    const side = s.side || (s.edge > 0 ? "yes" : "no");
    const entryPrice = side === "yes" ? s.price : 1 - s.price;
    const contracts = s.contracts || Math.floor(cfg.bet / entryPrice);
    if (contracts < 1) return;

    const pos = {
      ...s, side, entryPrice, contracts,
      tp: Math.min(99, Math.round(s.price * 100 + cfg.tp)),
      sl: Math.max(1, Math.round(s.price * 100 - cfg.sl)),
      entryTime: Date.now(), id: Date.now(), live: false,
    };

    if (connected) {
      const body = {
        ticker: s.ticker, action: "buy", side, type: "limit",
        count: contracts,
        ...(side === "yes" ? { yes_price: Math.round(s.price * 100) } : { no_price: Math.round((1 - s.price) * 100) }),
        client_order_id: `apex-${Date.now()}`,
      };
      const r = await authReq("/portfolio/orders", "POST", body);
      if (r?.order) { pos.orderId = r.order.order_id; pos.live = true; }
    }

    setPositions(p => [...p, pos]);
    pushLog("OPEN", { ...pos });
    setSt(prev => ({ ...prev, trades: prev.trades + 1 }));
  };

  const closePos = id => {
    setPositions(prev => {
      const p = prev.find(x => x.id === id);
      if (p) pushLog("CLOSE", p);
      return prev.filter(x => x.id !== id);
    });
  };

  const pushLog = (type, d) => {
    setLog(l => [{
      type, city: d.city || d.cat, ticker: d.ticker, side: d.side,
      qty: d.contracts, price: d.entryPrice || d.price, edge: d.edge,
      reason: d.reason || `${d.modelPct}% model vs ${d.mktPct}¢ mkt`,
      live: d.live, time: new Date().toISOString(),
    }, ...l].slice(0, 500));
  };

  // ── Bot loop ──
  useEffect(() => {
    if (!on) return;
    scanAll();
    const iv = setInterval(scanAll, cfg.interval * 1000);
    return () => clearInterval(iv);
  }, [on, scanAll, cfg.interval]);

  // ── Derived ──
  const tradeable = allMkts.filter(m =>
    Math.abs(m.edge) >= cfg.minEdge &&
    m.price >= cfg.pMin / 100 && m.price <= cfg.pMax / 100 &&
    (cfg.minVol === 0 || m.vol >= cfg.minVol)
  );
  const tradeableYes = tradeable.filter(m => m.edge > 0);
  const tradeableNo = tradeable.filter(m => m.edge < 0);
  const wr = st.trades > 0 ? (st.wins / st.trades * 100) : 0;

  // ═══ RENDER ═══

  const Pill = ({ children, color = C.dm, bg: bgc }) => (
    <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 4, background: bgc || color + "18", color, fontWeight: 700, letterSpacing: 0.5 }}>{children}</span>
  );

  return (
    <>
      <Head>
        <title>Apex Bot</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
      </Head>
      <div style={{ minHeight: "100vh", background: C.bg, color: C.tx, fontFamily: "'SF Mono', Menlo, 'Courier New', monospace", maxWidth: 500, margin: "0 auto" }}>
        <style>{`
          *{box-sizing:border-box;margin:0;padding:0}
          @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
          input[type=range]{width:100%;height:3px;-webkit-appearance:none;appearance:none;background:${C.bd};border-radius:2px;outline:none}
          input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;border-radius:50%;background:${C.b};cursor:pointer;border:2px solid ${C.bg}}
          ::-webkit-scrollbar{width:3px}::-webkit-scrollbar-thumb{background:${C.bd};border-radius:2px}
        `}</style>

        {/* ── HEADER ── */}
        <div style={{ padding: "14px 16px 0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: on ? C.g : C.dm, boxShadow: on ? `0 0 8px ${C.g}` : "none", animation: on ? "pulse 1.5s infinite" : "none" }} />
              <span style={{ fontSize: 16, fontWeight: 800, letterSpacing: 2 }}>APEX</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 16, fontWeight: 800, color: st.pnl >= 0 ? C.g : C.r }}>{st.pnl >= 0 ? "+" : ""}{usd(st.pnl)}</span>
              <button onClick={() => setOn(!on)} style={{
                padding: "8px 22px", borderRadius: 8, border: "none", fontSize: 11,
                fontWeight: 800, letterSpacing: 2, cursor: "pointer",
                background: on ? C.r : C.g, color: "#000",
              }}>{on ? "STOP" : "START"}</button>
            </div>
          </div>

          {/* Account status — always visible */}
          <div style={{
            marginTop: 10, padding: "8px 12px", borderRadius: 8,
            background: connected ? C.g + "10" : C.y + "08",
            border: `1px solid ${connected ? C.g + "30" : C.bd}`,
            display: "flex", justifyContent: "space-between", alignItems: "center",
          }}>
            {!authChecked ? (
              <span style={{ fontSize: 10, color: C.dm }}>Checking account...</span>
            ) : connected ? (
              <>
                <span style={{ fontSize: 10, color: C.g }}>● Connected {process.env.NEXT_PUBLIC_KALSHI_ENV === "prod" ? "(LIVE)" : "(DEMO)"}</span>
                <span style={{ fontSize: 12, fontWeight: 800, color: C.g }}>{usd((bal || 0) / 100)}</span>
              </>
            ) : (
              <>
                <span style={{ fontSize: 10, color: C.y }}>○ Not connected</span>
                <span style={{ fontSize: 9, color: C.dm, cursor: "pointer" }} onClick={() => setTab("settings")}>Setup →</span>
              </>
            )}
          </div>

          {/* Stats */}
          <div style={{ display: "flex", marginTop: 10, background: C.cd, borderRadius: 10, overflow: "hidden" }}>
            {[
              { l: "TRADES", v: st.trades },
              { l: "WIN%", v: st.trades > 0 ? f0(wr) : "—" },
              { l: "OPEN", v: `${positions.length}/${cfg.maxPos}` },
              { l: "SIGNALS", v: tradeable.length },
            ].map((s, i) => (
              <div key={i} style={{ flex: 1, textAlign: "center", padding: "8px 0", borderRight: i < 3 ? `1px solid ${C.bd}` : "none" }}>
                <div style={{ fontSize: 8, color: C.dm, letterSpacing: 1.5, marginBottom: 2 }}>{s.l}</div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>{s.v}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ── TABS ── */}
        <div style={{ display: "flex", padding: "12px 16px 0", gap: 4 }}>
          {[
            { id: "bot", label: "Bot" },
            { id: "econ", label: `Econ${econMkts.length > 0 ? ` (${econMkts.length})` : ""}` },
            { id: "settings", label: "Settings" },
            { id: "log", label: `Log${log.length > 0 ? ` (${log.length})` : ""}` },
          ].map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              flex: 1, padding: "9px 0", border: "none", cursor: "pointer",
              fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase",
              background: tab === t.id ? C.cd : "transparent",
              color: tab === t.id ? C.tx : C.dm,
              borderRadius: "8px 8px 0 0",
            }}>{t.label}</button>
          ))}
        </div>

        <div style={{ padding: "12px 16px 40px" }}>

          {/* ═══ BOT TAB ═══ */}
          {tab === "bot" && (<>
            {/* Weather cards */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 12 }}>
              {CITIES.map(c => {
                const w = wx[c.station];
                return (
                  <div key={c.station} style={{ padding: "10px 12px", background: C.cd, borderRadius: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                      <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: 1 }}>{c.label}</span>
                      {w?.cur != null && <span style={{ fontSize: 20, fontWeight: 800, color: C.cy }}>{w.cur}°</span>}
                    </div>
                    {w?.ens != null ? (
                      <div style={{ fontSize: 10, color: C.dm, marginTop: 4 }}>
                        High <span style={{ color: C.y, fontWeight: 700 }}>{w.ens}°</span> ±{f1(w.sig)}
                        {w.desc && <span style={{ opacity: 0.6 }}> • {w.desc}</span>}
                      </div>
                    ) : <div style={{ fontSize: 10, color: C.dm, marginTop: 4 }}>{scanning ? "..." : "—"}</div>}
                  </div>
                );
              })}
            </div>

            {/* Scan button */}
            <button onClick={() => !scanning && scanAll()} disabled={scanning} style={{
              width: "100%", padding: 10, marginBottom: 4, borderRadius: 8,
              border: `1px solid ${C.bd}`, background: C.cd, color: scanning ? C.dm : C.b,
              fontSize: 11, fontWeight: 700, cursor: "pointer", letterSpacing: 1,
            }}>
              {scanning ? "⟳ SCANNING..." : `SCAN ALL MARKETS${lastScan ? ` • ${Math.round((Date.now() - lastScan) / 1000)}s ago` : ""}`}
            </button>

            {/* Scan status message */}
            {scanMsg && (
              <div style={{ fontSize: 9, color: C.dm, textAlign: "center", marginBottom: 12, lineHeight: 1.5 }}>
                {scanMsg}
              </div>
            )}

            {/* TRADEABLE SIGNALS - these meet your criteria */}
            {tradeable.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 9, color: C.g, letterSpacing: 2, marginBottom: 8, fontWeight: 700 }}>
                  ✓ TRADEABLE — {tradeable.length} match your settings
                </div>
                {tradeable.slice(0, 15).map((s, i) => {
                  const side = s.edge > 0 ? "yes" : "no";
                  const inPos = positions.find(p => p.ticker === s.ticker);
                  const contracts = Math.floor(cfg.bet / (side === "yes" ? s.price : 1 - s.price));
                  return (
                    <div key={s.ticker + i} style={{
                      padding: "10px 12px", marginBottom: 4, background: C.cd, borderRadius: 8,
                      borderLeft: `3px solid ${side === "yes" ? C.g : C.r}`,
                    }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 11, fontWeight: 600, lineHeight: 1.4, marginBottom: 4 }}>
                            <Pill color={C.cy}>{s.city}</Pill>{" "}
                            {s.title}
                          </div>
                          <div style={{ fontSize: 9, color: C.dm, lineHeight: 1.5 }}>
                            Forecast {wx[CITIES.find(c => c.label === s.city)?.station]?.ens}°F → threshold {s.thresh}°F
                            <br/>Model says <span style={{ color: C.b }}>{s.modelPct}%</span> • Market priced <span style={{ color: C.y }}>{s.mktPct}¢</span>
                            {s.vol > 0 && <> • Vol: {s.vol}</>}
                          </div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                          <div style={{ textAlign: "right" }}>
                            <div style={{ fontSize: 18, fontWeight: 800, color: Math.abs(s.edge) >= 8 ? C.g : C.y, lineHeight: 1 }}>
                              {s.edge > 0 ? "+" : ""}{f1(s.edge)}¢
                            </div>
                            <div style={{ fontSize: 8, color: C.dm, letterSpacing: 0.5, marginTop: 2 }}>
                              {contracts}× {side.toUpperCase()}
                            </div>
                          </div>
                          <button
                            onClick={() => !inPos && execTrade({ ...s, side, contracts })}
                            disabled={!!inPos || positions.length >= cfg.maxPos}
                            style={{
                              padding: "8px 12px", borderRadius: 6, border: "none",
                              fontSize: 10, fontWeight: 800, cursor: "pointer",
                              background: inPos ? C.dm + "40" : side === "yes" ? C.g : C.r,
                              color: inPos ? C.dm : "#000",
                              opacity: (!!inPos || positions.length >= cfg.maxPos) ? 0.3 : 1,
                            }}
                          >{inPos ? "IN" : "BUY"}</button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* ALL MARKETS - show everything that was analyzed, even non-tradeable */}
            {allMkts.length > 0 && tradeable.length === 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 9, color: C.y, letterSpacing: 2, marginBottom: 8, fontWeight: 700 }}>
                  ALL WEATHER MARKETS — none meet edge threshold ({cfg.minEdge}¢)
                </div>
                {allMkts.slice(0, 10).map((s, i) => (
                  <div key={s.ticker + i} style={{
                    padding: "8px 12px", marginBottom: 3, background: C.cd, borderRadius: 6,
                    opacity: 0.6,
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10 }}>
                      <span style={{ color: C.dm }}><Pill color={C.cy}>{s.city}</Pill> {s.title}</span>
                      <span style={{ color: Math.abs(s.edge) >= 3 ? C.y : C.dm, fontWeight: 700 }}>{s.edge > 0 ? "+" : ""}{f1(s.edge)}¢</span>
                    </div>
                    <div style={{ fontSize: 8, color: C.dm, marginTop: 2 }}>
                      Model {s.modelPct}% vs Mkt {s.mktPct}¢ — edge too small
                    </div>
                  </div>
                ))}
                <div style={{ fontSize: 9, color: C.dm, marginTop: 6, textAlign: "center" }}>
                  Try lowering Min Edge in Settings to see more signals
                </div>
              </div>
            )}

            {/* Empty state */}
            {allMkts.length === 0 && !scanning && (
              <div style={{ padding: 24, textAlign: "center", background: C.cd, borderRadius: 10, lineHeight: 1.8 }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>How this works</div>
                <div style={{ fontSize: 11, color: C.dm }}>
                  1. Press <span style={{ color: C.b }}>SCAN</span> or <span style={{ color: C.g }}>START</span> to begin
                  <br/>2. Bot fetches NWS weather forecasts for 4 cities
                  <br/>3. Compares forecast to Kalshi contract prices
                  <br/>4. Shows opportunities where the market is mispriced
                  <br/>5. You click <span style={{ color: C.g }}>BUY</span> or enable auto-trade
                </div>
              </div>
            )}

            {/* Positions */}
            {positions.length > 0 && (
              <div>
                <div style={{ fontSize: 9, color: C.p, letterSpacing: 2, marginBottom: 8, fontWeight: 700 }}>OPEN POSITIONS</div>
                {positions.map(p => {
                  const mins = Math.floor((Date.now() - p.entryTime) / 60000);
                  return (
                    <div key={p.id} style={{
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                      padding: "10px 12px", marginBottom: 4, background: C.cd, borderRadius: 8,
                    }}>
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 700 }}>
                          <span style={{ color: p.side === "yes" ? C.g : C.r }}>{p.side.toUpperCase()}</span>
                          <span style={{ color: C.dm }}> • </span>{p.city} • {p.contracts}× @ {f0(p.entryPrice * 100)}¢
                          {p.live && <Pill color={C.g}>LIVE</Pill>}
                        </div>
                        <div style={{ fontSize: 9, color: C.dm, marginTop: 2 }}>
                          TP {p.tp}¢ SL {p.sl}¢ • {mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60}m`}
                        </div>
                      </div>
                      <button onClick={() => closePos(p.id)} style={{
                        padding: "6px 10px", borderRadius: 5, border: `1px solid ${C.bd}`,
                        background: "transparent", color: C.dm, fontSize: 10, cursor: "pointer", fontWeight: 700,
                      }}>✕</button>
                    </div>
                  );
                })}
              </div>
            )}
          </>)}

          {/* ═══ ECON TAB ═══ */}
          {tab === "econ" && (<>
            <button onClick={() => !scanning && scanEcon()} disabled={scanning} style={{
              width: "100%", padding: 10, marginBottom: 12, borderRadius: 8,
              border: `1px solid ${C.bd}`, background: C.cd, color: scanning ? C.dm : C.b,
              fontSize: 11, fontWeight: 700, cursor: "pointer", letterSpacing: 1,
            }}>
              {scanning ? "⟳ SCANNING..." : "SCAN ECONOMIC MARKETS"}
            </button>

            {econMkts.length === 0 ? (
              <div style={{ padding: 24, textAlign: "center", background: C.cd, borderRadius: 10, lineHeight: 1.8 }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Economic Markets</div>
                <div style={{ fontSize: 11, color: C.dm }}>
                  Press scan to load CPI, Fed Rate, Jobs, GDP, Unemployment, PCE, and TSA markets.
                  <br/><br/>
                  Unlike weather, we can&apos;t auto-model these — you&apos;ll see prices and volume to find your own edge using sources like:
                  <br/><br/>
                  <span style={{ color: C.b }}>Cleveland Fed</span> CPI Nowcast
                  <br/><span style={{ color: C.b }}>CME FedWatch</span> for rate decisions
                  <br/><span style={{ color: C.b }}>ADP Report</span> for payrolls
                  <br/><span style={{ color: C.b }}>Atlanta Fed GDPNow</span> for GDP
                </div>
              </div>
            ) : (<>
              <div style={{ fontSize: 9, color: C.dm, letterSpacing: 2, marginBottom: 8, fontWeight: 700 }}>
                {econMkts.length} MARKETS • sorted by volume
              </div>
              {econMkts.slice(0, 30).map((m, i) => (
                <div key={m.ticker + i} style={{
                  padding: "8px 12px", marginBottom: 3, background: C.cd, borderRadius: 6,
                  borderLeft: `3px solid ${C.b}`,
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, lineHeight: 1.4, marginBottom: 2 }}>
                        <Pill color={C.p}>{m.cat}</Pill>{" "}
                        {m.title}
                      </div>
                      <div style={{ fontSize: 9, color: C.dm }}>Vol: {m.vol}</div>
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <div style={{ fontSize: 16, fontWeight: 800 }}>{f0(m.price * 100)}¢</div>
                      <div style={{ fontSize: 8, color: C.dm }}>YES price</div>
                    </div>
                  </div>
                </div>
              ))}
            </>)}
          </>)}

          {/* ═══ SETTINGS TAB ═══ */}
          {tab === "settings" && (<>
            {/* Connection setup */}
            <div style={{
              padding: 14, background: C.cd, borderRadius: 10, marginBottom: 16,
              border: `1px solid ${connected ? C.g + "40" : C.y + "30"}`,
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: connected ? C.g : C.y, marginBottom: 8 }}>
                {connected ? "✓ Kalshi Account Connected" : "Link Your Kalshi Account"}
              </div>
              {connected ? (
                <div style={{ fontSize: 11 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ color: C.dm }}>Balance</span>
                    <span style={{ fontWeight: 800, color: C.g }}>{usd((bal || 0) / 100)}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: C.dm }}>Environment</span>
                    <span style={{ fontWeight: 700, color: process.env.NEXT_PUBLIC_KALSHI_ENV === "prod" ? C.r : C.y }}>
                      {process.env.NEXT_PUBLIC_KALSHI_ENV === "prod" ? "PRODUCTION" : "DEMO"}
                    </span>
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 10, color: C.dm, lineHeight: 1.9 }}>
                  Without API keys, you can scan and see signals but cannot execute trades.
                  <br/><br/>
                  <span style={{ color: C.tx, fontWeight: 700 }}>To connect:</span>
                  <br/>1. Go to <span style={{ color: C.b }}>kalshi.com/account/profile</span>
                  <br/>2. Scroll to "API Keys" → Create New
                  <br/>3. Save the private key file + note the Key ID
                  <br/>4. Add to <span style={{ color: C.b }}>.env.local</span>:
                  <div style={{
                    margin: "8px 0", padding: 8, background: C.bg, borderRadius: 4,
                    fontSize: 9, lineHeight: 1.7, wordBreak: "break-all",
                  }}>
                    NEXT_PUBLIC_KALSHI_API_KEY_ID=your-id<br/>
                    KALSHI_PRIVATE_KEY=&quot;-----BEGIN RSA...&quot;<br/>
                    NEXT_PUBLIC_KALSHI_ENV=demo
                  </div>
                  5. Restart the app → you&apos;ll see your balance here
                  <br/><br/>
                  <span style={{ color: C.y }}>⚠ Start with demo mode first!</span>
                </div>
              )}
            </div>

            {/* Sliders */}
            {[
              { hd: "ENTRY RULES", items: [
                { k: "bet", l: "Bet Size", u: "$", mn: 1, mx: 200, s: 1, help: "How much to risk per trade" },
                { k: "minEdge", l: "Min Edge", u: "¢", mn: 1, mx: 25, s: 1, help: "Only trade when model edge exceeds this" },
                { k: "pMin", l: "Price Floor", u: "¢", mn: 1, mx: 50, s: 1, help: "Skip contracts cheaper than this (avoid longshots)" },
                { k: "pMax", l: "Price Ceiling", u: "¢", mn: 50, mx: 99, s: 1, help: "Skip contracts more expensive than this" },
                { k: "minVol", l: "Min Volume", u: "", mn: 0, mx: 500, s: 10, help: "0 = show all markets regardless of volume" },
              ]},
              { hd: "EXIT RULES", items: [
                { k: "tp", l: "Take Profit", u: "¢", mn: 2, mx: 40, s: 1, help: "Close when price moves this much in your favor" },
                { k: "sl", l: "Stop Loss", u: "¢", mn: 2, mx: 40, s: 1, help: "Close when price moves this much against you" },
              ]},
              { hd: "BOT CONFIG", items: [
                { k: "maxPos", l: "Max Positions", u: "", mn: 1, mx: 20, s: 1, help: "Max simultaneous trades" },
                { k: "interval", l: "Scan Interval", u: "s", mn: 30, mx: 300, s: 15, help: "How often bot re-scans when running" },
              ]},
            ].map(gr => (
              <div key={gr.hd} style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 9, fontWeight: 800, color: C.dm, letterSpacing: 2, marginBottom: 12 }}>{gr.hd}</div>
                {gr.items.map(f => (
                  <div key={f.k} style={{ marginBottom: 16 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                      <span style={{ fontSize: 12, color: "#94a3b8" }}>{f.l}</span>
                      <span style={{ fontSize: 14, fontWeight: 800 }}>{cfg[f.k]}{f.u}</span>
                    </div>
                    <div style={{ fontSize: 9, color: C.dm, marginBottom: 6 }}>{f.help}</div>
                    <input type="range" min={f.mn} max={f.mx} step={f.s} value={cfg[f.k]}
                      onChange={e => up(f.k, +e.target.value)} />
                  </div>
                ))}
              </div>
            ))}

            {/* Auto toggle */}
            <div style={{
              padding: 14, background: C.cd, borderRadius: 10, marginBottom: 14,
              display: "flex", justifyContent: "space-between", alignItems: "center",
            }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700 }}>Auto-execute</div>
                <div style={{ fontSize: 9, color: C.dm, marginTop: 2 }}>Bot will buy signals automatically</div>
              </div>
              <div onClick={() => up("auto", !cfg.auto)} style={{
                width: 44, height: 24, borderRadius: 12, padding: 2, cursor: "pointer",
                background: cfg.auto ? C.g : C.bd, transition: "background 0.2s",
              }}>
                <div style={{ width: 20, height: 20, borderRadius: "50%", background: "#fff",
                  transform: cfg.auto ? "translateX(20px)" : "translateX(0)", transition: "transform 0.2s" }} />
              </div>
            </div>

            <button onClick={() => {
              setSt({ trades: 0, wins: 0, pnl: 0, scans: 0 }); setLog([]);
              setPositions([]); setAllMkts([]); setEconMkts([]);
              localStorage.removeItem(SK);
            }} style={{
              width: "100%", marginTop: 8, padding: 10, borderRadius: 8,
              border: `1px solid ${C.bd}`, background: "transparent",
              color: C.r, fontSize: 10, fontWeight: 700, cursor: "pointer",
            }}>RESET EVERYTHING</button>
          </>)}

          {/* ═══ LOG TAB ═══ */}
          {tab === "log" && (<>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <span style={{ fontSize: 9, color: C.dm, letterSpacing: 2, fontWeight: 700 }}>{log.length} ENTRIES</span>
              {log.length > 0 && (
                <button onClick={() => {
                  const blob = new Blob([JSON.stringify(log, null, 2)], { type: "application/json" });
                  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
                  a.download = `apex-log-${new Date().toISOString().slice(0, 10)}.json`; a.click();
                }} style={{
                  padding: "4px 10px", borderRadius: 4, border: `1px solid ${C.bd}`,
                  background: "transparent", color: C.dm, fontSize: 9, cursor: "pointer",
                }}>EXPORT JSON</button>
              )}
            </div>
            {log.length === 0 ? (
              <div style={{ padding: 40, textAlign: "center", color: C.dm, fontSize: 12 }}>
                No trades yet. Trades will appear here when you execute them.
              </div>
            ) : log.map((l, i) => (
              <div key={i} style={{
                padding: "8px 10px", marginBottom: 3, background: C.cd, borderRadius: 6,
                borderLeft: `3px solid ${l.type === "OPEN" ? C.b : C.g}`,
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 10 }}>
                    <span style={{ fontWeight: 800, color: l.type === "OPEN" ? C.b : C.g }}>{l.type}</span>
                    {l.side && <span style={{ color: l.side === "yes" ? C.g : C.r }}>{l.side.toUpperCase()}</span>}
                    <span style={{ color: C.dm }}>{l.city} {l.qty}×</span>
                    {l.live && <Pill color={C.g}>LIVE</Pill>}
                  </div>
                  <span style={{ fontSize: 9, color: C.dm }}>{new Date(l.time).toLocaleTimeString()}</span>
                </div>
                {l.reason && <div style={{ fontSize: 9, color: C.dm, marginTop: 2, opacity: 0.7 }}>{l.reason.slice(0, 80)}</div>}
              </div>
            ))}
          </>)}
        </div>
      </div>
    </>
  );
}
