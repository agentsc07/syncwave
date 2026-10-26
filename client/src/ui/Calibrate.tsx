import type { Session } from '../lib/net';
import type { RoomState } from '../lib/types';
import { useTick } from './hooks';

export const scoreClass = (s: number | null | undefined) => (s == null ? 'unk' : s >= 80 ? 'ok' : s >= 50 ? 'warn' : 'bad');

export function ScoreBadge({ score }: { score?: number | null }) {
  if (score == null) return null;
  return <span className={'score ' + scoreClass(score)} title="Sync score from the last auto-calibration (0-100)">{score}</span>;
}

const ERR: Record<string, string> = {
  'mic-denied': 'Microphone access was denied. Allow the microphone for this site in the browser settings, then try again.',
  'insecure-context': 'Calibration needs the microphone, which browsers only allow over HTTPS or on localhost. Open the app over https:// (see the README) and try again.',
  'mic-error': 'Could not start the microphone. Check that no other app is using it.',
  'mic-timeout': 'The microphone did not start in time. Try again.',
  'low-confidence': 'Could not hear the chirps clearly. Keep the room quiet, put this device near the speakers, turn the speaker volume up, and retry.',
  'result-timeout': 'The host device did not finish analysing in time. Try again.',
  'host-left': 'The host left during calibration.',
  cancelled: 'Calibration cancelled.',
};

export default function CalibratePanel({ session, state, isHost }: { session: Session; state: RoomState; isHost: boolean }) {
  useTick(500); // picks up session.calib.localError
  const c = state.calibration;
  const name = (id: string | null) => state.devices.find((d) => d.id === id)?.name ?? 'device';
  const running = c?.status === 'running';
  const local = session.calib.localError;
  const err = local ?? (c?.status === 'failed' ? c.error : null);
  const rows = c && (c.status === 'done' || c.status === 'failed') ? Object.entries(c.results) : [];

  if (!isHost && !running) return null;
  return (
    <div className="calpanel">
      {isHost && !running && (
        <>
          <button className="btn primary" onClick={() => session.startCalibration()}>Auto-calibrate</button>
          <p className="hint">Pause the music and keep the room quiet. Each device plays a short chirp three times while this device's microphone listens; every device's trim is then set automatically so they line up with this one. Sit where you want the best sound, with this device's mic facing the speakers. The manual trim sliders below stay available as an override.</p>
        </>
      )}
      {running && (
        <div className="calprog">
          <b>
            {c!.phase === 'arming' && 'Starting the microphone...'}
            {c!.phase === 'step' && `Calibrating ${name(c!.deviceId)}${c!.deviceId === session.deviceId ? ' (you)' : ''} ${c!.step + 1}/${c!.total}...`}
            {c!.phase === 'analysing' && 'Analysing the recording...'}
          </b>
          <progress max={c!.total + 1} value={Math.max(0, c!.step + 1)} />
          <p className="hint">Keep the room quiet. You will hear short chirps.</p>
          {isHost && <button className="btn sm" onClick={() => session.cancelCalibration()}>Cancel</button>}
        </div>
      )}
      {err && !running && <p className="err">{ERR[err] ?? `Calibration failed (${err}).`}</p>}
      {c?.status === 'done' && !running && <p className="hint okc">Calibration done. Trims were set automatically.</p>}
      {rows.length > 0 && !running && (
        <table className="caltable">
          <thead><tr><th>Device</th><th>Delay</th><th>Trim set</th><th>Score</th></tr></thead>
          <tbody>
            {rows.map(([id, r]) => (
              <tr key={id}>
                <td>{name(id)}</td>
                <td className="mono">{r.error ? '--' : `${r.delayMs.toFixed(1)} ms`}</td>
                <td className="mono">{r.error ? (r.error === 'low-confidence' ? 'unchanged (retry)' : r.error) : `${(r.trimMs ?? 0) > 0 ? '+' : ''}${(r.trimMs ?? 0).toFixed(1)} ms`}</td>
                <td><ScoreBadge score={r.error ? 0 : r.score} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
