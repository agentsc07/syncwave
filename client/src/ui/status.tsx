import { useState } from 'react';
import type { Session } from '../lib/net';
import type { Device, RoomState } from '../lib/types';
import { useTick } from './hooks';

export type StatusKey = 'disconnected' | 'connected' | 'loading' | 'ready' | 'playing' | 'unsynced' | 'calibrating';

export const SYNC_OK_MS = 10;
export const SYNC_BAD_MS = 25;

/** One status per device, in priority order. `loadPct` is only known for the local device. */
export function deviceStatus(d: Device, state: RoomState, loadPct?: number | null): { key: StatusKey; label: string } {
  if (!d.connected) return { key: 'disconnected', label: 'Disconnected' };
  const cal = state.calibration;
  if (cal?.status === 'running' && (cal.deviceId === d.id)) return { key: 'calibrating', label: 'Calibrating' };
  const pb = state.playback;
  if (pb.trackId && d.readyTrackId !== pb.trackId) {
    return { key: 'loading', label: loadPct != null && loadPct > 0 ? `Loading ${loadPct}%` : 'Loading' };
  }
  if (d.offsetMs != null && Math.abs(d.offsetMs) >= SYNC_BAD_MS) return { key: 'unsynced', label: 'Out of sync' };
  if (pb.trackId && (pb.status === 'playing' || pb.status === 'scheduled')) return { key: 'playing', label: 'Playing' };
  if (pb.trackId) return { key: 'ready', label: 'Ready' };
  return { key: 'connected', label: 'Connected' };
}

export function StatusChip({ status }: { status: { key: StatusKey; label: string } }) {
  return <span className={'schip s-' + status.key}><i aria-hidden="true" />{status.label}</span>;
}

/** The local device's own status strip + the actionable banners (locked audio, reconnecting, errors). */
export function SelfStatus({ session, state }: { session: Session; state: RoomState }) {
  useTick(500);
  const self = state.devices.find((d) => d.id === session.deviceId);
  const clock = session.clock;
  const unlocked = session.engine.unlocked;
  const off = self?.offsetMs ?? null;
  const pct = session.loadStatus === 'loading' ? session.engine.loadPct : null;
  const st = self ? deviceStatus(self, state, pct) : null;
  const wl = session.wakeLockActive;
  const wlSupported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;

  return (
    <div className="selfstat" aria-label="This device's status">
      <div className="selfrow">
        {st && <StatusChip status={st} />}
        <span className={'pill ' + (!clock.synced ? 'warn' : off != null && Math.abs(off) >= SYNC_BAD_MS ? 'bad' : 'ok')}>
          {off != null ? `Synced ${off >= 0 ? '+' : '-'}${Math.abs(off).toFixed(1)} ms` : 'Syncing...'}
        </span>
        <span className={'pill ' + (clock.synced ? 'ok' : 'warn')} title={clock.synced ? `Clock stability ${clock.stability.toFixed(1)} ms` : undefined}>
          {clock.synced ? 'Clock locked' : 'Locking clock'}
        </span>
        <span className={'pill ' + (unlocked ? 'ok' : 'bad')}>{unlocked ? 'Audio on' : 'Audio locked'}</span>
        <span className={'pill ' + (wl ? 'ok' : 'dim')} title={wlSupported ? 'Keeps the screen awake so the phone does not stop playing' : 'This browser cannot keep the screen awake'}>
          {wl ? 'Screen awake' : wlSupported ? 'Screen may sleep' : 'No wake lock'}
        </span>
      </div>
      <Banners session={session} state={state} />
    </div>
  );
}

function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
const IOS_KEY = 'syncwave.iosHintSeen';

function loadErrorCopy(msg: string): string {
  if (/decode/i.test(msg)) return 'This device could not decode that file. It may be an unsupported format. Upload an MP3, M4A/AAC, WAV or OGG instead.';
  if (/download failed \(404\)/.test(msg)) return 'That song is no longer on the server (uploads are temporary). Upload it again.';
  return 'This device could not load the song (' + msg + '). It will keep retrying; check your connection.';
}

function Banners({ session, state }: { session: Session; state: RoomState }) {
  const [iosGone, setIosGone] = useState(() => { try { return !!localStorage.getItem(IOS_KEY); } catch { return false; } });
  const status = session.status;
  const unlocked = session.engine.unlocked;
  const err = session.lastError;
  const out: JSX.Element[] = [];

  if (err === 'room not found') {
    out.push(<div key="gone" className="banner bad" role="alert"><b>This room has closed or expired.</b> Rooms end when the host leaves for a while or the server restarts. <a href="#/">Start or join another room</a>.</div>);
  } else if (err === 'kicked') {
    out.push(<div key="kick" className="banner bad" role="alert"><b>The host removed this device.</b> <a href="#/">Back home</a></div>);
  } else if (status === 'reconnecting' || status === 'connecting') {
    out.push(<div key="conn" className="banner warn" role="status"><span className="spin" aria-hidden="true" /><span><b>{status === 'connecting' ? 'Connecting...' : 'Connection lost. Reconnecting...'}</b> Retrying automatically. Audio keeps playing from the last schedule; check your Wi-Fi if this stays.</span></div>);
  }
  if (!unlocked && status !== 'closed') {
    out.push(
      <div key="lock" className="banner bad" role="alert">
        <span><b>Audio is locked.</b> Your browser blocks sound until you tap.</span>
        <button className="btn sm" onClick={() => void session.unlock()}>Tap to unlock audio</button>
      </div>);
  }
  if (session.loadStatus === 'error' && session.loadError) {
    out.push(<div key="load" className="banner bad" role="alert"><b>Song failed to load.</b> {loadErrorCopy(session.loadError)}</div>);
  }
  if (isIos() && !iosGone) {
    out.push(
      <div key="ios" className="banner info" role="note">
        <span><b>iPhone tip:</b> if you hear nothing, flip the silent switch (side of the phone) to ring and turn the volume up. Silent mode can mute web audio.</span>
        <button className="btn sm" onClick={() => { try { localStorage.setItem(IOS_KEY, '1'); } catch { /* ignore */ } setIosGone(true); }}>Got it</button>
      </div>);
  }
  void state;
  return out.length ? <div className="banners">{out}</div> : null;
}

/** "New version, refresh" toast fired by main.tsx when a new service worker takes over. */
export function UpdateToast({ show }: { show: boolean }) {
  const [hide, setHide] = useState(false);
  if (!show || hide) return null;
  return (
    <div className="toast" role="status">
      <span>A new version of SyncWave is ready.</span>
      <button className="btn sm primary" onClick={() => location.reload()}>Refresh</button>
      <button className="btn sm" onClick={() => setHide(true)} aria-label="Dismiss">Later</button>
    </div>
  );
}
