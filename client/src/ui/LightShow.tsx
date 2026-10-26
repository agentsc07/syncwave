import { useEffect, useRef, useState } from 'react';
import type { Session } from '../lib/net';

export default function LightShow({ session, active }: { session: Session; active: boolean }) {
  const [dismissed, setDismissed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const hue = useRef(0);

  useEffect(() => { if (!active) setDismissed(false); }, [active]);

  useEffect(() => {
    if (!active || dismissed) return;
    const un: unknown = session.engine.onBeat(() => {
      const el = ref.current; if (!el) return;
      hue.current = (hue.current + 47 + Math.random() * 40) % 360;
      el.style.transition = 'none';
      el.style.background = `radial-gradient(circle at 50% 50%, hsl(${hue.current} 100% 62%), hsl(${(hue.current + 40) % 360} 100% 40%))`;
      el.style.opacity = '1';
      requestAnimationFrame(() => requestAnimationFrame(() => {
        el.style.transition = 'opacity 380ms ease-out';
        el.style.opacity = '0.04';
      }));
    });
    return () => { if (typeof un === 'function') un(); };
  }, [session, active, dismissed]);

  if (!active || dismissed) return null;
  return (
    <div className="lights" onClick={() => setDismissed(true)}>
      <div className="lightbg" ref={ref} />
      <span>tap to exit lights</span>
    </div>
  );
}
