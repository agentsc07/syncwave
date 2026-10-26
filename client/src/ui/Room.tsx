import { useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '../lib/net';
import type { Device, RoomState, Track } from '../lib/types';
import { getHostToken, getName, makeSession, setName } from './connect';
import { fmtTime, useRoomState, useTick } from './hooks';
import QrJoin, { InviteButtons } from './QrJoin';
import { SelfStatus, StatusChip, deviceStatus } from './status';
import Radar from './Radar';
import SpatialMap from './SpatialMap';
import LightShow from './LightShow';
import CalibratePanel, { ScoreBadge } from './Calibrate';
import OrchestraPanel from './Orchestra';
import DemoLibrary from './DemoLibrary';

type Tab = 'play' | 'orch' | 'radar' | 'space' | 'people';

export default function RoomPage({ roomId, radarOnly }: { roomId: string; radarOnly: boolean }) {
  const [session, setSession] = useState<Session | null>(null);
  const [name, setNm] = useState(getName());
  const [exists, setExists] = useState<boolean | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    setOffline(false);
    fetch(`/api/rooms/${roomId}`).then((r) => r.json()).then((j) => setExists(!!j.exists)).catch(() => { setExists(true); setOffline(true); });
  }, [roomId]);

  useEffect(() => () => { try { session?.leave(); } catch { /* ignore */ } }, [session]);

  if (!session) {
    const host = !!getHostToken(roomId);
    const start = () => {
      const n = name.trim() || (host ? 'Host' : radarOnly ? 'Radar' : 'Guest ' + Math.floor(Math.random() * 90 + 10));
      setName(n);
      const s = makeSession(roomId, n);
      void s.unlock(); // user gesture
      s.connect();
      setSession(s);
    };
    return (
      <main className="home gate">
        <div className="glow" />
        <div className="brand"><span className="wave"><i /><i /><i /><i /><i /></span>SyncWave</div>
        <h1 className="gateh">{host ? 'Your room is ready' : "You're joining"}</h1>
        <div className="roomtag static" aria-label={`Room code ${roomId}`}>ROOM <b>{roomId}</b></div>
        {exists === false ? (
          <>
            <p className="err" role="alert"><b>This room doesn't exist or has expired.</b><br />Rooms close when the host leaves for a while or the server restarts. Ask the host for a fresh code or QR.</p>
            <a className="btn primary big" href="#/">Back home</a>
          </>
        ) : (
          <>
            {offline && <p className="err" role="alert">Can't reach the server right now. You can still try; it will keep retrying.</p>}
            <label className="field">
              <span>Your name</span>
              <input value={name} onChange={(e) => setNm(e.target.value)} placeholder={host ? 'Host' : 'Your name'} maxLength={24} autoComplete="nickname" enterKeyHint="go"
                onKeyDown={(e) => { if (e.key === 'Enter') start(); }} />
            </label>
            <button className="btn primary big pulse" onClick={start}>{host ? 'Tap to start' : 'Tap to join'}</button>
            <p className="hint">One tap unlocks audio on this device (browsers require it). On iPhone, also switch the silent switch to ring.</p>
            <a className="linkbtn center" href="#/">Not the right room? Go back</a>
          </>
        )}
      </main>
    );
  }
  return <Live session={session} roomId={roomId} radarOnly={radarOnly} />;
}

