// Tests for client/src/lib/orchestra.ts (pure helpers) and the engine's multi-stem scheduling,
// using a fake AudioContext. Compiles the TS with the workspace's tsc, like live-math.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { autoAssign as serverAutoAssign } from '../src/orchestra.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');

async function build() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-orch-'));
  execFileSync(process.execPath, [tsc, path.join(root, 'client/src/lib/orchestra.ts'), path.join(root, 'client/src/lib/engine.ts'),
    '--outDir', out, '--module', 'esnext', '--moduleResolution', 'bundler', '--target', 'es2022', '--lib', 'es2022,dom', '--skipLibCheck'], { stdio: 'pipe' });
  fs.writeFileSync(path.join(out, 'package.json'), '{"type":"module"}');
  for (const f of fs.readdirSync(out).filter((x) => x.endsWith('.js'))) {
    const p = path.join(out, f);
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/from '(\.\/[a-z]+)'/g, "from '$1.js'"));
  }
  return { out, orch: await import(pathToFileURL(path.join(out, 'orchestra.js'))), eng: await import(pathToFileURL(path.join(out, 'engine.js'))) };
}

test('client orchestra helpers', { skip: !fs.existsSync(tsc) && 'typescript not installed' }, async () => {
  const { out, orch } = await build();
  try {
    // client autoAssign == server autoAssign for every size and random layouts
    for (let n = 0; n <= 9; n++) {
      const devs = Array.from({ length: n }, (_, i) => ({ id: 'd' + i, x: Math.round(Math.random() * 4) / 4, order: i }));
      assert.deepEqual([...orch.autoAssign(devs)], [...serverAutoAssign(devs)]);
    }
    const A = { enabled: true }, ready = { stems: { status: 'ready', progress: 1, names: [] } };
    // wantedSources: fallbacks
    assert.deepEqual(orch.wantedSources(ready, A, ['drums', 'bass']), ['drums', 'bass']);
    assert.deepEqual(orch.wantedSources(ready, A, null), ['mix']);
    assert.deepEqual(orch.wantedSources(ready, { enabled: false }, ['drums']), ['mix']);
    assert.deepEqual(orch.wantedSources({ stems: { status: 'separating', progress: 0.5, names: [] } }, A, ['drums']), ['mix']);
    assert.deepEqual(orch.wantedSources(undefined, A, ['drums']), ['mix']);
    // demo tracks: no mix file, "full mix" = all four stems
    const demo = { stemsOnly: true, ...ready };
    assert.deepEqual(orch.wantedSources(demo, { enabled: false }, ['drums']), ['vocals', 'drums', 'bass', 'other']);
    assert.deepEqual(orch.wantedSources(demo, A, null), ['vocals', 'drums', 'bass', 'other']);
    assert.deepEqual(orch.wantedSources(demo, A, ['bass', 'vocals']), ['vocals', 'bass']);
    assert.deepEqual(orch.stemsToLoad(ready, A, ['other']), ['other']);
    assert.deepEqual(orch.stemsToLoad(ready, { enabled: false }, ['other']), []);
    // diff
    assert.deepEqual(orch.diffSources(['vocals', 'drums'], ['drums', 'bass']), { add: ['bass'], remove: ['vocals'], keep: ['drums'] });
    assert.deepEqual(orch.diffSources(['mix'], ['vocals', 'other']), { add: ['vocals', 'other'], remove: ['mix'], keep: [] });
    // chips
    assert.equal(orch.stemLabel(null), 'Full mix');
    assert.equal(orch.stemLabel(['other', 'vocals']), 'Vocals + Other');
    assert.deepEqual(orch.toggleStem(null, 'bass'), ['bass']);
    assert.deepEqual(orch.toggleStem(['bass', 'vocals'], 'bass'), ['vocals']);
    assert.equal(orch.toggleStem(['bass'], 'bass'), null);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

// ---- engine with a fake AudioContext ----
function installFakeAudio() {
  const node = () => ({ connect(n) { return n; }, disconnect() {}, gain: { value: 1, setTargetAtTime() {}, setValueAtTime() {} }, frequency: { value: 0 }, addEventListener() {} });
  class Ctx {
    constructor() {
      this.currentTime = 100; this.state = 'running'; this.sampleRate = 48000; this.baseLatency = 0; this.destination = node(); this.sources = [];
    }
    createGain() { return node(); }
    createChannelSplitter() { return node(); }
    createChannelMerger() { return node(); }
    createBiquadFilter() { return node(); }
    createAnalyser() { return { ...node(), frequencyBinCount: 512, fftSize: 1024, getByteFrequencyData() {} }; }
    createBuffer() { return { duration: 1 }; }
    createBufferSource() {
      const s = { ...node(), buffer: null, started: null, stopped: null, playbackRate: { value: 1, calls: [], setValueAtTime(v, t) { this.value = v; this.calls.push([v, t]); } }, start(when, offset) { s.started = { when, offsetSec: offset }; }, stop(when) { s.stopped = when ?? s.ctx.currentTime; } };
      s.ctx = this; this.sources.push(s);
      return s;
    }
    decodeAudioData(buf) { return Promise.resolve({ duration: 60, tag: Buffer.from(buf).toString() }); }
    resume() { return Promise.resolve(); }
    suspend() { return Promise.resolve(); }
    addEventListener() {}
  }
  globalThis.AudioContext = Ctx;
  globalThis.fetch = async (url) => ({ ok: true, arrayBuffer: async () => Buffer.from(String(url)) });
}

test('engine plays assigned stems on one shared timeline and swaps them without a restart', { skip: !fs.existsSync(tsc) && 'typescript not installed' }, async () => {
  const { out, eng } = await build();
  installFakeAudio();
  let serverNow = 10_000;
  const E = new eng.AudioEngine(() => serverNow);
  try {
    const ctx = E.ctx;
    const mk = (stems, extra = {}) => ({
      roomId: 'R', serverTime: serverNow, hostId: 'me', volume: 1, lights: false, live: null, queue: [],
      devices: [{ id: 'me', stems, trimMs: 0, channel: 'stereo' }],
      tracks: [{ id: 'T', name: 't', sizeBytes: 1, votes: 0, stems: { status: 'ready', progress: 1, names: [] } }],
      orchestra: { enabled: true, mode: 'auto', stemVolumes: { vocals: 1, drums: 0.5, bass: 1, other: 1 } },
      playback: { status: 'playing', trackId: 'T', startServerTime: 9_000, pausedPositionMs: 0, ...extra },
    });
    const self = (st) => st.devices[0];
    await E.load('/media/T', 'T');
    await E.loadStem('/media/T/vocals', 'T', 'vocals');
    await E.loadStem('/media/T/drums', 'T', 'drums');
    assert.deepEqual(E.loadedStems('T'), ['vocals', 'drums']);

    // late join 1 s into the song with vocals+drums: two sources, same instant, same offset
    let st = mk(['vocals', 'drums']);
    E.applyState(st, self(st));
    const live = ctx.sources.filter((s) => s.started);
    assert.equal(live.length, 2);
    assert.equal(live[0].started.when, live[1].started.when);
    assert.equal(live[0].started.offsetSec, live[1].started.offsetSec);
    assert.ok(Math.abs(live[0].started.offsetSec - 1.03) < 0.01, String(live[0].started.offsetSec));

    // idempotent
    E.applyState(st, self(st));
    assert.equal(ctx.sources.filter((s) => s.started).length, 2);

    // a rate nudge (simulated drift) applies to every stem together
    ctx.currentTime += 2; serverNow += 2000;
    E.srcs.get('vocals'); // private fields are reachable in JS
    E.serverNow = () => serverNow + 3; // we are now 3 ms off -> nudge
    E.driftTick();
    assert.deepEqual(live.map((s) => s.playbackRate.calls.length), [1, 1]);
    assert.equal(live[0].playbackRate.value, live[1].playbackRate.value);
    assert.notEqual(live[0].playbackRate.value, 1);
    E.serverNow = () => serverNow;

    // reassign vocals+drums -> drums+bass: drums keeps running; vocals stops and bass starts at the same instant
    await E.loadStem('/media/T/bass', 'T', 'bass');
    ctx.currentTime += 1; serverNow += 1000;
    const drums = live[1];
    st = mk(['drums', 'bass']);
    E.applyState(st, self(st));
    const all = ctx.sources.filter((s) => s.started);
    assert.equal(all.length, 3, 'only one new source (bass)');
    assert.equal(drums.stopped, null, 'kept stem was not touched');
    const bass = all[2];
    assert.ok(live[0].stopped != null);
    assert.equal(live[0].stopped, bass.started.when, 'stop and start at the same instant');
    assert.equal(bass.playbackRate.value, drums.playbackRate.value, 'new stem inherits the nudged rate');
    // bass starts where the drums are on the shared timeline: drums position at `when` = start offset + elapsed * rate (+ the nudge, tiny)
    const expected = drums.started.offsetSec + (drums.playbackRate.calls[0][1] - drums.started.when) + (bass.started.when - drums.playbackRate.calls[0][1]) * drums.playbackRate.value;
    assert.ok(Math.abs(bass.started.offsetSec - expected) < 0.005, `${bass.started.offsetSec} vs ${expected}`);

    // assigned stem not decoded yet: keep playing the old set (no gap, no restart)
    st = mk(['other']);
    const before = ctx.sources.length;
    E.applyState(st, self(st));
    assert.equal(ctx.sources.length, before);
    assert.equal(drums.stopped, null);

    // orchestra off -> back to the full mix, on the same timeline
    st = mk(['other']); st.orchestra.enabled = false;
    E.applyState(st, self(st));
    const mix = ctx.sources.filter((s) => s.started).at(-1);
    assert.ok(drums.stopped != null && mix.started);
    assert.ok(Math.abs(mix.started.offsetSec - bass.started.offsetSec) < 0.005, "same instant, same timeline position");

    // pause stops everything
    st = mk(['other'], { status: 'paused', startServerTime: null, pausedPositionMs: 4000 });
    E.applyState(st, self(st));
    assert.ok(ctx.sources.filter((s) => s.started).every((s) => s.stopped != null));
  } finally { E.dispose(); fs.rmSync(out, { recursive: true, force: true }); }
});
