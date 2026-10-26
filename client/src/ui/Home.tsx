import { useState } from 'react';
import { setHostToken, getName, setName } from './connect';

export default function Home() {
  const [code, setCode] = useState('');
  const [name, setNm] = useState(getName());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function create() {
    setBusy(true); setErr('');
    try {
      const r = await fetch('/api/rooms', { method: 'POST' });
      const { roomId, hostToken } = await r.json();
      setHostToken(roomId, hostToken);
      if (name.trim()) setName(name.trim());
      location.hash = `#/r/${roomId}`;
    } catch { setErr('Could not reach the server.'); }
    setBusy(false);
  }
  async function join(e: React.FormEvent) {
    e.preventDefault();
    const id = code.trim().toUpperCase();
    if (!id) return;
    setBusy(true); setErr('');
    try {
      const r = await fetch(`/api/rooms/${id}`);
      const { exists } = await r.json();
      if (!exists) setErr('No room with that code.');
      else { if (name.trim()) setName(name.trim()); location.hash = `#/r/${id}`; }
    } catch { setErr('Could not reach the server.'); }
    setBusy(false);
  }

  return (
    <main className="home">
      <div className="glow" />
      <div className="brand"><span className="wave"><i /><i /><i /><i /><i /></span>SyncWave</div>
      <h1>Every device,<br /><em>one speaker.</em></h1>
      <p className="lede">Open a link, tap join, and every phone and laptop in the room plays the same audio within 10 ms.</p>

      <label className="field">
        <span>Your name</span>
        <input value={name} onChange={(e) => setNm(e.target.value)} placeholder="e.g. Sai's phone" maxLength={24} />
      </label>

      <button className="btn primary big" onClick={create} disabled={busy}>Start a room</button>
      <div className="or"><span>or join one</span></div>
      <form onSubmit={join} className="joinrow">
        <input className="code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="CODE" maxLength={5} autoCapitalize="characters" autoCorrect="off" spellCheck={false} />
        <button className="btn" disabled={busy || !code.trim()}>Join</button>
      </form>
      {err && <p className="err">{err}</p>}
    </main>
  );
}