function Live({ session, roomId, radarOnly }: { session: Session; roomId: string; radarOnly: boolean }) {
  const state = useRoomState(session);
  const [tab, setTab] = useState<Tab>(radarOnly ? 'radar' : 'play');
  const [showQr, setShowQr] = useState(false);
  const selfId = session.deviceId;
  const self = state?.devices.find((d) => d.id === selfId);
  const isHost = state ? state.hostId === selfId : session.isHost;

  if (!state) {
    return (
      <main className="home gate"><div className="glow" aria-hidden="true" />
        <div className="brand"><span className="wave" aria-hidden="true"><i /><i /><i /><i /><i /></span>SyncWave</div>
        <SelfStatus session={session} state={{ roomId, serverTime: 0, devices: [], tracks: [], queue: [], playback: { status: 'stopped', trackId: null, startServerTime: null, pausedPositionMs: 0 }, volume: 1, lights: false, live: null, hostId: '' }} />
        <p className="hint" role="status">{session.status === 'reconnecting' ? 'Reconnecting to the room...' : 'Joining the room...'}</p>
        <a className="linkbtn center" href="#/" onClick={() => session.leave()}>Cancel</a>
      </main>
    );
  }

  if (radarOnly) {
    return (
      <main className="full">
        <header className="top"><b>Sync radar</b><span className="roomtag">ROOM <b>{roomId}</b></span><a className="linkbtn" href={`#/r/${roomId}`}>Open room</a></header>
        <Radar devices={state.devices} selfId={selfId} big />
        <LightShow session={session} active={state.lights} />
      </main>
    );
  }

  return (
    <main className="room">
      <header className="top">
        <div className="brand sm"><span className="wave"><i /><i /><i /><i /><i /></span>SyncWave</div>
        <button className="roomtag" onClick={() => setShowQr(true)} aria-label={`Room ${roomId}. Show QR code and invite link`}>ROOM <b>{roomId}</b> <span className="qrico">QR</span></button>
        {state.live && <span className="livebadge">{state.live.kind === 'share' ? 'LIVE' : 'ANNOUNCING'}</span>}
        <span className="role">{isHost ? 'HOST' : 'GUEST'}</span>
      </header>

      <SelfStatus session={session} state={state} />

      <nav className="tabs" role="tablist" aria-label="Room sections">
        {(['play', 'orch', 'radar', 'space', 'people'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {{ play: 'Play', orch: 'Orchestra · soon', radar: 'Radar', space: 'Space', people: `Devices ${state.devices.filter((d) => d.connected).length}` }[t]}
          </button>
        ))}
      </nav>

      <section className="pane">
        {tab === 'play' && <PlayPane session={session} state={state} isHost={isHost} roomId={roomId} />}
        {tab === 'orch' && <OrchestraPanel session={session} state={state} isHost={isHost} />}
        {tab === 'radar' && (
          <>
            <Radar devices={state.devices} selfId={selfId} />
            <a className="linkbtn center" href={`#/r/${roomId}/radar`} target="_blank" rel="noreferrer">Open on projector</a>
          </>
        )}
        {tab === 'space' && (
          <>
            <p className="hint">{isHost ? 'Drag devices onto the map. Left/right of the listener play that channel; the middle is centre; the bottom is rear.' : 'The host places devices around the room.'}</p>
            <SpatialMap devices={state.devices} isHost={isHost}
              onMove={(id, channel, x, y) => session.send({ type: 'setChannel', deviceId: id, channel, x, y })} />
          </>
        )}
        {tab === 'people' && <People session={session} state={state} isHost={isHost} self={self} />}
      </section>

      <footer className="dock">
        {isHost ? (
          <>
            <label className="vol"><span>Room volume</span>
              <input type="range" min={0} max={1} step={0.01} value={state.volume}
                onChange={(e) => session.send({ type: 'volume', value: +e.target.value })} /></label>
            <button className={'btn' + (state.lights ? ' primary' : '')} onClick={() => session.send({ type: 'lights', on: !state.lights })}>Lights</button>
          </>
        ) : (
          <>
            <LocalVolume session={session} />
            <button className="btn" onClick={() => { session.leave(); location.hash = '#/'; }}>Leave</button>
          </>
        )}
      </footer>

      {showQr && (
        <div className="modal" onKeyDown={(e) => { if (e.key === 'Escape') setShowQr(false); }} onClick={() => setShowQr(false)}>
          <div className="sheet" role="dialog" aria-modal="true" aria-label="Invite to room" onClick={(e) => e.stopPropagation()}>
            <QrJoin roomId={roomId} />
            <button className="btn" autoFocus onClick={() => setShowQr(false)}>Close</button>
          </div>
        </div>
      )}
      <LightShow session={session} active={state.lights} />
    </main>
  );
}

function LocalVolume({ session }: { session: Session }) {
  const [v, setV] = useState(1);
  return (
    <label className="vol"><span>My volume</span>
      <input type="range" min={0} max={1} step={0.01} value={v}
        onChange={(e) => { setV(+e.target.value); session.engine.setLocalVolume(+e.target.value); }} /></label>
  );
}

