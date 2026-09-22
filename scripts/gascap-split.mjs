/**
 * Pure helper: eth_call vs eth_estimateGas disagree on --rpc.gascap?
 * @param {{ callOk: boolean, estimateOk: boolean, gas: number|null|undefined, cap: number }} p
 * @returns {boolean}
 */
export function isGascapSplit({ callOk, estimateOk, gas, cap }) {
  return (
    callOk === false &&
    estimateOk === true &&
    typeof gas === "number" &&
    Number.isFinite(gas) &&
    gas > cap
  );
}
