// Demo library: server/demo/<slug>/{vocals,drums,bass,other}.mp3 + manifest.json (make_demo_stems.py output).
import fs from 'node:fs';
import path from 'node:path';
import { STEMS } from './orchestra.js';

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

/** Returns {slug,title,durationSec,sizeBytes,dir} or null if the folder is not a complete demo. */
export function readDemo(demoDir, slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return null;
  const dir = path.join(demoDir, slug);
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    let sizeBytes = 0;
    for (const s of STEMS) sizeBytes += fs.statSync(path.join(dir, `${s}.mp3`)).size;
    const durationSec = Number(manifest.durationSec);
    return {
      slug,
      title: String(manifest.title || slug).slice(0, 120),
      durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null,
      sizeBytes,
      dir,
    };
  } catch {
    return null;
  }
}

export function listDemos(demoDir) {
  let names = [];
  try { names = fs.readdirSync(demoDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { /* no demo dir */ }
  return names.map((n) => readDemo(demoDir, n)).filter(Boolean).map(({ dir, ...pub }) => pub);
}
