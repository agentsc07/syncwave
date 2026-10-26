// Offline beat analysis (client/src/lib/beats.ts) on synthetic signals. Compiles the TS with the workspace tsc.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const SR = 44100;

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
}

/** kick (60 Hz decaying sine) at each time + optional hats + noise */
function synth(durSec, kicks, { noise = 0.05, hats = null, pad = true } = {}) {
  const x = new Float32Array(Math.floor(durSec * SR));
  const r = rng(7);
  for (const t of kicks) {
    const s0 = Math.floor(t * SR);
    for (let i = 0; i < 0.25 * SR && s0 + i < x.length; i++) {
      const tt = i / SR;
      x[s0 + i] += 0.9 * Math.sin(2 * Math.PI * (45 + 90 * Math.exp(-tt * 30)) * tt) * Math.exp(-tt * 14);
    }
  }
  if (hats) for (const t of hats) {
    const s0 = Math.floor(t * SR);
    for (let i = 0; i < 0.04 * SR && s0 + i < x.length; i++) x[s0 + i] += 0.25 * r() * Math.exp(-(i / SR) * 90);
  }
  for (let i = 0; i < x.length; i++) {
    x[i] += noise * r();
    if (pad) x[i] += 0.08 * Math.sin(2 * Math.PI * 220 * i / SR) + 0.05 * Math.sin(2 * Math.PI * 330.5 * i / SR);
  }
  return x;
}

test('beat analysis', { skip: !fs.existsSync(tsc) && 'typescript not installed' }, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-beats-'));
  try {
    execFileSync(process.execPath, [tsc, path.join(root, 'client/src/lib/beats.ts'), '--outDir', out, '--module', 'esnext',
      '--moduleResolution', 'bundler', '--target', 'es2022', '--lib', 'es2022,dom', '--skipLibCheck', '--strict'], { stdio: 'pipe' });
    fs.writeFileSync(path.join(out, 'package.json'), '{"type":"module"}');
    const { analyzeBeats, analyzeBeatsAsync, nextBeatIndex } = await import(pathToFileURL(path.join(out, 'beats.js')));

    // 1. 120 BPM kicks + 8th hats + noise
    const kicks = Array.from({ length: 56 }, (_, i) => 0.3 + i * 0.5);
    const hats = Array.from({ length: 56 }, (_, i) => 0.3 + 0.25 + i * 0.5);
    const x = synth(30, kicks, { hats });
    const t0 = performance.now();
    const m = analyzeBeats(x, SR);
    const ms = performance.now() - t0;
    assert.ok(m.bpm != null && Math.abs(m.bpm - 120) <= 2, 'bpm ' + m.bpm);
    let hit = 0, maxErr = 0;
    for (const k of kicks) {
      if (k > 29.5) continue;
      let best = 1e9;
      for (const t of m.times) best = Math.min(best, Math.abs(t - k));
      if (best <= 0.03) hit++;
      if (best <= 0.03) maxErr = Math.max(maxErr, best);
    }
    const expected = kicks.filter((k) => k <= 29.5).length;
    assert.ok(hit >= expected - 1, `kicks matched ${hit}/${expected}`);
    assert.ok(maxErr <= 0.02, 'max timing error ' + maxErr);
    assert.ok(m.times.length <= expected + 3, 'spurious beats: ' + m.times.length + ' vs ' + expected);
    for (let i = 1; i < m.times.length; i++) assert.ok(m.times[i] - m.times[i - 1] >= 0.2, 'min gap');
    assert.ok(m.strengths.every((s) => s >= 0 && s <= 1));
    assert.ok(m.downbeats && m.downbeats.filter(Boolean).length >= expected / 4 - 3 && m.downbeats.filter(Boolean).length <= expected / 4 + 3);
    console.log(`  120bpm: ${m.times.length} beats, bpm ${m.bpm}, max err ${(maxErr * 1000).toFixed(1)}ms, ${ms.toFixed(0)}ms for 30 s`);

    // 2. stereo input array + async version agree
    const ma = await analyzeBeatsAsync([x, x], SR);
    assert.equal(ma.times.length, m.times.length);

    // 3. 5-minute track is fast
    const long = synth(300, Array.from({ length: 560 }, (_, i) => 0.3 + i * 0.5));
    const tl = performance.now();
    const ml = analyzeBeats(long, SR);
    const dl = performance.now() - tl;
    assert.ok(dl < 1500, '5 min took ' + dl);
    assert.ok(Math.abs(ml.bpm - 120) <= 2);
    console.log(`  5 min track: ${dl.toFixed(0)}ms, ${ml.times.length} beats`);

    // 4. irregular hits are detected where they are, no grid invented
    const irr = [0.5, 1.4, 1.9, 3.2, 3.6, 5.1, 6.0, 7.7, 8.1, 9.5, 10.6, 12.0];
    const mi = analyzeBeats(synth(14, irr, { pad: false }), SR);
    let found = 0;
    for (const k of irr) if (mi.times.some((t) => Math.abs(t - k) < 0.03)) found++;
    assert.ok(found >= irr.length - 1, 'irregular found ' + found + '/' + irr.length);
    assert.ok(mi.times.length <= irr.length + 3, 'irregular extra ' + mi.times.length);

    // 5. silence / near-silence
    assert.equal(analyzeBeats(new Float32Array(SR * 10), SR).times.length, 0);
    const nz = analyzeBeats(synth(10, [], { noise: 0.02, pad: false }), SR);
    assert.equal(nz.times.length, 0);
    assert.equal(analyzeBeats(new Float32Array(0), SR).times.length, 0);

    // 6. nextBeatIndex
    assert.equal(nextBeatIndex([1, 2, 3], 0), 0);
    assert.equal(nextBeatIndex([1, 2, 3], 2), 1);
    assert.equal(nextBeatIndex([1, 2, 3], 2.01), 2);
    assert.equal(nextBeatIndex([1, 2, 3], 9), 3);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
