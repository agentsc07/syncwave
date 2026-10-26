import { useEffect, useRef, useState } from 'react';
import { setHostToken, getName, setName } from './connect';

/** Pull a room code out of whatever was pasted: "ab c12", a full join link, or "#/r/ABC12". */
export function cleanCode(raw: string): string {
  const m = raw.match(/#\/r\/([A-Za-z0-9]{3,8})/);
  const s = (m ? m[1] : raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.slice(0, 5);
}

const STEPS = [
  ['1', 'Start a room', 'Tap once. You get a 5-letter code and a QR code.'],
  ['2', 'Everyone joins', 'Friends scan the QR or type the code. No app, no account.'],
  ['3', 'One speaker', 'Add a song and press play. Every device plays it in sync.'],
];

export default function Home() {
  const params = new URLSearchParams(location.search);
  const [code, setCode] = useState(cleanCode(params.get('join') ?? params.get('room') ?? ''));
  const [name, setNm] = useState(getName());
  const [busy, setBusy] = useState<'' | 'create' | 'join'>('');
  const [err, setErr] = useState('');
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (params.get('join') || params.get('room')) codeRef.current?.focus(); }, []); // eslint-disable-line

  const net = () => setErr(navigator.onLine === false
    ? 'You are offline. Connect to Wi-Fi or mobile data and try again.'
    : 'Could not reach the server. If it was idle it may be waking up (up to a minute on the free tier). Try again in a moment.');

  async function create() {
    setBusy('create'); setErr('');
    try {
      const r = await fetch('/api/rooms', { method: 'POST' });
      if (!r.ok) throw new Error(String(r.status));
      const { roomId, hostToken } = await r.json();
      setHostToken(roomId, hostToken);
      if (name.trim()) setName(name.trim());
      location.hash = `#/r/${roomId}`;
    } catch { net(); }
    setBusy('');
  }
  async function join(e: React.FormEvent) {
    e.preventDefault();
    const id = cleanCode(code);
    if (id.length < 5) { setErr('Room codes have 5 characters, like K7QM2.'); codeRef.current?.focus(); return; }
    setBusy('join'); setErr('');
    try {
      const r = await fetch(`/api/rooms/${id}`);
      if (!r.ok) throw new Error(String(r.status));
      const { exists } = await r.json();
      if (!exists) setErr(`No room "${id}". Check the code with the host. Rooms close when the host leaves or the server restarts.`);
      else { if (name.trim()) setName(name.trim()); location.hash = `#/r/${id}`; }
    } catch { net(); }
    setBusy('');
  }

  return (
    <main className="home landing">
      <div className="glow" aria-hidden="true" />
      <div className="brand"><span className="wave" aria-hidden="true"><i /><i /><i /><i /><i /></span>SyncWave</div>

      <section className="hero">
        <h1>Every device,<br /><em>one speaker.</em></h1>
        <p className="lede">Turn the phones and laptops in the room into one sound system, in sync to within a few milliseconds.</p>
        <div className="rings" aria-hidden="true"><span /><span /><span /><b /></div>
      </section>

      <label className="field">
        <span>Your name</span>
        <input value={name} onChange={(e) => setNm(e.target.value)} placeholder="e.g. Sai's phone" maxLength={24} autoComplete="nickname" enterKeyHint="go" />
      </label>

      <button className="btn primary big" onClick={create} disabled={!!busy}>{busy === 'create' ? 'Opening room...' : 'Start a room'}</button>

      <div className="or"><span>or join with a code</span></div>
      <form onSubmit={join} className="joinrow">
        <label className="sr" htmlFor="roomcode">Room code, 5 characters</label>
        <input id="roomcode" ref={codeRef} className="code" value={code}
          onChange={(e) => setCode(cleanCode(e.target.value))}
          onPaste={(e) => { e.preventDefault(); setCode(cleanCode(e.clipboardData.getData('text'))); }}
          placeholder="K7QM2" maxLength={80} inputMode="text" autoCapitalize="characters" autoComplete="off" autoCorrect="off" spellCheck={false} />
        <button className="btn" disabled={!!busy || code.length < 5}>{busy === 'join' ? '...' : 'Join'}</button>
      </form>
      <p className="hint small">Tip: you can also scan the host's QR code with your camera.</p>
      {err && <p className="err" role="alert">{err}</p>}

      <section className="how" aria-labelledby="how-h">
        <h3 id="how-h">How it works</h3>
        <ol>
          {STEPS.map(([n, t, d]) => (
            <li key={n}><span className="stepn" aria-hidden="true">{n}</span><div><b>{t}</b><p>{d}</p></div></li>
          ))}
        </ol>
      </section>
    </main>
  );
}
