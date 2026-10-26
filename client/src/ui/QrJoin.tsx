import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { roomLink } from './connect';

export default function QrJoin({ roomId }: { roomId: string }) {
  const [url, setUrl] = useState('');
  const link = roomLink(roomId);
  useEffect(() => {
    QRCode.toDataURL(link, { margin: 1, width: 360, color: { dark: '#07080c', light: '#ffffff' } })
      .then(setUrl).catch(() => setUrl(''));
  }, [link]);
  return (
    <div className="qr">
      {url ? <img src={url} alt={`QR code to join room ${roomId}`} /> : <div className="qrph" />}
      <div className="qrcode">{roomId}</div>
      <button className="linkbtn" onClick={() => navigator.clipboard?.writeText(link)}>{link}</button>
    </div>
  );
}
