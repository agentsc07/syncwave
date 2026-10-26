// Generates the PWA icons (pure node, PNG via zlib, no native deps).
// Run: node client/scripts/make-icons.mjs   (output committed in client/public/icons)
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(out, { recursive: true });

const BG = [7, 8, 12], BG2 = [19, 23, 35];
const ACC = [56, 248, 176], ACC2 = [108, 124, 255];
const BARS = [0.22, 0.52, 0.8, 0.46, 0.28]; // relative heights: the SyncWave logo
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// signed-distance-ish coverage test for a rounded rect, in unit coords
function inRound(x, y, cx, cy, hw, hh, r) {
  const dx = Math.abs(x - cx) - (hw - r), dy = Math.abs(y - cy) - (hh - r);
  const ox = Math.max(dx, 0), oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) <= r;
}

/** scale = fraction of the canvas the logo occupies; maskable = full-bleed square bg. */
function render(size, { maskable = false, scale = 0.62, rounded = true } = {}) {
  const SS = 3, px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) for (let pxx = 0; pxx < size; pxx++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const x = (pxx + (sx + 0.5) / SS) / size, y = (py + (sy + 0.5) / SS) / size;
      const inBg = maskable || !rounded || inRound(x, y, 0.5, 0.5, 0.5, 0.5, 0.22);
      if (!inBg) continue;
      let c = mix(BG2, BG, Math.min(1, y * 0.9 + x * 0.1));
      // soft indigo glow top-left like the app
      const gl = Math.max(0, 1 - Math.hypot(x - 0.3, y - 0.2) / 0.7);
      c = mix(c, ACC2, gl * 0.28);
      const n = BARS.length, gap = 0.34, bw = (scale / (n + (n - 1) * gap));
      const total = scale, x0 = 0.5 - total / 2;
      for (let i = 0; i < n; i++) {
        const cx = x0 + bw / 2 + i * bw * (1 + gap), hh = (BARS[i] * scale) / 2;
        if (inRound(x, y, cx, 0.5, bw / 2, hh, bw / 2)) { c = mix(ACC, ACC2, (x - x0) / total); break; }
      }
      r += c[0]; g += c[1]; b += c[2]; a += 1;
    }
    const k = (py * size + pxx) * 4, n = SS * SS;
    px[k] = a ? r / a : 0; px[k + 1] = a ? g / a : 0; px[k + 2] = a ? b / a : 0; px[k + 3] = Math.round((a / n) * 255);
  }
  return png(size, px);
}

const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const v of buf) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const files = {
  'icon-192.png': render(192),
  'icon-512.png': render(512),
  'icon-maskable-512.png': render(512, { maskable: true, scale: 0.5 }), // logo inside the 80% safe zone
  'apple-touch-icon.png': render(180, { maskable: true, scale: 0.56 }), // iOS applies its own rounding
  'favicon-32.png': render(32, { scale: 0.7 }),
};
for (const [n, buf] of Object.entries(files)) { writeFileSync(join(out, n), buf); console.log('wrote', n, buf.length, 'bytes'); }
