import { useEffect, useState } from 'react';
import type { Session } from '../lib/net';
import type { Device, RoomState } from '../lib/types';
import { STEMS, orchestraActive, stemLabel, toggleStem, type StemName } from '../lib/orchestra';

interface Demo { slug: string; title: string; durationSec: number | null }

const SHORT: Record<StemName, string> = { vocals: 'Vocals', drums: 'Drums', bass: 'Bass', other: 'Other' };

export default function OrchestraPanel({ session, state, isHost }: { session: Session; state: RoomState; isHost: boolean }) {
  const o = state.orchestra;
  const sepOn = state.features?.separation ?? false;
  const track = state.tracks.find((t) => t.id === state.playback.trackId);
  const stems = track?.stems;
  const active = orchestraActive(track, o);
  const [demos, setDemos] = useState<Demo[] | null>(null);
  const [slug, setSlug] = useState('');
  const connected = state.devices.filter((d) => d.connected);
  const self = state.devices.find((d) => d.id === session.deviceId);

  useEffect(() => {
    if (!isHost) return;
    fetch('/api/demo').then((r) => r.json()).then((j) => { setDemos(j.demos ?? []); setSlug((s) => s || j.demos?.[0]?.slug || ''); }).catch(() => setDemos([]));
  }, [isHost]);

  if (!o) return <p className="hint">This server does not support orchestra mode.</p>;

  if (!isHost) {
    return (
      <div className="orch">
        <p className="hint">
          {!o.enabled ? 'Orchestra mode is off: this device plays the full mix.'
            : !active ? 'Orchestra mode is on, but this song has no stems yet, so this device plays the full mix.'
            : <>Orchestra mode: this device plays <b>{stemLabel(self?.stems)}</b>.</>}
        </p>
        <ul className="list">
          {connected.map((d) => <li key={d.id} className="row"><span className="grow">{d.name}{d.id === session.deviceId ? ' (you)' : ''}</span><span className="stemtag">{stemLabel(d.stems)}</span></li>)}
        </ul>
      </div>
    );
  }

  const separating = stems?.status === 'separating';
  const pct = Math.round((stems?.progress ?? 0) * 100);
  return (
    <div className="orch">
      <h3>Stems</h3>
      {!sepOn && <p className="hint warnc">Stem separation is not configured on this server (set SEPARATOR_URL and SEPARATOR_TOKEN, see startup.md). The demo library below still works.</p>}
      {track && !track.stemsOnly && (
        <div className="orchbox">
          <b className="grow">{track.name}</b>
          {stems?.status === 'ready' && <span className="okc">Stems ready</span>}
          {(!stems || stems.status === 'idle') && (
            <button className="btn" disabled={!sepOn} onClick={() => session.separate(track.id)}>Separate this song into stems</button>
          )}
          {stems?.status === 'error' && <button className="btn" disabled={!sepOn} onClick={() => session.separate(track.id)}>Try again</button>}
        </div>
      )}
      {track?.stemsOnly && <p className="hint okc">Demo song: stems are ready, no separation needed.</p>}
      {separating && (
        <div className="calprog">
          <progress value={pct} max={100} />
          <small className="hint">Separating... {pct}%. This can take a few minutes on a free CPU; you can keep using the room.</small>
        </div>
      )}
      {stems?.status === 'error' && <p className="err">Separation failed: {stems.error ?? 'unknown error'}</p>}
      {!track && <p className="hint">Upload or pick a song first.</p>}

      <h3>Demo library</h3>
      {demos && demos.length === 0 && <p className="hint">No demo songs on this server. See server/demo/README.md to make some (no separation needed at play time).</p>}
      {demos && demos.length > 0 && (
        <div className="orchbox">
          <select className="grow" value={slug} onChange={(e) => setSlug(e.target.value)} aria-label="Demo song">
            {demos.map((d) => <option key={d.slug} value={d.slug}>{d.title}</option>)}
          </select>
          <button className="btn" disabled={!slug} onClick={() => session.addDemo(slug)}>Add to room</button>
        </div>
      )}

      <h3>Orchestra</h3>
      <div className="orchbox">
        <button className={'btn' + (o.enabled ? ' on' : '')} aria-pressed={o.enabled} onClick={() => session.orchestraSet({ enabled: !o.enabled })}>
          Orchestra {o.enabled ? 'on' : 'off'}
        </button>
        <span className="hint grow">
          {!o.enabled ? 'Everyone plays the full song.' : active ? 'Each device plays its own stems.' : 'On, but waiting for stems: everyone plays the full mix until they are ready.'}
        </span>
      </div>

      <div className="stemvols">
        {STEMS.map((s) => (
          <label key={s} className="vol"><span>{SHORT[s]}</span>
            <input type="range" min={0} max={1} step={0.01} value={o.stemVolumes[s]}
              onChange={(e) => session.orchestraSet({ stemVolumes: { [s]: +e.target.value } })} /></label>
        ))}
      </div>

      <div className="orchbox wrap">
        <button className={'btn' + (o.mode === 'auto' ? ' on' : '')} onClick={() => session.orchestraSet({ mode: 'auto' })}>Auto-assign</button>
        <button className="btn" onClick={() => session.orchestraSet({ everyone: true })}>Everyone plays everything</button>
        <label className="check"><input type="checkbox" checked={!!o.hostPlaysAll} onChange={(e) => session.orchestraSet({ hostPlaysAll: e.target.checked })} /> Host plays full mix</label>
      </div>
      <p className="hint">{o.mode === 'auto' ? 'Auto: stems follow the Space map, left to right (vocals, drums, bass, other).' : 'Manual: tap stems to assign them. Auto-assign goes back to the map.'}</p>

      <ul className="list devices">
        {connected.map((d) => <DeviceStems key={d.id} d={d} session={session} mine={d.id === session.deviceId} />)}
      </ul>
    </div>
  );
}

function DeviceStems({ d, session, mine }: { d: Device; session: Session; mine: boolean }) {
  const set = d.stems ?? [];
  return (
    <li className="dev">
      <div className="devhead"><b>{d.name}{mine ? ' (you)' : ''}</b><span className="stemtag">{stemLabel(d.stems)}</span></div>
      <div className="stemchips">
        {STEMS.map((s) => (
          <button key={s} className={'btn sm' + (set.includes(s) ? ' on' : '')} aria-pressed={set.includes(s)}
            onClick={() => session.assignStems(d.id, toggleStem(d.stems, s))}>{SHORT[s]}</button>
        ))}
      </div>
    </li>
  );
}
