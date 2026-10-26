import { useEffect, useState } from 'react';
import Home from './ui/Home';
import RoomPage from './ui/Room';

function parse(hash: string): { page: 'home' } | { page: 'room'; roomId: string; radar: boolean } {
  const m = hash.match(/^#\/r\/([A-Za-z0-9]+)(\/radar)?/);
  if (m) return { page: 'room', roomId: m[1].toUpperCase(), radar: !!m[2] };
  return { page: 'home' };
}

export default function App() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const f = () => setHash(location.hash);
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  const r = parse(hash);
  if (r.page === 'home') return <Home />;
  return <RoomPage key={r.roomId + (r.radar ? 'r' : '')} roomId={r.roomId} radarOnly={r.radar} />;
}
