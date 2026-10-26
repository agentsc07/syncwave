// Server clock: Date.now() anchored once, then advanced by process.hrtime for sub-ms resolution.
const baseWall = Date.now();
const baseHr = process.hrtime.bigint();
export function now() {
  return baseWall + Number(process.hrtime.bigint() - baseHr) / 1e6;
}
