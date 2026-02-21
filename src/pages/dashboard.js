import { useState, useEffect, useRef } from "react";
import Head from "next/head";

const DEFAULT_W = { rsi: 2, vwap: 2, ob: 2 };
const INDICATORS = ["rsi", "vwap", "ob"];

function pnl$(c) { return (c >= 0 ? "+$" : "-$") + (Math.abs(c) / 100).toFixed(2); }
function isWin(t) { return t.result === "win" || t.result === "tp_exit"; }

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const ref = useRef(null);

  const token = () => typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("token") || "" : "";

  const load = async () => {
    try {
      const t = token();
      const r = await fetch("/api/bot/learning", { headers: t ? { "x-bot-token": t } : {} });
      const j = await r.json();
      if (j.ok) { setData(j); setErr(null); } else setErr(j.error || "Failed");
    } catch (e) { setErr(e.message); }
  };

  useEffect(() => { load(); ref.current = setInterval(load, 15000); return () => clearInterval(ref.current); }, []);

  const pg = { background: "#000", color: "#fff", fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro', sans-serif", minHeight: "100vh", padding: "20px 16px", maxWidth: 480, margin: "0 auto" };
  const grp = { background: "#1c1c1e", borderRadius: 12, overflow: "hidden", marginBottom: 8 };
  const sep = { height: 1, background: "#1c1c1e", margin: "20px 0" };
  const sectionLabel = { fontSize: 13, fontWeight: 600, color: "#86868b", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 10 };

  if (err && !data) return (
    <div style={pg}><Head><title>APEX</title><meta name="viewport" content="width=device-width, initial-scale=1" /></Head>
      <p style={{ color: "#ff453a", fontSize: 15 }}>{err}</p>
    </div>
  );
  if (!data) return (
    <div style={{ ...pg, display: "flex", justifyContent: "center", paddingTop: 80 }}>
      <Head><title>APEX</title><meta name="viewport" content="width=device-width, initial-scale=1" /></Head>
      <span style={{ color: "#86868b", fontSize: 15 }}>Loading...</span>
    </div>
  );

  const learned = data.learned || {};
  const trades = data.tradeHistory || [];
  const daily = data.dailyStats || {};
  const stats = learned.indicatorStats || {};
  const weights = learned.weights || {};
  const hourly = learned.hourlyStats || {};
  const combos = learned.comboStats || {};
  const pos = data.position;

  const wins = trades.filter(isWin).length;
  const losses = trades.length - wins;
  const totalPnl = trades.reduce((s, t) => s + (t.pnlCents || 0), 0);
  const wr = trades.length > 0 ? Math.round((wins / trades.length) * 100) : 0;

  // Sparkline
  let cum = 0;
  const pts = trades.map(t => { cum += (t.pnlCents || 0); return cum; });
  const pMin = Math.min(0, ...pts), pMax = Math.max(1, ...pts);
  const spark = pts.map((y, i) => {
    const x = pts.length > 1 ? (i / (pts.length - 1)) * 440 : 220;
    const sy = 48 - ((y - pMin) / (pMax - pMin || 1)) * 44 - 2;
    return x.toFixed(1) + "," + sy.toFixed(1);
  }).join(" ");

  // Indicator learning data
  const indRows = INDICATORS.map(id => {
    const st = stats[id] || { correct: 0, wrong: 0 };
    const total = st.correct + (st.wrong || 0);
    const acc = total > 0 ? Math.round((st.correct / total) * 100) : null;
    const w = weights[id] ?? DEFAULT_W[id];
    const def = DEFAULT_W[id];
    const diff = w - def;
    return { id: id.toUpperCase(), acc, w, def, diff, total, correct: st.correct, wrong: st.wrong || 0 };
  });

  // Insights — auto-generated from data
  const insights = [];
  // Indicator insights
  const qualified = indRows.filter(r => r.total >= 3);
  if (qualified.length >= 2) {
    const best = qualified.reduce((a, b) => a.acc > b.acc ? a : b);
    const worst = qualified.reduce((a, b) => a.acc < b.acc ? a : b);
    if (best.acc > worst.acc) {
      insights.push({ text: best.id + " is most accurate at " + best.acc + "%", good: true });
      insights.push({ text: worst.id + " is weakest at " + worst.acc + "% — needs work", good: false });
    }
  }
  // Weight drift
  const boosted = indRows.filter(r => r.diff > 0.1);
  const dropped = indRows.filter(r => r.diff < -0.1);
  boosted.forEach(r => insights.push({ text: r.id + " weight boosted to " + r.w.toFixed(1) + " (default " + r.def + ")", good: true }));
  dropped.forEach(r => insights.push({ text: r.id + " weight dropped to " + r.w.toFixed(1) + " (default " + r.def + ")", good: false }));
  // Untested indicators
  const untested = indRows.filter(r => r.total === 0);
  untested.forEach(r => insights.push({ text: r.id + " has no data yet — can't evaluate", good: null }));
  // Mode
  if (learned.mode === "recovery") insights.push({ text: "Bot is in RECOVERY mode — trading conservatively", good: false });
  // Loss streak
  if ((learned.lossStreak || 0) >= 3) insights.push({ text: "On a " + learned.lossStreak + "-loss streak", good: false });
  // Hourly
  const hourEntries = Object.entries(hourly).filter(([, h]) => h?.total >= 3);
  if (hourEntries.length >= 2) {
    const bestH = hourEntries.reduce((a, b) => (a[1].wins / a[1].total) > (b[1].wins / b[1].total) ? a : b);
    const worstH = hourEntries.reduce((a, b) => (a[1].wins / a[1].total) < (b[1].wins / b[1].total) ? a : b);
    insights.push({ text: "Best hour: " + bestH[0] + " UTC (" + Math.round((bestH[1].wins / bestH[1].total) * 100) + "% WR)", good: true });
    if (Math.round((worstH[1].wins / worstH[1].total) * 100) < 35)
      insights.push({ text: "Worst hour: " + worstH[0] + " UTC (" + Math.round((worstH[1].wins / worstH[1].total) * 100) + "% WR)", good: false });
  }
  // Combos
  const comboEntries = Object.entries(combos).filter(([, c]) => c.total >= 3);
  if (comboEntries.length >= 1) {
    const bestC = comboEntries.reduce((a, b) => (a[1].wins / a[1].total) > (b[1].wins / b[1].total) ? a : b);
    insights.push({ text: "Best combo: " + bestC[0] + " at " + Math.round((bestC[1].wins / bestC[1].total) * 100) + "% WR", good: true });
  }

  // Exit reason breakdown
  const exits = {};
  for (const t of trades) {
    const r = (t.exitReason || "UNKNOWN").toUpperCase();
    if (!exits[r]) exits[r] = { n: 0, pnl: 0, wins: 0 };
    exits[r].n++;
    exits[r].pnl += (t.pnlCents || 0);
    if (isWin(t)) exits[r].wins++;
  }
  const exitList = Object.entries(exits).sort((a, b) => b[1].n - a[1].n);

  // Confidence buckets
  const confBuckets = [
    { label: "Low", desc: "score < 2.5", w: 0, n: 0, pnl: 0 },
    { label: "Med", desc: "score 2.5-3.5", w: 0, n: 0, pnl: 0 },
    { label: "High", desc: "score 4+", w: 0, n: 0, pnl: 0 },
  ];
  for (const t of trades) {
    const sc = t.signal?.score != null ? Math.abs(t.signal.score) : null;
    if (sc == null) continue;
    const b = sc >= 4 ? confBuckets[2] : sc >= 2.5 ? confBuckets[1] : confBuckets[0];
    b.n++;
    b.pnl += (t.pnlCents || 0);
    if (isWin(t)) b.w++;
  }

  // Entry price ranges
  const priceRanges = [
    { label: "35-45c", lo: 35, hi: 45, w: 0, n: 0 },
    { label: "45-55c", lo: 45, hi: 55, w: 0, n: 0 },
    { label: "55-65c", lo: 55, hi: 65, w: 0, n: 0 },
    { label: "65-80c", lo: 65, hi: 80, w: 0, n: 0 },
  ];
  for (const t of trades) {
    const p = t.entryPriceCents;
    if (p == null) continue;
    for (const b of priceRanges) {
      if (p >= b.lo && p < b.hi) { b.n++; if (isWin(t)) b.w++; break; }
    }
  }

  const recent = trades.slice(-12).reverse();

  return (
    <div style={pg}>
      <Head><title>APEX</title><meta name="viewport" content="width=device-width, initial-scale=1" /></Head>

      {/* Hero */}
      <div style={{ textAlign: "center", padding: "16px 0 4px" }}>
        <div style={{ fontSize: 13, color: "#86868b", marginBottom: 4 }}>Total P&L</div>
        <div style={{ fontSize: 44, fontWeight: 700, color: totalPnl >= 0 ? "#30d158" : "#ff453a", letterSpacing: -1 }}>
          {pnl$(totalPnl)}
        </div>
        <div style={{ fontSize: 15, color: "#86868b", marginTop: 4 }}>
          {wins}W {losses}L &middot; {wr}% &middot; {trades.length} trades
        </div>
      </div>
      {pts.length > 1 && (
        <div style={{ padding: "8px 0" }}>
          <svg width="100%" height="50" viewBox="0 0 440 50" preserveAspectRatio="none">
            <polyline points={spark} fill="none" stroke={totalPnl >= 0 ? "#30d158" : "#ff453a"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      )}

      <div style={sep} />

      {/* Today */}
      {daily.date && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>Today</span>
            <span style={{ fontSize: 15, color: (daily.totalPnlCents || 0) >= 0 ? "#30d158" : "#ff453a", fontWeight: 600 }}>
              {pnl$(daily.totalPnlCents || 0)}
            </span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-around", marginBottom: 4 }}>
            <Stat n={daily.totalTrades || 0} l="Trades" />
            <Stat n={(daily.wins || 0) + (daily.takeProfits || 0)} l="Wins" color="#30d158" />
            <Stat n={daily.losses || 0} l="Losses" color="#ff453a" />
          </div>
          <div style={sep} />
        </>
      )}

      {/* Open Position */}
      {pos?.ticker && (
        <>
          <div style={sectionLabel}>Open Position</div>
          <div style={{ ...grp, padding: 14 }}>
            <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6 }}>{pos.ticker}</div>
            <div style={{ display: "flex", gap: 16, fontSize: 14, color: "#86868b" }}>
              <span style={{ color: pos.side === "yes" ? "#30d158" : "#ff453a" }}>{(pos.side || "").toUpperCase()}</span>
              <span>{pos.entryPriceCents}c &times; {pos.count}</span>
            </div>
          </div>
          <div style={sep} />
        </>
      )}

      {/* Insights */}
      {insights.length > 0 && (
        <>
          <div style={sectionLabel}>Insights</div>
          <div style={{ ...grp, padding: 14 }}>
            {insights.map((ins, i) => (
              <div key={i} style={{ fontSize: 14, marginBottom: i < insights.length - 1 ? 8 : 0, lineHeight: 1.4, color: ins.good === true ? "#30d158" : ins.good === false ? "#ff453a" : "#86868b" }}>
                {ins.good === true ? "+" : ins.good === false ? "!" : "-"} {ins.text}
              </div>
            ))}
          </div>
          <div style={sep} />
        </>
      )}

      {/* Indicator Learning */}
      <div style={sectionLabel}>Indicator Learning</div>
      <div style={grp}>
        {indRows.map((r, i) => {
          const accColor = r.acc === null ? "#86868b" : r.acc >= 50 ? "#30d158" : "#ff453a";
          const wColor = r.diff > 0.1 ? "#30d158" : r.diff < -0.1 ? "#ff453a" : "#86868b";
          return (
            <div key={r.id} style={{ padding: "12px 14px", borderTop: i > 0 ? "1px solid #2c2c2e" : "none" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 15, fontWeight: 500 }}>{r.id}</span>
                <span style={{ fontSize: 15, fontWeight: 600, color: accColor }}>
                  {r.acc !== null ? r.acc + "%" : "—"}
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 12, color: "#86868b" }}>
                <span>{r.correct}W {r.wrong}L of {r.total} signals</span>
                <span style={{ color: wColor }}>
                  w={r.w.toFixed(1)} {r.diff > 0.1 ? "↑" : r.diff < -0.1 ? "↓" : ""} (def {r.def})
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div style={sep} />

      {/* Confidence vs Outcome */}
      <div style={sectionLabel}>Confidence vs Outcome</div>
      <div style={grp}>
        {confBuckets.map((b, i) => {
          const bwr = b.n > 0 ? Math.round((b.w / b.n) * 100) : null;
          const col = bwr === null ? "#86868b" : bwr >= 50 ? "#30d158" : "#ff453a";
          return (
            <div key={b.label} style={{ padding: "12px 14px", borderTop: i > 0 ? "1px solid #2c2c2e" : "none" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <span style={{ fontSize: 15, fontWeight: 500 }}>{b.label}</span>
                  <span style={{ fontSize: 12, color: "#48484a", marginLeft: 8 }}>{b.desc}</span>
                </div>
                <span style={{ fontSize: 15, fontWeight: 600, color: col }}>{bwr !== null ? bwr + "%" : "—"}</span>
              </div>
              {b.n > 0 && (
                <div style={{ fontSize: 12, color: "#86868b", marginTop: 4 }}>
                  {b.w}W/{b.n}T &middot; {pnl$(b.pnl)}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={sep} />

      {/* Entry Price Performance */}
      <div style={sectionLabel}>Entry Price Performance</div>
      <div style={grp}>
        {priceRanges.map((b, i) => {
          const bwr = b.n > 0 ? Math.round((b.w / b.n) * 100) : null;
          const col = bwr === null ? "#86868b" : bwr >= 50 ? "#30d158" : "#ff453a";
          return (
            <div key={b.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 14px", borderTop: i > 0 ? "1px solid #2c2c2e" : "none" }}>
              <div>
                <span style={{ fontSize: 15, fontWeight: 500 }}>{b.label}</span>
                <span style={{ fontSize: 12, color: "#86868b", marginLeft: 8 }}>{b.n} trades</span>
              </div>
              <span style={{ fontSize: 15, fontWeight: 600, color: col }}>{bwr !== null ? bwr + "%" : "—"}</span>
            </div>
          );
        })}
      </div>

      <div style={sep} />

      {/* Exit Strategy */}
      {exitList.length > 0 && (
        <>
          <div style={sectionLabel}>Exit Strategy</div>
          <div style={grp}>
            {exitList.map(([reason, d], i) => (
              <div key={reason} style={{ padding: "12px 14px", borderTop: i > 0 ? "1px solid #2c2c2e" : "none" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 15, fontWeight: 500 }}>{reason}</span>
                  <span style={{ fontSize: 15, fontWeight: 600, color: d.pnl >= 0 ? "#30d158" : "#ff453a" }}>{pnl$(d.pnl)}</span>
                </div>
                <div style={{ fontSize: 12, color: "#86868b", marginTop: 4 }}>
                  {d.n} trades &middot; {d.wins}W {d.n - d.wins}L
                </div>
              </div>
            ))}
          </div>
          <div style={sep} />
        </>
      )}

      {/* Hourly Performance */}
      {Object.keys(hourly).length > 0 && (
        <>
          <div style={sectionLabel}>Hourly Performance (UTC)</div>
          <div style={{ ...grp, padding: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: 3 }}>
              {Array.from({ length: 24 }, (_, h) => {
                const hd = hourly[h];
                let bg = "#2c2c2e", text = "—";
                if (hd?.total > 0) {
                  const w = hd.wins / hd.total;
                  text = Math.round(w * 100) + "%";
                  bg = w >= 0.6 ? "#30d158" : w >= 0.4 ? "#ff9f0a" : "#ff453a";
                }
                return (
                  <div key={h} style={{ background: bg + "33", borderRadius: 4, padding: "4px 0", textAlign: "center", fontSize: 9, color: "#fff" }}>
                    <div style={{ fontWeight: 600, opacity: 0.6 }}>{h}</div>
                    <div>{text}</div>
                  </div>
                );
              })}
            </div>
          </div>
          <div style={sep} />
        </>
      )}

      {/* Bot Status */}
      <div style={sectionLabel}>Bot Status</div>
      <div style={grp}>
        <Row l="Mode" v={(learned.mode || "normal").toUpperCase()} color={learned.mode === "recovery" ? "#ff453a" : learned.mode === "aggressive" ? "#30d158" : "#fff"} />
        <Row l="Score Threshold" v={learned.minScoreThreshold ?? 2} border />
        <Row l="Loss Streak" v={learned.lossStreak || 0} color={(learned.lossStreak || 0) >= 3 ? "#ff453a" : "#fff"} border />
        <Row l="Learned Win Rate" v={(learned.winRate ?? 0) + "%"} color={(learned.winRate ?? 0) >= 50 ? "#30d158" : "#ff453a"} border />
        <Row l="Total Learned Trades" v={learned.totalTrades || 0} border />
        {learned.priceAdvice && <Row l="Price Advice" v={learned.priceAdvice} color="#ff9f0a" border />}
        <Row l="Last Updated" v={learned.lastUpdated ? new Date(learned.lastUpdated).toLocaleString() : "never"} border />
      </div>

      <div style={sep} />

      {/* Recent Trades */}
      {recent.length > 0 && (
        <>
          <div style={sectionLabel}>Recent Trades</div>
          <div style={grp}>
            {recent.map((t, i) => {
              const won = isWin(t);
              const ts = t.closedTs || t.settledTs || t.openedTs;
              const time = ts ? new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
              const sc = t.signal?.score != null ? Math.abs(t.signal.score).toFixed(1) : null;
              return (
                <div key={i} style={{ padding: "11px 14px", borderTop: i > 0 ? "1px solid #2c2c2e" : "none" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>
                      <span style={{ color: t.side === "yes" ? "#30d158" : "#ff453a" }}>{(t.side || "").toUpperCase()}</span>
                      {" "}{t.entryPriceCents}c &rarr; {t.exitPriceCents ?? "settled"}c
                      {" "}&times;{t.count}
                    </div>
                    <span style={{ fontSize: 15, fontWeight: 600, color: won ? "#30d158" : "#ff453a" }}>
                      {pnl$(t.pnlCents || 0)}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: "#86868b", marginTop: 3 }}>
                    {time}
                    {t.exitReason ? " · " + t.exitReason : ""}
                    {sc ? " · score " + sc : ""}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      <div style={{ textAlign: "center", padding: "20px 0", fontSize: 12, color: "#48484a" }}>
        Updates every 15s
      </div>
    </div>
  );
}

function Stat({ n, l, color }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 22, fontWeight: 600, color: color || "#fff" }}>{n}</div>
      <div style={{ fontSize: 12, color: "#86868b" }}>{l}</div>
    </div>
  );
}

function Row({ l, v, color, border }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 14px", borderTop: border ? "1px solid #2c2c2e" : "none" }}>
      <span style={{ fontSize: 15, color: "#86868b" }}>{l}</span>
      <span style={{ fontSize: 15, fontWeight: 500, color: color || "#fff" }}>{v}</span>
    </div>
  );
}
