// Orchestra mode: pure helpers (no I/O). The client mirrors these in client/src/lib/orchestra.ts
// (server/test/orchestra-client.test.js checks both implementations agree).
export const STEMS = ['vocals', 'drums', 'bass', 'other'];

/** Canonical, de-duplicated, valid subset of STEMS (or null for "full mix"). */
export function normalizeStems(v) {
  if (!Array.isArray(v)) return null;
  const set = STEMS.filter((s) => v.includes(s));
  return set.length ? set : null;
}

/**
 * Auto-assignment by position. `devices` = [{id, x, order}] (the participating devices only).
 * Leftmost (smallest x, ties by join order) gets vocals, then drums, bass, other.
 *  - 0 devices: empty; 1 device: full mix (null)
 *  - 2 devices: vocals+other | drums+bass
 *  - 3 devices: stem j -> device j % 3 (so "other" is paired with vocals on the leftmost)
 *  - 4+ devices: device i gets STEMS[i % 4] (extra devices share stems round-robin)
 * Returns Map id -> string[] | null.
 */
export function autoAssign(devices) {
  const sorted = [...devices].sort((a, b) => a.x - b.x || a.order - b.order);
  const out = new Map();
  const n = sorted.length;
  if (n === 0) return out;
  if (n === 1) { out.set(sorted[0].id, null); return out; }
  if (n === 2) {
    out.set(sorted[0].id, ['vocals', 'other']);
    out.set(sorted[1].id, ['drums', 'bass']);
    return out;
  }
  if (n === 3) {
    const sets = [[], [], []];
    STEMS.forEach((s, j) => sets[j % 3].push(s));
    sorted.forEach((d, i) => out.set(d.id, STEMS.filter((s) => sets[i].includes(s))));
    return out;
  }
  sorted.forEach((d, i) => out.set(d.id, [STEMS[i % 4]]));
  return out;
}
