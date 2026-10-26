import { useEffect, useState } from 'react';
import Home from './ui/Home';
import RoomPage from './ui/Room';
import { UpdateToast } from './ui/status';

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
  const [updated, setUpdated] = useState(false);
  useEffect(() => {
    const f = () => setUpdated(true);
    window.addEventListener('syncwave:update', f);
    return () => window.removeEventListener('syncwave:update', f);
  }, []);
  const r = parse(hash);
  return (
    <>
      {r.page === 'home' ? <Home /> : <RoomPage key={r.roomId + (r.radar ? 'r' : '')} roomId={r.roomId} radarOnly={r.radar} />}
      <UpdateToast show={updated} />
    </>
  );
}
