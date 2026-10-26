import { useEffect, useRef, useState } from 'react';
import type { Session } from '../lib/net';

// Colour cycling per beat; downbeats (first beat of a bar) get a hotter palette and a ring.
const PALETTE = [320, 190, 48, 268, 140, 8, 215, 90];
const DOWN = ['#ffffff', '#ffd54a', '#ff4d8d', '#4de1ff'];
const LS_SOFT = 'sw.lights.soft';

function prefersReduced(): boolean {
  try { return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}
function readSoft(): boolean {
  try {
    const v = localStorage.getItem(LS_SOFT);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch { /* ignore */ }
  return prefersReduced();
}

function anim(el: HTMLElement | null, keys: Keyframe[], opts: KeyframeAnimationOptions) {
  if (!el) return;
  if (typeof el.animate === 'function') {
    el.getAnimations?.().forEach((a) => a.cancel());
    el.animate(keys, { fill: 'forwards', ...opts });
  } else {
    // very old browsers: snap to the last frame
    Object.assign(el.style, keys[keys.length - 1] as unknown as CSSStyleDeclaration);
  }
}

export default function LightShow({ session, active }: { session: Session; active: boolean }) {
  const [dismissed, setDismissed] = useState(false);
  const [soft, setSoft] = useState(readSoft);
  const [bpm, setBpm] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const flash = useRef<HTMLDivElement>(null);
  const glow = useRef<HTMLDivElement>(null);
  const ring = useRef<HTMLDivElement>(null);
  const n = useRef(0);
  const softRef = useRef(soft);
  softRef.current = soft;

  useEffect(() => { if (!active) setDismissed(false); }, [active]);

  useEffect(() => {
    if (!active || dismissed) return;
    let lastBpm: number | null = null;
    const un: unknown = session.engine.onBeat((_t, info) => {
      const strength = Math.max(0.15, Math.min(1, info?.strength ?? 0.7));
      const down = !!info?.downbeat;
      const soft = softRef.current;
      const i = n.current++;
      const hue = PALETTE[(i + (down ? 3 : 0)) % PALETTE.length];
      const colour = down ? DOWN[Math.floor(i / 4) % DOWN.length] : `hsl(${hue} 100% 58%)`;
      const peak = soft ? 0.12 + 0.28 * strength : Math.min(1, 0.3 + 0.6 * strength + (down ? 0.2 : 0));
      const beatMs = info?.bpm ? 60000 / info.bpm : 500;
      const dur = (soft ? 0.9 : down ? 0.8 : 0.55) * Math.min(beatMs, 700) + 150;
      if (root.current) root.current.dataset.beat = String(i);
      const f = flash.current;
      if (f) {
        f.style.background = down
          ? `radial-gradient(circle at 50% 50%, ${colour} 0%, ${colour} 30%, hsl(${hue} 100% 50%) 100%)`
          : `radial-gradient(circle at 50% 45%, ${colour}, hsl(${(hue + 40) % 360} 100% 38%))`;
        anim(f, [{ opacity: peak }, { opacity: 0 }], { duration: dur, easing: 'cubic-bezier(.12,.7,.3,1)' });
      }
      const g = glow.current;
      if (g) {
        g.style.background = `radial-gradient(circle at 50% 55%, hsl(${hue} 100% 55%), transparent 70%)`;
        anim(g, [{ opacity: soft ? 0.18 : 0.3 }, { opacity: soft ? 0.1 : 0.14 }], { duration: Math.max(300, beatMs), easing: 'ease-out' });
      }
      const r = ring.current;
      if (r && down && !soft) {
        r.style.borderColor = colour;
        anim(r, [{ opacity: 0.9, transform: 'scale(.25)' }, { opacity: 0, transform: 'scale(1.7)' }], { duration: 750, easing: 'ease-out' });
      }
      const b = info?.bpm ?? null;
      if (b !== lastBpm) { lastBpm = b; setBpm(b); }
    });
    return () => { if (typeof un === 'function') un(); };
  }, [session, active, dismissed]);

  if (!active || dismissed) return null;
  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    const v = !soft;
    setSoft(v);
    try { localStorage.setItem(LS_SOFT, v ? '1' : '0'); } catch { /* ignore */ }
  };
  return (
    <div className="lights" ref={root} onClick={() => setDismissed(true)}>
      <div className="lightglow" ref={glow} />
      <div className="lightbg" ref={flash} />
      <div className="lightring" ref={ring} />
      {bpm ? <small className="lightbpm">{Math.round(bpm)} BPM</small> : null}
      <button type="button" className="lightsoft" onClick={toggle} aria-pressed={soft} title="Gentler pulses instead of bright flashes">
        Soft mode: {soft ? 'on' : 'off'}
      </button>
      <span>tap to exit lights{soft ? '' : ' · flashing lights'}</span>
    </div>
  );
}
