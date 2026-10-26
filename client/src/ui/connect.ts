import { Session } from '../lib/net';

const HOST_KEY = (roomId: string) => `syncwave.host.${roomId}`;

export function getHostToken(roomId: string): string | null {
  try { return localStorage.getItem(HOST_KEY(roomId)); } catch { return null; }
}
export function setHostToken(roomId: string, token: string) {
  try { localStorage.setItem(HOST_KEY(roomId), token); } catch { /* ignore */ }
}
export function getName(): string {
  try { return localStorage.getItem('syncwave.name') ?? ''; } catch { return ''; }
}
export function setName(n: string) {
  try { localStorage.setItem('syncwave.name', n); } catch { /* ignore */ }
}

/** Single construction point for the lib Session (adapt here if the lib signature changes). */
export function makeSession(roomId: string, name: string): Session {
  return new Session({ roomId, name, hostToken: getHostToken(roomId) ?? undefined });
}

export function roomLink(roomId: string): string {
  return `${location.origin}/#/r/${roomId}`;
}
