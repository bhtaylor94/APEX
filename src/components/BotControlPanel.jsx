import { useEffect, useState } from "react";

function num(v) { return Number(v); }

export default function BotControlPanel() {
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState(null);
  const [cfg, setCfg] = useState({
    enabled: false,
    mode: "paper",
    seriesTicker: "kxbtc15m",
    tradeSizeUsd: 5,
    minConfidence: 0.55,
    takeProfitPct: 0.20,
    stopLossPct: 0.12,
    minMinutesToCloseToEnter: 3,
    minMinutesToCloseToHold: 2,
    cooldownMinutes: 8,
    maxTradesPerDay: 10,
    dailyMaxLossUsd: 25
  });

  async function fetchStatus() {
    setLoading(true);
    try {
      const res = await fetch("/api/bot/status", { headers: token ? { "x-bot-token": token } : {} });
      const data = await res.json();
      setStatus(data);
      if (data?.config) setCfg((prev) => ({ ...prev, ...data.config }));
    } finally {
      setLoading(false);
    }
  }

  async function saveConfig(next) {
    setLoading(true);
    try {
      const res = await fetch("/api/bot/config", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "x-bot-token": token } : {})
        },
        body: JSON.stringify(next)
      });
      const data = await res.json();
      if (!data.ok) alert(data.error || "Save failed");
      await fetchStatus();
    } finally {
      setLoading(false);
    }
  }

  async function kill() {
    setLoading(true);
    try {
      const res = await fetch("/api/bot/kill", {
        method: "POST",
        headers: token ? { "x-bot-token": token } : {}
      });
      const data = await res.json();
      if (!data.ok) alert(data.error || "Kill failed");
      await fetchStatus();
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchStatus(); }, []);

  return (
    <div style={{ border: "1px solid #333", borderRadius: 12, padding: 16, marginTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <h3 style={{ margin: 0 }}>Bot Controls (Kalshi BTC 15m)</h3>
        <button onClick={fetchStatus} disabled={loading}>{loading ? "Loading..." : "Refresh"}</button>
      </div>

      <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center" }}>
        <label style={{ width: 120 }}>UI Token</label>
        <input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="BOT_UI_TOKEN"
          style={{ flex: 1 }}
        />
        <button onClick={fetchStatus} disabled={loading}>Apply</button>
      </div>

      <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <label>
          Enabled
          <input
            type="checkbox"
            checked={!!cfg.enabled}
            onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })}
            style={{ marginLeft: 10 }}
          />
        </label>

        <label>
          Mode
          <select value={cfg.mode} onChange={(e) => setCfg({ ...cfg, mode: e.target.value })} style={{ marginLeft: 10 }}>
            <option value="paper">paper</option>
            <option value="live">live</option>
          </select>
        </label>

        <label>
          Trade Size (USD)
          <input type="number" value={cfg.tradeSizeUsd} onChange={(e) => setCfg({ ...cfg, tradeSizeUsd: num(e.target.value) })} />
        </label>

        <label>
          Min Confidence
          <input type="number" step="0.01" value={cfg.minConfidence} onChange={(e) => setCfg({ ...cfg, minConfidence: num(e.target.value) })} />
        </label>

        <label>
          Take Profit (% as decimal)
          <input type="number" step="0.01" value={cfg.takeProfitPct} onChange={(e) => setCfg({ ...cfg, takeProfitPct: num(e.target.value) })} />
        </label>

        <label>
          Stop Loss (% as decimal)
          <input type="number" step="0.01" value={cfg.stopLossPct} onChange={(e) => setCfg({ ...cfg, stopLossPct: num(e.target.value) })} />
        </label>
      </div>

      <div style={{ marginTop: 12, display: "flex", gap: 10 }}>
        <button onClick={() => saveConfig(cfg)} disabled={loading}>Save Config</button>
        <button onClick={kill} disabled={loading} style={{ background: "#8b0000", color: "white" }}>
          KILL SWITCH (Disable Bot)
        </button>
      </div>

      <div style={{ marginTop: 14, fontFamily: "monospace", fontSize: 12, whiteSpace: "pre-wrap" }}>
        <div><b>Last Run:</b> {status?.last_run ? JSON.stringify(status.last_run, null, 2) : "—"}</div>
        <div style={{ marginTop: 10 }}><b>State:</b> {status?.state ? JSON.stringify(status.state, null, 2) : "—"}</div>
      </div>
    </div>
  );
}