function PlayPane({ session, state, isHost, roomId }: { session: Session; state: RoomState; isHost: boolean; roomId: string }) {
  useTick(120);
  const pb = state.playback;
  const track = state.tracks.find((t) => t.id === pb.trackId);
  const connected = state.devices.filter((d) => d.connected);
  const ready = connected.filter((d) => pb.trackId && d.readyTrackId === pb.trackId).length;
  const allReady = !!pb.trackId && ready === connected.length;
  const playing = pb.status === 'playing' || pb.status === 'scheduled';
  const pos = pb.status === 'paused' ? pb.pausedPositionMs : playing ? Math.max(0, session.engine.getPositionMs()) : 0;
  const dur = track?.durationMs ?? (pb.trackId ? Math.round(session.engine.decodedDurationMs(pb.trackId)) : 0); // uploads carry no server duration; use the decoded length
  const [scrub, setScrub] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  async function upload(f: File) {
    setUploading(true); setErr('');
    try {
      const token = getHostToken(roomId) ?? session.deviceId;
      const r = await fetch(`/api/rooms/${roomId}/tracks`, {
        method: 'POST', body: f,
        headers: { 'x-filename': encodeURIComponent(f.name), 'x-token': token, 'content-type': f.type || 'application/octet-stream' },
      });
      if (!r.ok) {
        const why = await r.text().catch(() => '');
        if (r.status === 413 || /too large/i.test(why)) throw new Error('That file is too large. The limit is 100 MB; try a smaller or compressed (MP3/M4A) version.');
        if (r.status === 404) throw new Error('This room no longer exists, so the song could not be added.');
        if (r.status === 415 || /type|format/i.test(why)) throw new Error('That file type is not supported. Use an MP3, M4A/AAC, WAV or OGG file.');
        throw new Error(`The server rejected the upload (${r.status}). Try again.`);
      }
      const { trackId } = await r.json();
      if (isHost && !pb.trackId) session.send({ type: 'setTrack', trackId });
      else session.send({ type: 'queueAdd', trackId });
    } catch (e) {
      const m = (e as Error).message;
      setErr(/^(That|This|The) /.test(m) ? m : 'Upload failed. Check your connection and try again.');
    }
    setUploading(false);
  }

  const queued = state.queue.map((id) => state.tracks.find((t) => t.id === id)).filter((t): t is Track => !!t);
  const others = state.tracks.filter((t) => t.id !== pb.trackId && !state.queue.includes(t.id));

  const liveShare = state.live?.kind === 'share';
  return (
    <>
      {isHost && <InviteCard roomId={roomId} alone={connected.length < 2} />}
      {isHost && <LivePanel session={session} state={state} />}
      {!isHost && state.live && (
        <p className="hint">{state.live.kind === 'share' ? 'Live audio from the host is playing.' : 'The host is making an announcement. Music is lowered.'}</p>
      )}
      <div className="now">
        <div className={'disc' + (pb.status === 'playing' ? ' spin' : '')} />
        <div className="meta">
          <small>{pb.status === 'scheduled' ? 'STARTING' : pb.status.toUpperCase()}</small>
          <h2>{track?.name ?? 'Nothing loaded'}</h2>
          {pb.trackId && <small className={allReady ? 'okc' : 'warnc'}>{ready}/{connected.length} devices ready</small>}
        </div>
      </div>

      <div className="seek">
        <span>{fmtTime(scrub ?? pos)}</span>
        <input type="range" min={0} max={Math.max(dur, 1)} step={100} value={Math.min(scrub ?? pos, Math.max(dur, 1))} disabled={!isHost || !dur}
          onChange={(e) => setScrub(+e.target.value)}
          onPointerUp={() => { if (scrub != null) { session.send({ type: 'seek', positionMs: scrub }); setScrub(null); } }}
          onKeyUp={() => { if (scrub != null) { session.send({ type: 'seek', positionMs: scrub }); setScrub(null); } }} />
        <span>{dur ? fmtTime(dur) : '--:--'}</span>
      </div>

      {isHost && (
        <div className="transport">
          <button className="btn round" onClick={() => session.send({ type: 'seek', positionMs: 0 })} disabled={!playing && pb.status !== 'paused'} aria-label="Restart">|&lt;</button>
          {playing
            ? <button className="btn primary round xl" onClick={() => session.send({ type: 'pause' })} aria-label="Pause">II</button>
            : <button className="btn primary round xl" onClick={() => session.send({ type: 'play' })} disabled={!allReady || liveShare} aria-label="Play">&#9654;</button>}
          <button className="btn round" onClick={() => session.send({ type: 'next' })} aria-label="Next">&gt;|</button>
        </div>
      )}

      <div className="uploadrow">
        <input ref={fileRef} type="file" accept="audio/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
        <button className="btn" onClick={() => fileRef.current?.click()} disabled={uploading}>{uploading ? 'Uploading... (large files take a moment)' : isHost ? 'Upload a song' : 'Add a song to the queue'}</button>
      </div>
      {err && <p className="err" role="alert">{err} <button className="linkbtn" onClick={() => setErr('')}>Dismiss</button></p>}
      <p className="hint center temp">Uploads are temporary: files are removed when the room closes or the server restarts. Keep your originals.</p>
      {isHost && <DemoLibrary session={session} />}

      <h3>Up next</h3>
      {queued.length === 0 && <p className="hint">Queue is empty. Anyone can add a song and vote.</p>}
      <ul className="list">
        {queued.map((t, i) => <TrackRow key={t.id} t={t} idx={i + 1} session={session} isHost={isHost} />)}
      </ul>
      {others.length > 0 && (
        <>
          <h3>Library</h3>
          <ul className="list">{others.map((t) => <TrackRow key={t.id} t={t} session={session} isHost={isHost} />)}</ul>
        </>
      )}
    </>
  );
}

function InviteCard({ roomId, alone }: { roomId: string; alone: boolean }) {
  const [open, setOpen] = useState(alone);
  useEffect(() => { if (alone) setOpen(true); }, [alone]);
  return (
    <div className="invite">
      <div className="invitehead">
        <div><small>ROOM CODE</small><div className="bigcode" aria-label={roomId.split('').join(' ')}>{roomId}</div></div>
        <button className="btn sm" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide QR' : 'Show QR'}</button>
      </div>
      {open && <QrJoin roomId={roomId} compact />}
      {!open && <InviteButtons roomId={roomId} />}
      {alone && <p className="hint center">Waiting for others. Have them scan the QR code or enter this code at the home page.</p>}
    </div>
  );
}

function LiveMeter({ session }: { session: Session }) {
  useTick(80);
  const lvl = Math.min(1, Math.sqrt(session.liveLevel)); // sqrt: quiet speech still moves the bar
  return <div className="livemeter" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(lvl * 100)}><i style={{ width: `${lvl * 100}%` }} /></div>;
}

