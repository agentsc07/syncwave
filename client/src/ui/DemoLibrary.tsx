import { useEffect, useState } from 'react';
import type { Session } from '../lib/net';

interface Demo { slug: string; title: string; durationSec: number | null }

/** Host-only picker for the built-in demo songs (CC BY, see server/demo/README.md). */
export default function DemoLibrary({ session }: { session: Session }) {
  const [demos, setDemos] = useState<Demo[] | null>(null);
  const [slug, setSlug] = useState('');
  useEffect(() => {
    fetch('/api/demo').then((r) => r.json())
      .then((j) => { setDemos(j.demos ?? []); setSlug((s) => s || j.demos?.[0]?.slug || ''); })
      .catch(() => setDemos([]));
  }, []);
  if (!demos || demos.length === 0) return null;
  return (
    <>
      <h3>Demo songs</h3>
      <div className="orchbox">
        <select className="grow" value={slug} onChange={(e) => setSlug(e.target.value)} aria-label="Demo song">
          {demos.map((d) => <option key={d.slug} value={d.slug}>{d.title}</option>)}
        </select>
        <button className="btn" disabled={!slug} onClick={() => session.addDemo(slug)}>Add to room</button>
      </div>
      <p className="hint">Built-in songs (CC BY, no upload needed). Every device plays the full song.</p>
    </>
  );
}
