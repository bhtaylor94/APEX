export function calcExitTargets({ side, entryCents, takeProfitPct, stopLossPct }) {
  // entryCents is what you paid (taker fill cost per contract in cents)
  // Profit target: sell higher. Stop: sell lower.
  // Clamp between 1..99
  const tp = Math.min(99, Math.max(1, Math.round(entryCents * (1 + takeProfitPct))));
  const sl = Math.min(99, Math.max(1, Math.round(entryCents * (1 - stopLossPct))));
  return { tp, sl };
}

export function shouldForceExit({ minutesToClose, minMinutesToCloseToHold }) {
  return Number.isFinite(minutesToClose) && minutesToClose <= minMinutesToCloseToHold;
}
