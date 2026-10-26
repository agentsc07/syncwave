import test from 'node:test';
import assert from 'node:assert/strict';
import { Room, RoomManager, makeRoomId, DEVICE_TTL_MS, ROOM_EMPTY_TTL_MS } from '../src/room.js';

function setup() {
  let t = 1_000_000;
  const clock = () => t;
  const room = new Room('ABCDE', { clock });
  const mk = (id, token) => {
    const inbox = [];
    const conn = { send: (m) => inbox.push(m), close: () => { conn.closed = true; } };
    room.join({ deviceId: id, name: id, hostToken: token }, conn);
    return { conn, inbox, last: (type) => [...inbox].reverse().find((m) => m.type === type) };
  };
  return { room, mk, clock, advance: (ms) => { t += ms; } };
}

test('room ids avoid ambiguous chars', () => {
  for (let i = 0; i < 200; i++) assert.match(makeRoomId(), /^[A-HJKMNP-Z2-9]{5}$/);
});

test('host via token, handoff to oldest connected', () => {
  const { room, mk } = setup();
  const a = mk('a', room.hostToken);
  const b = mk('b'); const c = mk('c');
  assert.equal(a.last('joined').isHost, true);
  assert.equal(b.last('joined').isHost, false);
  room.disconnect('a', a.conn);
  assert.equal(room.hostId, 'b');
  assert.equal(c.last('state').hostId, 'b');
  room.handle('c', { type: 'leave' });
  room.handle('b', { type: 'leave' });
  assert.equal(room.devices.size, 1);
});

test('host reconnect with token reclaims host', () => {
  const { room, mk } = setup();
  const a = mk('a', room.hostToken); mk('b');
  room.disconnect('a', a.conn);
  assert.equal(room.hostId, 'b');
  mk('a', room.hostToken);
  assert.equal(room.hostId, 'a');
});

test('play gating, schedule, pause, seek', () => {
  const { room, mk, advance } = setup();
  const h = mk('h', room.hostToken); const g = mk('g');
  room.addTrack({ id: 't1', name: 'one', sizeBytes: 5 });
  room.handle('h', { type: 'ready', trackId: 't1' });
  room.handle('h', { type: 'play' });
  assert.equal(h.last('error').message, 'not all ready');
  assert.equal(room.playback.status, 'stopped');
  room.handle('g', { type: 'play' }); // non-host ignored
  assert.equal(g.inbox.filter((m) => m.type === 'error').length, 0);
  room.handle('g', { type: 'ready', trackId: 't1' });
  room.handle('h', { type: 'play' });
  const S = room.playback.startServerTime;
  assert.equal(S, 1_000_000 + 1500);
  assert.equal(room.snapshot().playback.status, 'scheduled');
  advance(3000);
  assert.equal(room.snapshot().playback.status, 'playing');
  room.handle('h', { type: 'pause' });
  assert.equal(room.playback.pausedPositionMs, 3000 - 1500);
  assert.equal(room.playback.status, 'paused');
  room.handle('h', { type: 'play' });
  assert.equal(room.playback.startServerTime, 1_003_000 + 1500 - 1500);
  advance(100);
  room.handle('h', { type: 'seek', positionMs: 30000 });
  assert.equal(room.playback.startServerTime, 1_003_100 + 1000 - 30000);
});

test('disconnected devices do not block play', () => {
  const { room, mk } = setup();
  const h = mk('h', room.hostToken); const g = mk('g');
  room.addTrack({ id: 't1', name: 'one', sizeBytes: 5 });
  room.handle('h', { type: 'ready', trackId: 't1' });
  room.disconnect('g', g.conn);
  room.handle('h', { type: 'play' });
  assert.equal(room.playback.status, 'scheduled');
  assert.equal(h.inbox.filter((m) => m.type === 'error').length, 0);
});

