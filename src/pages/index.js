import { useState, useEffect, useCallback, useRef } from "react";
import Head from "next/head";

export default function Dashboard() {
  const [status, setStatus] = useState(null);
  const [signals, setSignals] = useState([]);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [lastScan, setLastScan] = useState(null);
  const logRef = useRef(null);

  // ─── Logging ─────────────────────────────────────────────
  const addLog = useCallback((message, level = "info") => {
    const time = new Date().toLocaleTimeString("en-US", { hour12: false });
    setLogs((prev) => [...prev.slice(-200), { time, message, level }]);
    setTimeout(() => {
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    }, 50);
  }, []);

  // ─── Fetch Status ────────────────────────────────────────
  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/status");
      const data = await res.json();
      setStatus(data);
      if (data.auth.connected) {
        addLog(`Connected — Balance: ${data.account.balanceFormatted}`, "success");
      } else {
        addLog(`Auth failed: ${data.auth.error || "Unknown error"}`, "error");
      }
    } catch (err) {
      addLog(`Status fetch failed: ${err.message}`, "error");
    } finally {
      setLoading(false);
    }
  }, [addLog]);

  // ─── Run Scan ────────────────────────────────────────────
  const runScan = useCallback(async () => {
    setScanning(true);
    addLog("Starting strategy scan...", "info");
    try {
      const res = await fetch("/api/bot/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categories: ["weather", "economic"] }),
      });
      const data = await res.json();
      if (data.error) {
        addLog(`Scan error: ${data.error}`, "error");
      } else {
        setSignals(data.signals || []);
        setLastScan(new Date().toLocaleTimeString());
        addLog(`Scan complete: ${data.signalCount} signal(s) found`, data.signalCount > 0 ? "success" : "info");
        for (const sig of (data.signals || []).slice(0, 5)) {
          addLog(`  → ${sig.ticker} ${sig.side.toUpperCase()} | EV=$${sig.ev} | edge=${sig.edge > 0 ? "+" : ""}${(sig.edge * 100).toFixed(1)}% | ${sig.strategy}`, "info");
        }
      }
    } catch (err) {
      addLog(`Scan failed: ${err.message}`, "error");
    } finally {
      setScanning(false);
    }
  }, [addLog]);

  // ─── Initial Load ────────────────────────────────────────
  useEffect(() => {
    addLog("APEX Trading Bot v2.0 starting...", "info");
    fetchStatus();
    const interval = setInterval(fetchStatus, 30000);
    return () => clearInterval(interval);
  }, [fetchStatus, addLog]);

  // ─── Render Helpers ──────────────────────────────────────
  const connected = status?.auth?.connected;
  const exchangeOnline = status?.exchange?.active;
  const tradingActive = status?.exchange?.trading;
  const isDryRun = status?.config?.dryRun !== false;
  const envLabel = status?.config?.env === "prod" ? "PRODUCTION" : "DEMO";

  return (
    <>
      <Head>
        <title>APEX — Kalshi Trading Bot</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div className="container">
        {/* ─── Header ─────────────────────────────────────── */}
        <header className="header">
          <div className="logo">
            <div className="logo-icon">AX</div>
            <h1>
              APEX
              <span>Trading Bot v2.0</span>
            </h1>
          </div>
          <div className="header-actions">
            {loading ? (
              <span className="badge badge-yellow"><span className="dot pulse" /> Connecting</span>
            ) : connected ? (
              <span className="badge badge-green"><span className="dot pulse" /> Connected</span>
            ) : (
              <span className="badge badge-red"><span className="dot" /> Disconnected</span>
            )}
            <span className={`badge ${isDryRun ? "badge-blue" : "badge-red"}`}>
              {isDryRun ? "Dry Run" : "LIVE"}
            </span>
            <span className={`badge ${envLabel === "DEMO" ? "badge-yellow" : "badge-red"}`}>
              {envLabel}
            </span>
          </div>
        </header>

        {/* ─── Stats Cards ────────────────────────────────── */}
        <div className="grid grid-4">
          <div className="card">
            <div className="card-label">Account Balance</div>
            <div className="card-value" style={{ color: connected ? "var(--accent-green)" : "var(--text-muted)" }}>
              {loading ? "..." : connected ? status.account.balanceFormatted : "—"}
            </div>
            <div className="card-sub">{connected ? `${envLabel} environment` : "Not connected"}</div>
          </div>

          <div className="card">
            <div className="card-label">Open Positions</div>
            <div className="card-value">{status?.positions?.count ?? "—"}</div>
            <div className="card-sub">
              {status?.positions?.totalExposureFormatted
                ? `${status.positions.totalExposureFormatted} exposure`
                : "No positions"}
            </div>
          </div>

          <div className="card">
            <div className="card-label">Exchange</div>
            <div className="card-value" style={{ fontSize: 20, color: exchangeOnline ? "var(--accent-green)" : "var(--accent-red)" }}>
              {loading ? "..." : exchangeOnline ? "Online" : "Offline"}
            </div>
            <div className="card-sub">{tradingActive ? "Trading active" : "Trading paused"}</div>
          </div>

          <div className="card">
            <div className="card-label">Trade Signals</div>
            <div className="card-value">{signals.length}</div>
            <div className="card-sub">{lastScan ? `Last scan: ${lastScan}` : "No scans yet"}</div>
          </div>
        </div>

        {/* ─── Connection Status Panel ────────────────────── */}
        <div className="section">
          <div className="section-header">
            <span className="section-title">Connection Status</span>
            <button className="btn" onClick={fetchStatus} disabled={loading}>
              ↻ Refresh
            </button>
          </div>
          <div className="section-body">
            <div className="status-grid">
              <div className="status-item">
                <span className="status-icon">{exchangeOnline ? "🟢" : "🔴"}</span>
                <div className="status-info">
                  <div className="status-info-label">Exchange</div>
                  <div className="status-info-value">{exchangeOnline ? "Online" : "Offline"}</div>
                </div>
              </div>
              <div className="status-item">
                <span className="status-icon">{tradingActive ? "🟢" : "⏸️"}</span>
                <div className="status-info">
                  <div className="status-info-label">Trading</div>
                  <div className="status-info-value">{tradingActive ? "Active" : "Paused"}</div>
                </div>
              </div>
              <div className="status-item">
                <span className="status-icon">{connected ? "🔑" : "❌"}</span>
                <div className="status-info">
                  <div className="status-info-label">API Auth</div>
                  <div className="status-info-value">{connected ? "Verified" : status?.auth?.error || "Failed"}</div>
                </div>
              </div>
              <div className="status-item">
                <span className="status-icon">💰</span>
                <div className="status-info">
                  <div className="status-info-label">Balance</div>
                  <div className="status-info-value">{status?.account?.balanceFormatted || "—"}</div>
                </div>
              </div>
              <div className="status-item">
                <span className="status-icon">📊</span>
                <div className="status-info">
                  <div className="status-info-label">Positions</div>
                  <div className="status-info-value">{status?.positions?.count ?? 0} open</div>
                </div>
              </div>
              <div className="status-item">
                <span className="status-icon">📈</span>
                <div className="status-info">
                  <div className="status-info-label">Exposure</div>
                  <div className="status-info-value">{status?.positions?.totalExposureFormatted || "$0.00"}</div>
                </div>
              </div>
              <div className="status-item">
                <span className="status-icon">{isDryRun ? "📋" : "🔴"}</span>
                <div className="status-info">
                  <div className="status-info-label">Mode</div>
                  <div className="status-info-value">{isDryRun ? "Dry Run" : "LIVE"}</div>
                </div>
              </div>
              <div className="status-item">
                <span className="status-icon">🛡️</span>
                <div className="status-info">
                  <div className="status-info-label">Max Daily Loss</div>
                  <div className="status-info-value">${status?.config?.maxDailyLoss || 50}</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ─── Open Positions ─────────────────────────────── */}
        {status?.positions?.items?.length > 0 && (
          <div className="section">
            <div className="section-header">
              <span className="section-title">Open Positions ({status.positions.count})</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Ticker</th>
                    <th>Event</th>
                    <th>Exposure</th>
                    <th>Resting Orders</th>
                  </tr>
                </thead>
                <tbody>
                  {status.positions.items.map((p) => (
                    <tr key={p.ticker}>
                      <td className="text-blue">{p.ticker}</td>
                      <td className="text-muted">{p.eventTicker}</td>
                      <td>${p.exposure}</td>
                      <td>{p.restingOrders}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ─── Bot Scanner ────────────────────────────────── */}
        <div className="section">
          <div className="section-header">
            <span className="section-title">Strategy Scanner</span>
            <button className="btn btn-primary" onClick={runScan} disabled={scanning || !connected}>
              {scanning ? (
                <><span className="spinner" /> Scanning...</>
              ) : (
                "▶ Run Scan"
              )}
            </button>
          </div>

          {signals.length > 0 ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Ticker</th>
                    <th>Strategy</th>
                    <th>Side</th>
                    <th>Price</th>
                    <th>Edge</th>
                    <th>EV</th>
                    <th>Confidence</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {signals.map((s, i) => (
                    <tr key={i}>
                      <td className="text-blue">{s.ticker}</td>
                      <td className="text-muted" style={{ fontFamily: "inherit", fontSize: 12 }}>{s.strategy}</td>
                      <td>
                        <span className={`badge ${s.side === "yes" ? "badge-green" : "badge-red"}`} style={{ fontSize: 11 }}>
                          {s.side.toUpperCase()}
                        </span>
                      </td>
                      <td>{s.price}¢</td>
                      <td className={s.edge > 0 ? "text-green" : "text-red"}>
                        {s.edge > 0 ? "+" : ""}{(s.edge * 100).toFixed(1)}%
                      </td>
                      <td className="text-green">${s.ev}</td>
                      <td>{(s.confidence * 100).toFixed(0)}%</td>
                      <td className="text-muted" style={{ fontFamily: "inherit", fontSize: 11, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {s.reasoning}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty">
              {scanning ? "Scanning markets..." : "No signals yet. Click \"Run Scan\" to analyze markets."}
            </div>
          )}
        </div>

        {/* ─── Activity Log ───────────────────────────────── */}
        <div className="section">
          <div className="section-header">
            <span className="section-title">Activity Log</span>
            <button className="btn" onClick={() => setLogs([])} style={{ fontSize: 12 }}>
              Clear
            </button>
          </div>
          <div className="section-body">
            <div className="log" ref={logRef}>
              {logs.length === 0 ? (
                <div style={{ color: "var(--text-muted)" }}>Waiting for activity...</div>
              ) : (
                logs.map((l, i) => (
                  <div key={i} className="log-line">
                    <span className="log-time">[{l.time}]</span>{" "}
                    <span className={`log-${l.level}`}>{l.message}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* ─── Footer ─────────────────────────────────────── */}
        <footer style={{ textAlign: "center", padding: "16px 0", color: "var(--text-muted)", fontSize: 12 }}>
          APEX Trading Bot • Weather & Economic Markets on Kalshi • For educational purposes only
        </footer>
      </div>
    </>
  );
}
