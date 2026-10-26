// Simulated test of the client's live-audio scheduling math (client/src/lib/livemath.ts + engine.planStart).
// Compiles the TS with the workspace's tsc into a temp dir, then imports it.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');

test('live scheduling math', { skip: !fs.existsSync(tsc) && 'typescript not installed' }, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-livemath-'));
  try {
    execFileSync(process.execPath, [tsc, path.join(root, 'client/src/lib/livemath.ts'), path.join(root, 'client/src/lib/engine.ts'),
      '--outDir', out, '--module', 'esnext', '--moduleResolution', 'bundler', '--target', 'es2022', '--lib', 'es2022,dom', '--skipLibCheck'], { stdio: 'pipe' });
    fs.writeFileSync(path.join(out, 'package.json'), '{"type":"module"}');
    // tsc emits extensionless specifiers; add .js so node can resolve them
    for (const f of fs.readdirSync(out).filter((x) => x.endsWith('.js'))) {
      const p = path.join(out, f);
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/from '(\.\/[a-z]+)'/g, "from '$1.js'"));
    }
    const lm = await import(pathToFileURL(path.join(out, 'livemath.js')));
    const { planStart } = await import(pathToFileURL(path.join(out, 'engine.js')));

    // frame round trip
    const pcm = Int16Array.from([1, -1, 32767, -32768, 5, 6]);
    const f = lm.decodeFrame(lm.encodeFrame({ channels: 2, frames: 3, seq: 7, captureServerTime: 1234567.25, sampleRate: 48000, pcm }));
    assert.deepEqual([f.channels, f.frames, f.seq, f.captureServerTime, f.sampleRate], [2, 3, 7, 1234567.25, 48000]);
    assert.deepEqual([...f.pcm], [...pcm]);
    assert.equal(lm.decodeFrame(new ArrayBuffer(5)), null);

    // chunker: 128-frame blocks -> exactly 20 ms (960 @ 48k) chunks, contiguous timestamps
    const chunks = [];
    const ch = new lm.Chunker(48000, 2, 20, (c) => chunks.push(c));
    for (let b = 0; b < 30; b++) ch.push([new Float32Array(128).fill(0.5), new Float32Array(128).fill(-0.5)], 10 + (b * 128) / 48000);
    assert.equal(chunks.length, 4); // 3840 samples / 960
    assert.equal(chunks[0].frames, 960);
    assert.ok(Math.abs(chunks[1].ctxStart - chunks[0].ctxStart - 0.02) < 1e-9);
    assert.equal(chunks[0].pcm[0], 16383.5 | 0);
    assert.equal(chunks[0].pcm[1], -16384);

    // chunk time -> ctx time. ctx clock is 100 s; server clock is 5000000 ms. buffer 1500.
    const env = (ctxNow, serverNow, extra = {}) => ({ ctxNow, serverNow, outputLatencyMs: 20, trimMs: 10, bufferMs: 1500, ...extra });
    const sched = new lm.LiveScheduler(planStart);
    const chunk = (seq, cap) => ({ seq, captureServerTime: cap, frames: 960, sampleRate: 48000 });
    // captured at server 5000000, now is 5000030 -> plays at 5001500 = 1470 ms from now, minus 20 latency, minus 10 trim
    let r = sched.schedule(chunk(0, 5000000), env(100, 5000030));
    assert.equal(r.action, 'play');
    assert.ok(Math.abs(r.when - (100 + 1.470 - 0.020 - 0.010)) < 1e-9, String(r.when));
    assert.equal(r.offsetSec, 0);
    // next chunk captured 20 ms later arrives with a little timing jitter: snapped seamlessly to previous chunk end
    r = sched.schedule(chunk(1, 5000020.0), env(100.02, 5000052.5));
    assert.ok(Math.abs(r.when - (100 + 1.440 + 0.020)) < 1e-9, String(r.when));
    // gap: seq 2 and 3 lost, seq 4 -> counted, scheduled at its own time leaving silence
    r = sched.schedule(chunk(4, 5000080), env(100.1, 5000120));
    assert.equal(sched.stats.gaps, 2);
    assert.ok(Math.abs(r.when - (100.1 + (5001580 - 5000120) / 1000 - 0.03)) < 1e-9);
    // duplicate / out of order dropped
    assert.deepEqual(sched.schedule(chunk(3, 5000060), env(100.1, 5000120)), { action: 'drop', reason: 'dup' });
    // entirely late chunk (arrives after its play time + duration) dropped
    r = sched.schedule(chunk(5, 5000100), env(103, 5001700));
    assert.deepEqual(r, { action: 'drop', reason: 'late' });
    // starts 20 ms from now but the start lead is 30 ms: played with the first 10 ms trimmed
    const s2 = new lm.LiveScheduler(planStart);
    r = s2.schedule(chunk(0, 5000000), env(100, 5001500 - 20, { outputLatencyMs: 0, trimMs: 0 }));
    assert.equal(r.action, 'play');
    assert.ok(Math.abs(r.offsetSec - 0.01) < 1e-9, String(r.offsetSec));
    // lowering the buffer on the fly makes older chunks late, raising it keeps them on time
    const s3 = new lm.LiveScheduler(planStart);
    assert.equal(s3.schedule(chunk(0, 5000000), env(100, 5001000, { bufferMs: 800 })).action, 'drop');
    assert.equal(s3.schedule(chunk(1, 5000020), env(100, 5001000, { bufferMs: 3000 })).action, 'play');
    assert.equal(lm.clampBuffer('share', 10), 800);
    assert.equal(lm.clampBuffer('announce', 99999), 1000);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