test('trim, channel, volume, lights, kick are host-only; trimSelf any', () => {
  const { room, mk } = setup();
  mk('h', room.hostToken); const g = mk('g');
  room.handle('g', { type: 'setTrim', deviceId: 'g', ms: 50 });
  assert.equal(room.devices.get('g').trimMs, 0);
  room.handle('g', { type: 'setTrimSelf', ms: 20 });
  assert.equal(room.devices.get('g').trimMs, 20);
  room.handle('h', { type: 'setTrim', deviceId: 'g', ms: -75 });
  assert.equal(room.devices.get('g').trimMs, -75);
  room.handle('h', { type: 'setChannel', deviceId: 'g', channel: 'left', x: 0.1, y: 2 });
  assert.deepEqual([room.devices.get('g').channel, room.devices.get('g').x, room.devices.get('g').y], ['left', 0.1, 1]);
  room.handle('h', { type: 'setChannel', deviceId: 'g', channel: 'bogus' });
  assert.equal(room.devices.get('g').channel, 'left');
  room.handle('h', { type: 'volume', value: 5 });
  assert.equal(room.volume, 1);
  room.handle('h', { type: 'volume', value: 0.3 });
  assert.equal(room.volume, 0.3);
  room.handle('h', { type: 'lights', on: true });
  assert.equal(room.lights, true);
  room.handle('h', { type: 'kick', deviceId: 'g' });
  assert.equal(room.devices.has('g'), false);
  assert.equal(g.conn.closed, true);
});

test('report updates device health', () => {
  const { room, mk } = setup();
  mk('h', room.hostToken);
  room.handle('h', { type: 'report', offsetMs: 1.5, driftMs: -0.5, rtt: 12 });
  const d = room.snapshot().devices[0];
  assert.deepEqual([d.offsetMs, d.driftMs, d.rtt], [1.5, -0.5, 12]);
  room.destroy();
});

test('queue ordering by votes, next pops top else next in list', () => {
  const { room, mk } = setup();
  mk('h', room.hostToken); mk('a'); mk('b');
  for (const id of ['t1', 't2', 't3', 't4']) room.addTrack({ id, name: id, sizeBytes: 1 });
  assert.equal(room.playback.trackId, 't1');
  room.handle('a', { type: 'queueAdd', trackId: 't3' });
  room.handle('a', { type: 'queueAdd', trackId: 't2' });
  room.handle('b', { type: 'queueVote', trackId: 't2' });
  room.handle('b', { type: 'queueVote', trackId: 't4' }); // voting a library track queues it
  room.handle('b', { type: 'queueVote', trackId: 't4' }); // second tap removes the vote
  const s = room.snapshot();
  assert.deepEqual(s.queue, ['t2', 't3', 't4']);
  assert.equal(s.tracks.find((t) => t.id === 't2').votes, 2);
  room.handle('h', { type: 'next' });
  assert.equal(room.playback.trackId, 't2');
  assert.equal(room.playback.status, 'stopped');
  assert.deepEqual(room.snapshot().queue, ['t3', 't4']);
  room.handle('h', { type: 'next' });
  assert.equal(room.playback.trackId, 't3');
  room.handle('h', { type: 'next' });
  assert.equal(room.playback.trackId, 't4');
});

test('stale devices removed after 60s, empty rooms after 10min', () => {
  const { room, mk, advance } = setup();
  const a = mk('a', room.hostToken);
  room.disconnect('a', a.conn);
  advance(DEVICE_TTL_MS - 1000);
  assert.equal(room.sweep(), false);
  assert.equal(room.devices.size, 1);
  advance(2000);
  room.sweep();
  assert.equal(room.devices.size, 0);
  advance(ROOM_EMPTY_TTL_MS - DEVICE_TTL_MS - 5000);
  assert.equal(room.sweep(), false);
  advance(10_000);
  assert.equal(room.sweep(), true);
});

test('RoomManager create/get/sweep', () => {
  let t = 0;
  const m = new RoomManager({ clock: () => t });
  const r = m.create();
  assert.equal(m.get(r.roomId.toLowerCase()), r);
  t += ROOM_EMPTY_TTL_MS + 1;
  m.sweep();
  assert.equal(m.get(r.roomId), undefined);
});
