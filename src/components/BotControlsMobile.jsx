import { useEffect, useMemo, useState } from "react";

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function toNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export default function BotControlsMobile() {
  const [token, setToken] = useState("");
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const cfg = useMemo(() => ({
    enabled: !!status?.config?.enabled,
    mode: status?.config?.mode || "paper",
    tradeSizeUsd: toNum(status?.config?.tradeSizeUsd, 5),
    minConfidence: toNum(status?.config?.minConfidence, 0.55),
    takeProfitPct: toNum(status?.config?.takeProfitPct, 0.20),
    stopLossPct: toNum(status?.config?.stopLossPct, 0.12),
    seriesTicker: status?.config?.seriesTicker || "kxbtc15m"
  }), [status]);

  useEffect(() => {
    const saved = localStorage.getItem("BOT_UI_TOKEN") || "";
    setToken(saved);
  }, []);

  async function refresh() {
    setBusy(true);
    try {
      const res = await fetch("/api/bot/status");
      const data = await res.json();
      setStatus(data);
    } finally {
      setBusy(false);
    }
  }

  async function setConfig(partial) {
    setBusy(true);
    try {
      localStorage.setItem("BOT_UI_TOKEN", token);
      const res = await fetch("/api/bot/config", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "x-bot-token": token } : {})
        },
        body: JSON.stringify(partial)
      });
      const data = await res.json();
      if (!data.ok) alert(data.error || "Save failed");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function kill() {
    setBusy(true);
    try {
      localStorage.setItem("BOT_UI_TOKEN", token);
      const res = await fetch("/api/bot/kill", {
        method: "POST",
        headers: token ? { "x-bot-token": token } : {}
      });
      const data = await res.json();
      if (!data.ok) alert(data.error || "Kill failed");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  const last = status?.last_run || null;
  const pos = status?.state?.position || null;

  return (
    <div style={{ maxWidth: 520, margin: "0 auto", padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 800 }}>BTC 15m Bot</div>
          <div style={{ opacity: 0.75, fontSize: 12 }}>Kalshi series: {cfg.seriesTicker}</div>
        </div>
        <button onClick={refresh} disabled={busy} style={{ padding: "10px 14px", borderRadius: 12 }}>
          {busy ? "…" : "Refresh"}
        </button>
      </div>

      <div style={{ marginTop: 12, border: "1px solid rgba(255,255,255,0.15)", borderRadius: 16, padding: 14 }}>
        <div style={{ fontWeight: 700 }}>
          Status: {cfg.enabled ? "ON" : "OFF"} • Mode: {cfg.mode.toUpperCase()}
        </div>
        <div style={{ opacity: 0.85, fontSize: 12, marginTop: 6 }}>
          Last action: {last?.action || "—"} • Market: {last?.marketTicker || "—"}
        </div>
        <div style={{ opacity: 0.85, fontSize: 12, marginTop: 4 }}>
          Last signal: {last?.signalDir || "—"} ({last?.confidence ?? "—"})
        </div>
        <div style={{ marginTop: 10, opacity: 0.9, fontSize: 12 }}>
          Open position: {pos ? `${pos.marketTicker} • ${pos.side?.toUpperCase()} • x${pos.count}` : "None"}
        </div>
      </div>

      <div style={{ marginTop: 12, border: "1px solid rgba(255,255,255,0.15)", borderRadius: 16, padding: 14 }}>
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={() => setConfig({ enabled: !cfg.enabled })}
            disabled={busy}
            style={{ flex: 1, padding: "14px 12px", borderRadius: 16, fontWeight: 800 }}
          >
            {cfg.enabled ? "Turn OFF" : "Turn ON"}
          </button>

          <button
            onClick={() => setConfig({ mode: cfg.mode === "live" ? "paper" : "live" })}
            disabled={busy}
            style={{ flex: 1, padding: "14px 12px", borderRadius: 16, fontWeight: 800 }}
          >
            Switch to {cfg.mode === "live" ? "PAPER" : "LIVE"}
          </button>
        </div>

        <div style={{ marginTop: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <div style={{ fontWeight: 700 }}>Trade Size</div>
            <div style={{ opacity: 0.85 }}>${cfg.tradeSizeUsd}</div>
          </div>
          <input
            type="range"
            min="1"
            max="50"
            value={cfg.tradeSizeUsd}
            onChange={(e) => setConfig({ tradeSizeUsd: clamp(toNum(e.target.value, 5), 1, 50) })}
            style={{ width: "100%", marginTop: 6 }}
          />
        </div>

        <div style={{ marginTop: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <div style={{ fontWeight: 700 }}>Confidence</div>
            <div style={{ opacity: 0.85 }}>{cfg.minConfidence.toFixed(2)}</div>
          </div>
          <input
            type="range"
            min="0.40"
            max="0.90"
            step="0.01"
            value={cfg.minConfidence}
            onChange={(e) => setConfig({ minConfidence: clamp(toNum(e.target.value, 0.55), 0.40, 0.90) })}
            style={{ width: "100%", marginTop: 6 }}
          />
          <div style={{ opacity: 0.75, fontSize: 12, marginTop: 6 }}>
            Lower = more trades • Higher = fewer trades
          </div>
        </div>

        <details style={{ marginTop: 14 }}>
          <summary style={{ fontWeight: 700, cursor: "pointer" }}>Advanced</summary>
          <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <label style={{ fontSize: 12 }}>
              Take Profit (0.20 = 20%)
              <input
                type="number"
                step="0.01"
                value={cfg.takeProfitPct}
                onChange={(e) => setConfig({ takeProfitPct: clamp(toNum(e.target.value, 0.20), 0.01, 1) })}
                style={{ width: "100%", padding: 10, borderRadius: 10, marginTop: 6 }}
              />
            </label>
            <label style={{ fontSize: 12 }}>
              Stop Loss (0.12 = 12%)
              <input
                type="number"
                step="0.01"
                value={cfg.stopLossPct}
                onChange={(e) => setConfig({ stopLossPct: clamp(toNum(e.target.value, 0.12), 0.01, 1) })}
                style={{ width: "100%", padding: 10, borderRadius: 10, marginTop: 6 }}
              />
            </label>
          </div>
        </details>
      </div>

      <div style={{ marginTop: 12, border: "1px solid rgba(255,255,255,0.15)", borderRadius: 16, padding: 14 }}>
        <div style={{ fontWeight: 800, marginBottom: 8 }}>Security</div>
        <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
          Token is only required to change settings or kill the bot.
        </div>
        <input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="BOT_UI_TOKEN"
          style={{ width: "100%", padding: 12, borderRadius: 12 }}
        />
        <button
          onClick={kill}
          disabled={busy}
          style={{ width: "100%", marginTop: 10, padding: "14px 12px", borderRadius: 16, background: "#b00020", color: "white", fontWeight: 900 }}
        >
          KILL BOT (Disable)
        </button>
      </div>
    </div>
  );
}
