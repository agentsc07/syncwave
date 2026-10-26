// Client for the Demucs separator service (separator/app.py): upload, poll, download 4 stems.
// Results are cached on disk by SHA-256 of the track bytes, so repeats are instant.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { STEMS } from './orchestra.js';

const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  t.unref?.();
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('server shutting down')); }, { once: true });
});

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

export function createSeparator({
  url = '', token = '', cacheDir, fetchImpl = globalThis.fetch,
  pollMs = 2000, maxWaitMs = 30 * 60_000, requestTimeoutMs = 120_000, maxCacheEntries = 20,
} = {}) {
  const base = String(url || '').trim().replace(/\/+$/, '');
  const enabled = !!base;
  const inflight = new Map(); // sha -> Promise<{dir,names}>
  const listeners = new Map(); // sha -> Set<progress callbacks>
  const pinned = new Set(); // dirs currently exposed to rooms are never evicted
  const ac = new AbortController();
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const req = (u, init = {}) => fetchImpl(u, { ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.any([ac.signal, AbortSignal.timeout(requestTimeoutMs)]) });

  const cached = (sha) => {
    const dir = path.join(cacheDir, sha);
    return fs.existsSync(path.join(dir, 'DONE')) && STEMS.every((s) => fs.existsSync(path.join(dir, `${s}.mp3`))) ? dir : null;
  };

  function stemUrl(rel) {
    const u = new URL(rel, base + '/');
    if (u.origin !== new URL(base).origin) throw new Error('separator returned a stem URL on a different host');
    // relative URLs are "/jobs/..." ; keep any path prefix of SEPARATOR_URL
    return /^https?:/i.test(rel) ? u.href : base + (rel.startsWith('/') ? rel : '/' + rel);
  }

  async function failText(res, what) {
    if (res.status === 401 || res.status === 403) return `separator rejected the token (${res.status})`;
    let detail = '';
    try { const j = await res.json(); detail = j?.detail || j?.error || ''; } catch { /* ignore */ }
    return `separator ${what} failed (${res.status}${detail ? ': ' + String(detail).slice(0, 120) : ''})`;
  }

  async function run({ file, name, onProgress }, sha) {
    // 1. upload
    let job;
    try {
      const form = new FormData();
      form.append('file', await fs.openAsBlob(file), name || 'track');
      const res = await req(`${base}/jobs`, { method: 'POST', body: form });
      if (!res.ok) throw new Error(await failText(res, 'upload'));
      job = await res.json();
    } catch (e) {
      if (e?.message?.startsWith('separator ')) throw e;
      if (ac.signal.aborted) throw e;
      throw new Error(`separator unreachable (${e?.cause?.code || e?.name || 'network error'})`);
    }
    if (!job?.jobId) throw new Error('separator returned no jobId');
    // 2. poll
    const t0 = Date.now();
    let fails = 0;
    while (job.status !== 'done') {
      if (job.status === 'error') throw new Error(`separation failed: ${String(job.error || 'unknown error').slice(0, 200)}`);
      onProgress?.(Math.min(0.9, (Number(job.progress) || 0) * 0.9));
      if (Date.now() - t0 > maxWaitMs) throw new Error('separation timed out');
      await sleep(pollMs, ac.signal);
      try {
        const res = await req(`${base}/jobs/${encodeURIComponent(job.jobId)}`);
        if (!res.ok) {
          if (res.status === 404) throw Object.assign(new Error('separator lost the job (it may have restarted)'), { fatal: true });
          if (res.status === 401 || res.status === 403) throw Object.assign(new Error(await failText(res, 'poll')), { fatal: true });
          throw new Error(await failText(res, 'poll'));
        }
        job = await res.json();
        fails = 0;
      } catch (e) {
        if (e?.fatal || ac.signal.aborted) throw e;
        if (++fails >= 5) throw new Error('separator unreachable while waiting');
      }
    }
    // 3. download
    const tmp = path.join(cacheDir, `.tmp-${sha}-${process.pid}-${Date.now()}`);
    fs.mkdirSync(tmp, { recursive: true });
    try {
      let i = 0;
      for (const s of STEMS) {
        const rel = job.stems?.[s];
        if (!rel) throw new Error(`separator did not return the ${s} stem`);
        const res = await req(stemUrl(rel));
        if (!res.ok) throw new Error(await failText(res, `${s} download`));
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length) throw new Error(`the ${s} stem was empty`);
        fs.writeFileSync(path.join(tmp, `${s}.mp3`), buf);
        onProgress?.(0.9 + 0.1 * (++i / STEMS.length));
      }
      fs.writeFileSync(path.join(tmp, 'DONE'), 'ok');
      const dir = path.join(cacheDir, sha);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(tmp, dir);
      evict(dir);
      return { dir, names: [...STEMS] };
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
  }

  function evict(keep) {
    try {
      const dirs = fs.readdirSync(cacheDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => ({ p: path.join(cacheDir, e.name), t: fs.statSync(path.join(cacheDir, e.name)).mtimeMs }))
        .sort((a, b) => a.t - b.t);
      for (const d of dirs.slice(0, Math.max(0, dirs.length - maxCacheEntries))) if (d.p !== keep && !pinned.has(d.p)) fs.rmSync(d.p, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
  return {
    enabled,
    pin: (dir) => pinned.add(dir),
    close: () => ac.abort(),
    /** -> Promise<{dir, names, cached}>; onProgress(0..1). Concurrent calls for the same audio share one job. */
    async separate({ file, name, onProgress }) {
      if (!enabled) throw new Error('separation is not configured on this server');
      fs.mkdirSync(cacheDir, { recursive: true });
      const sha = await sha256File(file);
      const hit = cached(sha);
      if (hit) { const now = new Date(); fs.utimesSync(hit, now, now); onProgress?.(1); return { dir: hit, names: [...STEMS], cached: true }; }
      let p = inflight.get(sha);
      if (!p) {
        p = run({ file, name, onProgress: (x) => { for (const f of listeners.get(sha) ?? []) f(x); } }, sha).finally(() => { inflight.delete(sha); listeners.delete(sha); });
        inflight.set(sha, p);
      }
      if (!listeners.has(sha)) listeners.set(sha, new Set());
      listeners.get(sha).add((x) => onProgress?.(x));
      return { ...(await p), cached: false };
    },
  };
}
