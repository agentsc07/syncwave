import { useEffect, useState } from 'react';
import type { Session } from '../lib/net';
import type { RoomState } from '../lib/types';

export function useRoomState(session: Session | null): RoomState | null {
  const [st, setSt] = useState<RoomState | null>(session?.state ?? null);
  useEffect(() => {
    if (!session) return;
    setSt(session.state ?? null);
    return session.subscribe((s) => setSt(s ? { ...s } : null));
  }, [session]);
  return st;
}

/** Re-render every `ms` (for live position readouts). */
export function useTick(ms = 100): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  return n;
}

export function fmtTime(ms: number): string {
  if (!isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
