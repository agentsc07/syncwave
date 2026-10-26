import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { roomLink } from './connect';

/** Copy + native share for the join link. Falls back gracefully (no clipboard, no share sheet). */
export function InviteButtons({ roomId }: { roomId: string }) {
  const [copied, setCopied] = useState<'' | 'ok' | 'fail'>('');
  const link = roomLink(roomId);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied('ok');
    } catch {
      // insecure context or denied: select-and-copy fallback
      try {
        const t = document.createElement('textarea');
        t.value = link; t.style.position = 'fixed'; t.style.opacity = '0';
        document.body.appendChild(t); t.select();
        setCopied(document.execCommand('copy') ? 'ok' : 'fail');
        t.remove();
      } catch { setCopied('fail'); }
    }
    setTimeout(() => setCopied(''), 2500);
  }
  async function share() {
    try { await navigator.share({ title: 'Join my SyncWave room', text: `Join my SyncWave room ${roomId}`, url: link }); }
    catch { /* cancelled */ }
  }
  return (
    <div className="invitebtns">
      <button className="btn" onClick={copy}>{copied === 'ok' ? 'Link copied' : copied === 'fail' ? 'Copy failed, see link' : 'Copy link'}</button>
      {canShare && <button className="btn primary" onClick={share}>Share</button>}
      <span className="sr" role="status">{copied === 'ok' ? 'Link copied to clipboard' : ''}</span>
    </div>
  );
}

export default function QrJoin({ roomId, compact = false }: { roomId: string; compact?: boolean }) {
  const [url, setUrl] = useState('');
  const link = roomLink(roomId);
  useEffect(() => {
    QRCode.toDataURL(link, { margin: 1, width: 360, color: { dark: '#07080c', light: '#ffffff' } })
      .then(setUrl).catch(() => setUrl(''));
  }, [link]);
  const local = /^(localhost|127\.|\[::1\])/.test(location.hostname);
  return (
    <div className={'qr' + (compact ? ' compact' : '')}>
      {url ? <img src={url} alt={`QR code to join room ${roomId}`} /> : <div className="qrph" />}
      <div className="qrcode" aria-label={`Room code ${roomId.split('').join(' ')}`}>{roomId}</div>
      <p className="hint center">Scan with a phone camera, or open the link and enter the code.</p>
      <InviteButtons roomId={roomId} />
      <code className="linktxt">{link}</code>
      {local && <p className="hint warnc center">You opened this page via localhost, so other devices cannot reach this link. Open the app at your computer's network address (http://&lt;ip&gt;:3000) first.</p>}
    </div>
  );
}
