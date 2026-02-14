
export async function getBTCMarkets() {
  const res = await fetch(
    "https://trading-api.kalshi.com/trade-api/v2/markets?status=open&limit=200",
    { headers: authHeaders() }
  );
  const data = await res.json();

  return (data.markets || []).filter(m => {
    const t = (m.title || "").toLowerCase();
    return (
      (t.includes("bitcoin") || t.includes("btc")) &&
      (t.includes("up") || t.includes("down") || t.includes("above") || t.includes("below")) &&
      (t.includes("15") || t.includes(":"))
    );
  });
}

export async function placeKalshiOrder(ticker, side, count, price) {
  return fetch("https://trading-api.kalshi.com/trade-api/v2/orders", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      ticker,
      action: "buy",
      side,
      type: "limit",
      count,
      [side === "yes" ? "yes_price" : "no_price"]: price
    })
  });
}

function authHeaders() {
  return {
    Authorization: `Bearer ${process.env.KALSHI_PRIVATE_KEY}`,
    "Kalshi-API-Key": process.env.KALSHI_API_KEY_ID
  };
}
