import type { Device } from '../lib/types';

const RINGS = [10, 25, 50, 100]; // ms
const MAXMS = 100;
function radius(ms: number, R: number) {
  // sqrt scale so small offsets stay legible
  return R * Math.sqrt(Math.min(Math.abs(ms), MAXMS) / MAXMS);
}

export default function Radar({ devices, selfId, big }: { devices: Device[]; selfId: string; big?: boolean }) {
  const S = 360, C = S / 2, R = 160;
  const live = devices.filter((d) => d.connected);
  const locked = live.filter((d) => d.offsetMs != null && Math.abs(d.offsetMs) < 10).length;
  return (
    <div className={'radar' + (big ? ' big' : '')}>
      <svg viewBox={`0 0 ${S} ${S}`} role="img" aria-label="Sync radar">
        <defs>
          <radialGradient id="rg"><stop offset="0" stopColor="#38f8b0" stopOpacity=".18" /><stop offset="1" stopColor="#38f8b0" stopOpacity="0" /></radialGradient>
        </defs>
        <circle cx={C} cy={C} r={R} fill="url(#rg)" />
        {RINGS.map((ms) => (
          <g key={ms}>
            <circle cx={C} cy={C} r={radius(ms, R)} className={'ring' + (ms === 10 ? ' lock' : '')} />
            <text x={C + 4} y={C - radius(ms, R) - 3} className="rlabel">{ms}ms</text>
          </g>
        ))}
        <g className="sweep" style={{ transformOrigin: `${C}px ${C}px` }}>
          <path d={`M${C} ${C} L${C + R} ${C} A${R} ${R} 0 0 0 ${C + R * Math.cos(-0.6)} ${C + R * Math.sin(-0.6)} Z`} fill="#38f8b0" opacity=".12" />
        </g>
        <circle cx={C} cy={C} r="3" fill="#e8ecf4" />
        {live.map((d, i) => {
          const known = d.offsetMs != null;
          const ang = (i / Math.max(live.length, 1)) * Math.PI * 2 - Math.PI / 2;
          const r = known ? radius(d.offsetMs!, R) : R + 10;
          const x = C + Math.cos(ang) * Math.max(r, 12);
          const y = C + Math.sin(ang) * Math.max(r, 12);
          const ok = known && Math.abs(d.offsetMs!) < 10;
          const cls = !known ? 'unk' : ok ? 'ok' : Math.abs(d.offsetMs!) < 25 ? 'warn' : 'bad';
          return (
            <g key={d.id} className={'dot ' + cls} style={{ transform: `translate(${x}px, ${y}px)` }}>
              <circle r={ok ? 9 : 7} className="halo" />
              <circle r="5.5" />
              <text y="-13" textAnchor="middle" className="dname">{d.name}{d.id === selfId ? ' (you)' : ''}</text>
              <text y="21" textAnchor="middle" className="doff">{known ? `${d.offsetMs! >= 0 ? '+' : ''}${d.offsetMs!.toFixed(1)}ms` : '...'}{d.syncScore != null ? ` · ${d.syncScore}` : ''}</text>
            </g>
          );
        })}
      </svg>
      <div className="radarsum"><b>{locked}</b>/{live.length} locked <span>under 10 ms</span></div>
    </div>
  );
}
