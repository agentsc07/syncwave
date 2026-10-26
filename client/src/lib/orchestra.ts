// Orchestra mode helpers. DOM-free and dependency-free so they can be tested in Node
// (server/test/orchestra-client.test.js). autoAssign mirrors server/src/orchestra.js (the server is
// authoritative; the test checks both give identical answers).

export const STEMS = ['vocals', 'drums', 'bass', 'other'] as const;
export type StemName = (typeof STEMS)[number];
export type SourceName = StemName | 'mix';

export interface StemsInfo { status: 'idle' | 'separating' | 'ready' | 'error'; progress: number; error?: string; names: string[] }
export interface OrchestraState {
  enabled: boolean;
  mode: 'auto' | 'manual';
  hostPlaysAll?: boolean;
  stemVolumes: Record<StemName, number>;
}

export function normalizeStems(v: unknown): StemName[] | null {
  if (!Array.isArray(v)) return null;
  const set = STEMS.filter((s) => v.includes(s));
  return set.length ? set : null;
}

export function autoAssign(devices: { id: string; x: number; order: number }[]): Map<string, StemName[] | null> {
  const sorted = [...devices].sort((a, b) => a.x - b.x || a.order - b.order);
  const out = new Map<string, StemName[] | null>();
  const n = sorted.length;
  if (n === 0) return out;
  if (n === 1) { out.set(sorted[0].id, null); return out; }
  if (n === 2) {
    out.set(sorted[0].id, ['vocals', 'other']);
    out.set(sorted[1].id, ['drums', 'bass']);
    return out;
  }
  if (n === 3) {
    const sets: StemName[][] = [[], [], []];
    STEMS.forEach((s, j) => sets[j % 3].push(s));
    sorted.forEach((d, i) => out.set(d.id, STEMS.filter((s) => sets[i].includes(s))));
    return out;
  }
  sorted.forEach((d, i) => out.set(d.id, [STEMS[i % 4]]));
  return out;
}

export interface TrackLike { stemsOnly?: boolean; stems?: StemsInfo }

/** Is stem playback in effect for this track (orchestra on and stems separated)? */
export function orchestraActive(track: TrackLike | undefined | null, o: Pick<OrchestraState, 'enabled'> | undefined | null): boolean {
  return !!o?.enabled && track?.stems?.status === 'ready';
}

/**
 * The sources this device should play: ['mix'] (the full-mix file), or its stems.
 * Stems-only (demo) tracks have no mix file, so "full mix" means all four stems.
 */
export function wantedSources(
  track: TrackLike | undefined | null,
  o: Pick<OrchestraState, 'enabled'> | undefined | null,
  assigned: readonly string[] | null | undefined,
): SourceName[] {
  const mine = orchestraActive(track, o) ? normalizeStems(assigned) : null;
  if (mine) return mine;
  return track?.stemsOnly ? [...STEMS] : ['mix'];
}

export interface SetDiff<T> { add: T[]; remove: T[]; keep: T[] }
/** Which sources to start, stop and leave running when going from `prev` to `next`. */
export function diffSources<T>(prev: readonly T[], next: readonly T[]): SetDiff<T> {
  return {
    add: next.filter((x) => !prev.includes(x)),
    remove: prev.filter((x) => !next.includes(x)),
    keep: next.filter((x) => prev.includes(x)),
  };
}

/** Stems that must be downloaded+decoded for this device (the full mix is handled separately). */
export function stemsToLoad(track: TrackLike | undefined | null, o: Pick<OrchestraState, 'enabled'> | undefined | null, assigned: readonly string[] | null | undefined): StemName[] {
  return wantedSources(track, o, assigned).filter((s): s is StemName => s !== 'mix');
}

/** Chip label such as "Vocals + Other", or "Full mix". */
export function stemLabel(stems: readonly string[] | null | undefined): string {
  const s = normalizeStems(stems);
  if (!s) return 'Full mix';
  return s.map((x) => x[0].toUpperCase() + x.slice(1)).join(' + ');
}

/** Toggle one stem in a device's set; removing the last stem returns null (= full mix). */
export function toggleStem(current: readonly string[] | null | undefined, stem: StemName): StemName[] | null {
  const cur = normalizeStems(current) ?? [];
  const next = cur.includes(stem) ? cur.filter((s) => s !== stem) : [...cur, stem];
  return normalizeStems(next);
}
