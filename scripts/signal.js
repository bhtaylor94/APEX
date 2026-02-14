
export async function getBTCSignal() {
  const r = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot");
  const price = parseFloat((await r.json()).data.amount);

  // simple momentum for now (you can port full engine later)
  const direction = Math.random() > 0.5 ? "up" : "down";
  const confidence = 0.20; // placeholder deterministic confidence

  return { direction, confidence, price };
}
