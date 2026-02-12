
export const STATES = {
  FLAT: "FLAT",
  ENTERING: "ENTERING",
  OPEN: "OPEN",
  EXITING: "EXITING",
  COOLDOWN: "COOLDOWN",
};

export function canEnter(state) {
  return state === STATES.FLAT;
}

export function canExit(state) {
  return state === STATES.OPEN;
}
