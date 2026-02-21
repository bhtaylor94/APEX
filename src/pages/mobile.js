import { useState, useEffect, useCallback, useRef } from "react";
import Head from "next/head";

export default function MobileDashboard() {
  const [token, setToken] = useState("");
  const [config, setConfig] = useState(null);
  const [balance, setBalance] = useState(null);
  const [positions, setPositions] = useState([]);
  const [settlements, setSettlements] = useState([]);
  const [signal, setSignal] = useState(null);
  const [connected, setConnected] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [error, setError] = useState(null);
  const intervalRef = useRef(null);

  // Read token from URL on mount — also allow no-token access
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("token") || "none";
    setToken(t);
  }, []);

  const headers = useCallback(() => {
    const h = { "Content-Type": "application/json" };
    if (token) h["x-bot-token"] = token;
    return h;
  }, [token]);

  const fetchAll = useCallback(async () => {
    try {
      const [statusRes, balRes, posRes, setRes] = await Promise.all([
        fetch("/api/bot/status", { headers: headers() }),
        fetch("/api/kalshi/balance"),
        fetch("/api/kalshi/positions"),
        fetch("/api/kalshi/settlements?limit=5"),
      ]);

      const statusData = await statusRes.json();
      if (statusData.ok) {
        setConfig(statusData.config);
        // Adapt to new per-series format or old flat format
        const s15 = statusData.series?.["15M"] || {};
        const s1H = statusData.series?.["1H"] || {};
        const sig15 = s15.state?.lastSignal || s15.state?.signal || null;
        const sig1H = s1H.state?.lastSignal || s1H.state?.signal || null;
        setSignal({ "15M": sig15, "1H": sig1H });
        setConnected(true);
      }

      const balData = await balRes.json();
      if (!balData.error) {
        setBalance(balData);
      }

      const posData = await posRes.json();
      setPositions(posData.market_positions || posData.positions || []);

      const setData = await setRes.json();
      setSettlements(setData.settlements || []);

      setLastUpdate(new Date());
    } catch {
      setConnected(false);
    }
  }, [headers]);

  // Start polling when token is set
  useEffect(() => {
    if (!token) return;
    fetchAll();
    intervalRef.current = setInterval(fetchAll, 10000);
    return () => clearInterval(intervalRef.current);
  }, [token, fetchAll]);

  const toggleBot = async () => {
    if (!config || toggling) return;
    setToggling(true);
    setError(null);
    try {
      const res = await fetch("/api/bot/config", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ enabled: !config.enabled }),
      });
      const data = await res.json();
      if (data.ok) {
        setConfig(data.config);
      } else {
        setError(data.error || "Toggle failed");
      }
    } catch (e) {
      setError("Network error: " + (e.message || "unknown"));
    }
    setToggling(false);
  };

  const enabled = config?.enabled;
  const mode = config?.mode || "paper";
  const isLive = mode === "live";

  const fmt = (n) => {
    if (n == null) return "--";
    return "$" + (Number(n) / 100).toFixed(2);
  };

  const fmtUsd = (n) => {
    if (n == null) return "--";
    return "$" + Number(n).toFixed(2);
  };

  return (
    <>
      <Head>
        <title>APEX Mobile</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="theme-color" content="#0a0a0f" />
      </Head>
      <div style={S.page}>
        {/* Header */}
        <div style={S.header}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={S.title}>APEX</span>
            <span style={{
              width: 8, height: 8, borderRadius: "50%",
              background: connected ? (enabled ? "#4caf50" : "#ff9800") : "#f44336",
              display: "inline-block",
            }} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{
              ...S.badge,
              background: isLive ? "rgba(244,67,54,0.2)" : "rgba(255,152,0,0.2)",
              color: isLive ? "#f44336" : "#ff9800",
            }}>
              {isLive ? "LIVE" : "PAPER"}
            </span>
            {lastUpdate && (
              <span style={{ color: "#555", fontSize: 11 }}>
                {lastUpdate.toLocaleTimeString()}
              </span>
            )}
          </div>
        </div>

        {/* Toggle */}
        <div style={S.card} onClick={toggleBot}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ color: "#aaa", fontSize: 14 }}>Bot Status</span>
            <div style={{
              ...S.toggle,
              background: enabled ? "#4caf50" : "#333",
              opacity: toggling ? 0.5 : 1,
            }}>
              <div style={{
                ...S.toggleKnob,
                transform: enabled ? "translateX(26px)" : "translateX(2px)",
              }} />
            </div>
          </div>
          <div style={{ marginTop: 8, fontSize: 24, fontWeight: 700, color: enabled ? "#4caf50" : "#666" }}>
            {toggling ? "..." : enabled ? "RUNNING" : "OFF"}
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div style={{ background: "rgba(244,67,54,0.15)", border: "1px solid #f4433633", borderRadius: 10, padding: "10px 14px", marginBottom: 12, color: "#f44336", fontSize: 13 }}>
            {error}
          </div>
        )}

        {/* Balance */}
        <div style={S.card}>
          <span style={S.label}>Balance</span>
          <div style={{ fontSize: 28, fontWeight: 700, color: "#fff", marginTop: 4 }}>
            {balance?.balance != null ? fmtUsd(balance.balance / 100) : "--"}
          </div>
          {balance?.portfolio_value != null && (
            <span style={{ color: "#888", fontSize: 13 }}>
              Portfolio: {fmtUsd(balance.portfolio_value / 100)}
            </span>
          )}
        </div>

        {/* Signal */}
        <div style={S.card}>
          <span style={S.label}>Signal</span>
          {config ? (
            <div style={{ marginTop: 8 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Pill label="Edge" value={(config.minEdge || 5) + "\u00A2"} />
                <Pill label="15M Band" value={(config.minEntryPriceCents || 35) + "-" + (config.maxEntryPriceCents || 80) + "\u00A2"} />
                <Pill label="15M Gate" value={(config.minMinutesToCloseToEnter || 10) + "m"} />
                {config.hourlyEnabled && <Pill label="1H Gate" value={(config.hourly_minMinutesToCloseToEnter || 30) + "m"} />}
              </div>
              {signal && (
                <>
                  <SignalBlock label="15M" sig={signal["15M"]} />
                  {config.hourlyEnabled && <SignalBlock label="1H" sig={signal["1H"]} />}
                </>
              )}
            </div>
          ) : (
            <span style={{ color: "#555" }}>Loading...</span>
          )}
        </div>

        {/* Positions */}
        <div style={S.card}>
          <span style={S.label}>Positions</span>
          {positions.length === 0 ? (
            <div style={{ color: "#555", marginTop: 8, fontSize: 14 }}>No open positions</div>
          ) : (
            positions.map((p, i) => (
              <div key={i} style={S.row}>
                <div>
                  <span style={{ color: "#fff", fontSize: 14, fontWeight: 600 }}>{p.ticker}</span>
                  <span style={{ color: "#888", fontSize: 12, marginLeft: 8 }}>
                    {(p.market_position || p.position || "").toUpperCase()}
                  </span>
                </div>
                <div style={{ textAlign: "right" }}>
                  <span style={{ color: "#fff", fontSize: 14 }}>
                    {p.total_traded || p.quantity || "--"}x
                  </span>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Recent Settlements */}
        <div style={S.card}>
          <span style={S.label}>Recent Settlements</span>
          {settlements.length === 0 ? (
            <div style={{ color: "#555", marginTop: 8, fontSize: 14 }}>No settlements yet</div>
          ) : (
            settlements.map((s, i) => {
              const cost = Number(s.yes_total_cost || 0) + Number(s.no_total_cost || 0);
              const rev = Number(s.revenue || 0);
              const pnl = rev - cost;
              const pnlColor = pnl > 0 ? "#4caf50" : pnl < 0 ? "#f44336" : "#888";
              return (
                <div key={i} style={S.row}>
                  <div>
                    <span style={{ color: "#ccc", fontSize: 13 }}>
                      {s.ticker?.replace("KXBTC15M-", "").replace("KXBTC-", "1H ") || "??"}
                    </span>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <span style={{ color: pnlColor, fontSize: 14, fontWeight: 600 }}>
                      {pnl >= 0 ? "+" : ""}{fmtUsd(pnl / 100)}
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div style={{ height: 40 }} />
      </div>
    </>
  );
}

function SignalBlock({ label, sig }) {
  if (!sig || !sig.indicators) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ color: "#aaa", fontSize: 12 }}>{label} Indicators</span>
        <span style={{ color: "#aaa", fontSize: 12 }}>
          {sig.direction?.toUpperCase() || "NEUTRAL"}
          {sig.confidence > 0 ? ` (${(sig.confidence * 100).toFixed(0)}%)` : ""}
        </span>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {Object.entries(sig.indicators).map(([key, val]) => {
          const v = typeof val === "object" ? val.score || val.signal || 0 : val;
          return (
            <span key={key} style={{
              fontSize: 11, fontWeight: 700, padding: "4px 8px", borderRadius: 6,
              border: "1px solid", letterSpacing: 0.5,
              background: v > 0 ? "rgba(76,175,80,0.15)" : v < 0 ? "rgba(244,67,54,0.15)" : "rgba(255,255,255,0.05)",
              color: v > 0 ? "#4caf50" : v < 0 ? "#f44336" : "#666",
              borderColor: v > 0 ? "#4caf5033" : v < 0 ? "#f4433633" : "#ffffff0a",
            }}>
              {key.toUpperCase()} {v > 0 ? "UP" : v < 0 ? "DN" : "--"}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function Pill({ label, value }) {
  return (
    <div style={{
      background: "rgba(255,255,255,0.05)",
      borderRadius: 8,
      padding: "4px 10px",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      minWidth: 60,
    }}>
      <span style={{ color: "#555", fontSize: 10, textTransform: "uppercase" }}>{label}</span>
      <span style={{ color: "#fff", fontSize: 14, fontWeight: 600 }}>{value}</span>
    </div>
  );
}

const S = {
  page: {
    minHeight: "100vh",
    background: "#0a0a0f",
    padding: "16px",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    maxWidth: 480,
    margin: "0 auto",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
    padding: "8px 0",
  },
  title: {
    fontSize: 22,
    fontWeight: 800,
    color: "#fff",
    letterSpacing: 2,
  },
  badge: {
    fontSize: 11,
    fontWeight: 700,
    padding: "3px 8px",
    borderRadius: 6,
    letterSpacing: 1,
  },
  card: {
    background: "#141419",
    borderRadius: 14,
    padding: "16px 18px",
    marginBottom: 12,
    border: "1px solid #1e1e28",
    cursor: "default",
  },
  label: {
    color: "#888",
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 1,
    fontWeight: 600,
  },
  toggle: {
    width: 52,
    height: 28,
    borderRadius: 14,
    position: "relative",
    transition: "background 0.2s",
    cursor: "pointer",
  },
  toggleKnob: {
    width: 24,
    height: 24,
    borderRadius: 12,
    background: "#fff",
    position: "absolute",
    top: 2,
    transition: "transform 0.2s",
  },
  indicator: {
    fontSize: 11,
    fontWeight: 700,
    padding: "4px 8px",
    borderRadius: 6,
    border: "1px solid",
    letterSpacing: 0.5,
  },
  row: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "10px 0",
    borderBottom: "1px solid #1a1a22",
  },
};