function LivePanel({ session, state }: { session: Session; state: RoomState }) {
  useTick(500); // re-render on session.liveError / liveStarting changes
  const live = state.live;
  const mine = live?.sourceId === session.deviceId;
  const busy = session.liveStarting;
  const [buf, setBuf] = useState<number | null>(null);
  const isAnn = live?.kind === 'announce';
  const range = isAnn ? { min: 300, max: 2000 } : { min: 800, max: 3000 };
  const bufMs = live ? live.bufferMs : (buf ?? 1500);
  // press-and-hold = push to talk (release after 0.6 s stops it); a quick tap toggles on/off
  const press = useRef<{ t: number; started: boolean; released: boolean } | null>(null);
  const onAnnDown = () => {
    press.current = null;
    if (live || busy) return;
    const p = { t: Date.now(), started: true, released: false };
    press.current = p;
    void session.startLive('announce').then((ok) => { if (ok && p.released && Date.now() - p.t > 600) session.stopLive(); });
  };
  const onAnnUp = () => {
    const p = press.current;
    if (!p) return;
    p.released = true;
    if (Date.now() - p.t > 600 && session.liveCapturing) session.stopLive();
  };
  const onAnnClick = () => {
    if (press.current?.started) { press.current = null; return; } // already handled on pointer down/up
    if (live && mine) session.stopLive();
    else if (!live && !busy) void session.startLive('announce');
  };
  // announce health: silent mic / nobody receiving
  const [since, setSince] = useState<number | null>(null);
  useEffect(() => { setSince(isAnn && mine ? Date.now() : null); }, [isAnn, mine]);
  const age = since ? Date.now() - since : 0;
  const others = state.devices.filter((d) => d.id !== session.deviceId);
  const rx = others.filter((d) => d.liveRx);
  const hearing = rx.filter((d) => d.liveRx!.played > 0 && d.liveRx!.late / (d.liveRx!.played + d.liveRx!.late) < 0.5).length;
  const tooLate = rx.length - hearing;
  return (
    <div className="livepanel">
      <div className="liverow">
        {live?.kind === 'share' && mine
          ? <button className="btn danger" onClick={() => session.stopLive()}>Stop sharing</button>
          : <button className="btn" disabled={busy || !!live} onClick={() => void session.startLive('share', bufMs)}>Share tab/system audio</button>}
        <button className={'btn' + (isAnn && mine ? ' primary' : '')} disabled={!(isAnn && mine) && !!live}
          onPointerDown={onAnnDown} onPointerUp={onAnnUp} onPointerCancel={onAnnUp} onClick={onAnnClick}
          onContextMenu={(e) => e.preventDefault()} style={{ touchAction: 'manipulation' }}>
          {isAnn && mine ? 'Stop announcement' : busy ? 'Opening microphone...' : 'Announce (mic)'}
        </button>
      </div>
      {live?.kind === 'share' && mine && (
        <p className="hint">Sharing live. This device plays the stream {(live.bufferMs / 1000).toFixed(1)} s late, like the others, and the shared tab is muted locally where the browser allows it (otherwise mute that tab to avoid echo).</p>
      )}
      {isAnn && mine && (
        <>
          <LiveMeter session={session} />
          <p className="hint">
            Announcing to {others.length} device{others.length === 1 ? '' : 's'}. Music is ducked everywhere. This device does not play your voice back (feedback).
            {' '}Tip: press and hold the button to talk, release to stop.
          </p>
          {age > 3000 && session.liveLevel < 0.01 && <p className="err">The microphone is not picking up any sound. Check the browser/system input device and that it is not muted.</p>}
          {age > 3000 && session.liveFramesSent === 0 && <p className="err">No audio has been sent yet. The connection may be down.</p>}
          {age > 4000 && others.length > 0 && rx.length === 0 && <p className="err">No other device has confirmed receiving the audio yet.</p>}
          {rx.length > 0 && <p className="hint">{hearing} of {others.length} device{others.length === 1 ? '' : 's'} hearing it{tooLate > 0 ? `; ${tooLate} too slow (raising the delay automatically)` : ''}.</p>}
        </>
      )}
      {live && !mine && <p className="hint">Another device is live.</p>}
      <label className="vol"><span>Live delay {(bufMs / 1000).toFixed(1)} s{isAnn ? ' (announce)' : ''}</span>
        <input type="range" min={range.min} max={range.max} step={100} value={Math.max(range.min, Math.min(range.max, bufMs))} disabled={!!live && !mine}
          onChange={(e) => { setBuf(+e.target.value); if (live) session.setLiveBuffer(+e.target.value); }} /></label>
      {session.liveError && <p className="err">{session.liveError}</p>}
    </div>
  );
}

