import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/room.js';

function setup(calib = { leadMs: 20, gapMs: 10, tailMs: 10, readyTimeoutMs: 80, resultTimeoutMs: 80 }) {
  const room = new Room('CALIB', { calib });
  const mk = (id, token) => {
    const inbox = [];
    const conn = { send: (m) => inbox.push(m), close() {} };
    room.join({ deviceId: id, name: id, hostToken: token }, conn);
    return { inbox, steps: () => inbox.filter((m) => m.type === 'calibrateStep') };
  };
  return { room, mk };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('calibration: happy path sequences host first, applies relative trims', async () => {
  const { room, mk } = setup();
  const h = mk('h', room.hostToken); const a = mk('a'); const b = mk('b');
  room.handle('a', { type: 'calibrateStart' }); // non-host ignored
  assert.equal(room.calibration.status, 'idle');
  room.handle('h', { type: 'calibrateStart' });
  const runId = room.calibration.runId;
  assert.equal(room.calibration.status, 'running');
  assert.equal(room.calibration.phase, 'arming');
  room.handle('h', { type: 'calibrateReady', runId: 'wrong' });
  assert.equal(room.calibration.phase, 'arming');
  room.handle('h', { type: 'calibrateReady', runId });
  assert.equal(room.calibration.deviceId, 'h');
  assert.equal(h.steps().length, 1);
  assert.equal(h.steps()[0].times.length, 3);
  assert.ok(h.steps()[0].times[0] > room.clock());
  assert.equal(room.derivedStatus(), 'stopped');
  await sleep(180);
  assert.equal(room.calibration.phase, 'analysing');
  assert.deepEqual(a.steps().map((m) => m.deviceId), ['h', 'a', 'b']);
  room.handle('h', { type: 'calibrationResult', runId, results: {
    h: { delayMs: 30, score: 90 }, a: { delayMs: 230.04, score: 80 }, b: { delayMs: 12, score: 70.4 } } });
  assert.equal(room.calibration.status, 'done');
  const dev = (id) => room.devices.get(id);
  assert.equal(dev('h').trimMs, 0);          // reference
  assert.equal(dev('a').trimMs, 200);        // 200 ms later than host -> play 200 ms earlier
  assert.equal(dev('b').trimMs, -18);        // earlier than host -> negative trim delays it
  assert.equal(dev('b').syncScore, 70);
  assert.equal(room.calibration.results.a.trimMs, 200);
  assert.equal(room.snapshot().calibration.status, 'done');
});

test('calibration: failures, cancel, gating, clamp, median reference', async () => {
  const { room, mk } = setup();
  mk('h', room.hostToken); mk('a'); mk('b');
  room.handle('h', { type: 'calibrateStart' });
  room.handle('h', { type: 'calibrateCancel' });
  assert.equal(room.calibration.error, 'cancelled');
  // mic denied
  room.handle('h', { type: 'calibrateStart' });
  room.handle('h', { type: 'calibrationResult', runId: room.calibration.runId, error: 'mic-denied' });
  assert.equal(room.calibration.status, 'failed');
  assert.equal(room.calibration.error, 'mic-denied');
  // ready timeout
  room.handle('h', { type: 'calibrateStart' });
  await sleep(120);
  assert.equal(room.calibration.error, 'mic-timeout');
  // playback blocks start
  room.addTrack({ id: 't', name: 't', sizeBytes: 1 });
  for (const id of ['h', 'a', 'b']) room.handle(id, { type: 'ready', trackId: 't' });
  room.handle('h', { type: 'play' });
  room.handle('h', { type: 'calibrateStart' });
  assert.notEqual(room.calibration.status, 'running');
  room.handle('h', { type: 'pause' });
  // host measurement failed -> median reference; huge delay clamped; low confidence leaves trim alone
  room.handle('a', { type: 'setTrimSelf', ms: 55 });
  room.handle('h', { type: 'calibrateStart' });
  const runId = room.calibration.runId;
  room.handle('h', { type: 'calibrateReady', runId });
  room.handle('h', { type: 'play' }); // refused while calibrating
  assert.notEqual(room.playback.status, 'scheduled');
  await sleep(180);
  room.handle('h', { type: 'calibrationResult', runId, results: {
    h: { delayMs: 0, score: 0, error: 'low-confidence' }, a: { delayMs: 3000, score: 50 }, b: { delayMs: 0, score: 40 } } });
  assert.equal(room.calibration.status, 'done');
  assert.equal(room.devices.get('h').trimMs, 0);
  assert.equal(room.devices.get('a').trimMs, 1500); // median(3000,0)=1500 -> 1500
  assert.equal(room.devices.get('b').trimMs, -1500);
  assert.equal(room.calibration.results.h.error, 'low-confidence');
  // all fail
  room.handle('h', { type: 'calibrateStart' });
  const r2 = room.calibration.runId;
  room.handle('h', { type: 'calibrateReady', runId: r2 });
  await sleep(180);
  room.handle('h', { type: 'calibrationResult', runId: r2, results: {} });
  assert.equal(room.calibration.error, 'low-confidence');
  // host result timeout
  room.handle('h', { type: 'calibrateStart' });
  room.handle('h', { type: 'calibrateReady', runId: room.calibration.runId });
  await sleep(300);
  assert.equal(room.calibration.error, 'result-timeout');
  room.destroy();
});

test('calibration: disconnected target is skipped; host leaving aborts', async () => {
  const { room, mk } = setup();
  const h = mk('h', room.hostToken); mk('a'); const b = mk('b');
  room.handle('h', { type: 'calibrateStart' });
  const runId = room.calibration.runId;
  room.disconnect('a', room.conns.get('a'));
  room.handle('h', { type: 'calibrateReady', runId });
  await sleep(120);
  assert.deepEqual(b.steps().map((m) => m.deviceId), ['h', 'b']);
  assert.equal(room.calibration.results.a.error, 'disconnected');
  room.disconnect('h', room.conns.get('h'));
  assert.equal(room.calibration.error, 'host-left');
  room.destroy();
});
