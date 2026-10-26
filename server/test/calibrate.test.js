// Tests client/src/lib/calibrate.ts (acoustic auto-calibration DSP) on synthetic recordings.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');

// deterministic noise
function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1; }

test('chirp matched filter recovers known delays', { skip: !fs.existsSync(tsc) && 'typescript not installed' }, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-calib-'));
  try {
    execFileSync(process.execPath, [tsc, path.join(root, 'client/src/lib/calibrate.ts'),
      '--outDir', out, '--module', 'esnext', '--moduleResolution', 'bundler', '--target', 'es2022', '--lib', 'es2022', '--skipLibCheck'], { stdio: 'pipe' });
    fs.writeFileSync(path.join(out, 'package.json'), '{"type":"module"}');
    const c = await import(pathToFileURL(path.join(out, 'calibrate.js')));

    const sr = 48000;
    const chirp = c.makeChirp(sr);
    assert.equal(chirp.length, 4800);
    assert.ok(Math.abs(chirp[0]) < 1e-3 && Math.abs(chirp[4799]) < 1e-3, 'Hann edges');

    const recStart = 100; // ctx seconds at rec[0]
    const recLen = sr * 12;
    const mix = (rec, delaySec, intendedCtx, gain) => { // add chirp at fractional sample position (linear interp)
      const pos = (intendedCtx + delaySec - recStart) * sr;
      const i0 = Math.floor(pos), fr = pos - i0;
      for (let i = 0; i < chirp.length; i++) {
        rec[i0 + i] += gain * chirp[i] * (1 - fr);
        rec[i0 + i + 1] += gain * chirp[i] * fr;
      }
    };
    const noisy = (seed, amp) => { const r = rng(seed); const rec = new Float32Array(recLen); for (let i = 0; i < recLen; i++) rec[i] = amp * r(); return rec; };

    // device A: 187.3 ms late, 3 repeats, with jitter-free timing, noise at 0.3 amplitude vs chirp peak 1 * 0.5
    const intended = [102, 103.5, 105];
    const rec = noisy(1, 0.3);
    for (const t of intended) mix(rec, 0.1873, t, 0.5);
    const a = c.measureDevice(rec, sr, recStart, chirp, intended);
    assert.ok(!a.error, JSON.stringify(a));
    assert.ok(Math.abs(a.delayMs - 187.3) < 0.5, `A delay ${a.delayMs}`);
    assert.ok(a.score > 70, `A score ${a.score}`);

    // device B: -4.2 ms (early), with a strong overlapping room echo (copy 6 ms later, 90% as loud) and a
    // second device's chirp arriving 25 ms after B's direct sound (overlapping)
    const rec2 = noisy(2, 0.2);
    for (const t of intended) {
      mix(rec2, -0.0042, t, 0.4);
      mix(rec2, -0.0042 + 0.006, t, 0.36);
      mix(rec2, 0.025, t, 0.3);
    }
    const b = c.measureDevice(rec2, sr, recStart, chirp, intended);
    assert.ok(!b.error, JSON.stringify(b));
    assert.ok(Math.abs(b.delayMs - -4.2) < 0.5, `B delay ${b.delayMs}`);

    // device C: noise only -> rejected as low confidence
    const c3 = c.measureDevice(noisy(3, 0.3), sr, recStart, chirp, intended);
    assert.equal(c3.error, 'low-confidence');
    assert.equal(c3.score, 0);

    // device D: one repeat is jittery by 6 ms and one is missing -> still recovered from 2 good ones, lower score
    const rec4 = noisy(4, 0.2);
    mix(rec4, 0.0501, intended[0], 0.5);
    mix(rec4, 0.0501, intended[1], 0.5);
    const d = c.measureDevice(rec4, sr, recStart, chirp, intended);
    assert.ok(!d.error && d.used === 2, JSON.stringify(d));
    assert.ok(Math.abs(d.delayMs - 50.1) < 0.5, `D delay ${d.delayMs}`);
    assert.ok(d.score < a.score);
    const jit = noisy(5, 0.1);
    mix(jit, 0.0500, intended[0], 0.5); mix(jit, 0.0560, intended[1], 0.5); mix(jit, 0.0500, intended[2], 0.5);
    const j = c.measureDevice(jit, sr, recStart, chirp, intended);
    assert.ok(j.jitterMs > 5 && j.score < 60, JSON.stringify(j));

    // sign convention helper
    assert.equal(c.trimFor(187.3, 0), 187.3);
    assert.ok(Math.abs(c.trimFor(-4.2, 187.3) - -191.5) < 1e-9);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
