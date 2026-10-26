#!/usr/bin/env node
// Post-deploy smoke test, no dependencies (Node 22+ has global WebSocket; Node 20 needs --experimental-websocket).
// Usage: node scripts/smoke.mjs https://syncwave.onrender.com
const base = (process.argv[2] || process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
let failed = false;
const ok = (name, detail = '') => console.log(`PASS  ${name} ${detail}`);
const bad = (name, e) => { failed = true; console.log(`FAIL  ${name}: ${e?.message ?? e}`); };
async function step(name, fn) { try { ok(name, (await fn()) ?? ''); return true; } catch (e) { bad(name, e); return false; } }
const timeout = (ms, what) => new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout (${what})`)), ms));
const json = async (url, init) => {
  const r = await Promise.race([fetch(url, init), timeout(90000, url)]); // 90 s: free tier cold start
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
};

console.log(`Smoke test: ${base}`);
let WS = globalThis.WebSocket;
if (!WS) { try { WS = (await import('ws')).default; } catch {} }

await step('GET /healthz', async () => { const h = await json(`${base}/healthz`); if (!h.ok) throw new Error('ok != true'); return `uptime ${h.uptime}s`; });
await step('GET / serves client HTML', async () => {
  const r = await fetch(base + '/'); const t = await r.text();
  if (!r.ok || !/<html|<!doctype/i.test(t)) throw new Error('no HTML (client not built?)');
});
let room;
await step('POST /api/rooms', async () => { room = await json(`${base}/api/rooms`, { method: 'POST' }); if (!room.roomId) throw new Error('no roomId'); return room.roomId; });
await step('GET /api/demo', async () => { const d = await json(`${base}/api/demo`); return `separation=${d.separation} demos=${d.demos.length}`; });

if (room && WS) {
  await step('WebSocket ping/pong + join', () => new Promise((resolve, reject) => {
    const ws = new WS(base.replace(/^http/, 'ws') + '/ws');
    const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('timeout')); }, 20000);
    let pong = false;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'ping', t0: Date.now() }));
    ws.onerror = () => { clearTimeout(t); reject(new Error('socket error (is wss blocked / server asleep?)')); };
    ws.onmessage = (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (m.type === 'pong' && !pong) {
        pong = true;
        ws.send(JSON.stringify({ type: 'join', roomId: room.roomId, name: 'smoke', deviceId: 'smoke-' + Date.now(), hostToken: room.hostToken }));
      } else if (m.type === 'joined') { clearTimeout(t); ws.close(); resolve(`host=${m.isHost}`); }
      else if (m.type === 'error') { clearTimeout(t); ws.close(); reject(new Error(m.message)); }
    };
  }));
} else if (room) bad('WebSocket', 'no global WebSocket; use Node 22+ or run `node --experimental-websocket scripts/smoke.mjs`');

console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
process.exit(failed ? 1 : 0);
