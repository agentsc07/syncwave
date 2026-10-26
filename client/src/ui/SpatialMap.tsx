import { useRef, useState } from 'react';
import type { Device, Channel } from '../lib/types';

export function regionChannel(x: number, y: number): Channel {
  const dx = x - 0.5, dy = y - 0.5;
  if (Math.hypot(dx, dy) < 0.17) return 'center';
  if (y > 0.7) return x < 0.5 ? 'rear-left' : 'rear-right';
  return x < 0.5 ? 'left' : 'right';
}

const LABEL: Record<string, string> = {
  stereo: 'Stereo', left: 'L', right: 'R', center: 'C', 'rear-left': 'RL', 'rear-right': 'RR', sub: 'Sub',
};

export default function SpatialMap({ devices, isHost, onMove }: {
  devices: Device[]; isHost: boolean;
  onMove: (id: string, channel: Channel, x: number, y: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);

  function pos(e: React.PointerEvent) {
    const r = ref.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  }
  return (
    <div className="map" ref={ref}
      onPointerMove={(e) => { if (drag) setDrag({ id: drag.id, ...pos(e) }); }}
      onPointerUp={() => { if (drag) { onMove(drag.id, regionChannel(drag.x, drag.y), drag.x, drag.y); setDrag(null); } }}
      onPointerCancel={() => setDrag(null)}>
      <div className="zone zl">L</div><div className="zone zr">R</div>
      <div className="zone zc">C</div><div className="zone zrl">RL</div><div className="zone zrr">RR</div>
      <div className="listener" title="Listener" />
      {devices.filter((d) => d.connected).map((d, i, all) => {
        // devices share the default spot (0.5,0.5): stack their chips so none is hidden underneath
        const dup = all.slice(0, i).filter((o) => o.x === d.x && o.y === d.y).length;
        const p = drag?.id === d.id ? drag : { x: d.x, y: d.y };
        const ch = drag?.id === d.id ? regionChannel(drag.x, drag.y) : d.channel;
        return (
          <div key={d.id} className={'chip' + (drag?.id === d.id ? ' drag' : '') + (isHost ? '' : ' ro')}
            style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, marginTop: drag?.id === d.id ? 0 : dup * 34 }}
            onPointerDown={(e) => { if (!isHost) return; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); setDrag({ id: d.id, ...pos(e) }); }}>
            <b>{LABEL[ch] ?? ch}</b><span>{d.name}</span>
          </div>
        );
      })}
    </div>
  );
}