function TrackRow({ t, idx, session, isHost }: { t: Track; idx?: number; session: Session; isHost: boolean }) {
  return (
    <li className="row">
      <span className="idx">{idx ?? '+'}</span>
      <span className="grow">{t.name}</span>
      <button className={'btn sm' + (t.voters?.includes(session.deviceId) ? ' on' : '')} onClick={() => session.send({ type: 'queueVote', trackId: t.id })}>&#9650; {t.votes}</button>
      {isHost && <button className="btn sm" onClick={() => session.send({ type: 'setTrack', trackId: t.id })}>Load</button>}
    </li>
  );
}

function People({ session, state, isHost, self }: { session: Session; state: RoomState; isHost: boolean; self?: Device }) {
  useTick(500);
  const sorted = useMemo(() => [...state.devices].sort((a, b) => Number(b.connected) - Number(a.connected)), [state.devices]);
  return (
    <>
    <CalibratePanel session={session} state={state} isHost={isHost} />
    <ul className="list devices">
      {sorted.map((d) => {
        const mine = d.id === self?.id;
        const canTrim = isHost || mine;
        const off = d.offsetMs;
        const status = deviceStatus(d, state, mine ? (session.loadStatus === 'loading' ? session.engine.loadPct : null) : null);
        const cls = !d.connected ? 'off' : off == null ? 'unk' : Math.abs(off) < 10 ? 'ok' : Math.abs(off) < 25 ? 'warn' : 'bad';
        return (
          <li key={d.id} className={'dev ' + cls}>
            <div className="devhead">
              <span className="led" />
              <b>{d.name}{mine ? ' (you)' : ''}</b>
              {d.isHost && <em>host</em>}
              <StatusChip status={status} />
              <span className="chan">{d.channel}</span>
              <span className="mono">{off != null ? `${off >= 0 ? '+' : ''}${off.toFixed(1)}ms` : '--'}</span>
              <ScoreBadge score={d.syncScore} />
              {isHost && !mine && <button className="btn sm danger" aria-label={`Kick ${d.name}`} onClick={() => session.send({ type: 'kick', deviceId: d.id })}>Kick</button>}
            </div>
            {canTrim && (
              <label className="trim"><span>Manual trim{mine ? '' : ' for ' + d.name}</span>
                <input type="range" min={-300} max={300} step={1} value={d.trimMs}
                  onChange={(e) => session.send(isHost ? { type: 'setTrim', deviceId: d.id, ms: +e.target.value } : { type: 'setTrimSelf', ms: +e.target.value })} />
                <span className="mono">{d.trimMs > 0 ? '+' : ''}{d.trimMs}ms</span></label>
            )}
          </li>
        );
      })}
    </ul>
    </>
  );
}
