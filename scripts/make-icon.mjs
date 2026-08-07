/**
 * make-icon.mjs — generates the myAIE Lecture Downloader app icon.
 *
 * Draws a rounded-square gradient badge with a white download arrow and a
 * video-play glyph, then encodes PNG (512) and ICO (256/48/32) with only
 * Node's built-in zlib — zero dependencies.
 *
 *   node scripts/make-icon.mjs   ->  build/icon.png, build/icon.ico
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SIZE = 512;

// ---------------- tiny raster helpers ----------------
function roundedRectSDF(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

function inPoly(points, px, py) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// stroke of a segment (ax,ay)-(bx,by) with half-width w
function segDist(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby)));
  const dx = px - (ax + t * abx), dy = py - (ay + t * aby);
  return Math.hypot(dx, dy);
}

function lerp(a, b, t) { return a + (b - a) * t; }

// ---------------- drawing ----------------
function samplePixel(x, y) {
  // supersampled: average 3x3
  let r = 0, g = 0, b = 0, a = 0;
  for (let dy = 0; dy < 3; dy++) {
    for (let dx = 0; dx < 3; dx++) {
      const sx = x + (dx + 0.5) / 3 - 0.5;
      const sy = y + (dy + 0.5) / 3 - 0.5;
      const c = sample(sx, sy);
      r += c[0]; g += c[1]; b += c[2]; a += c[3];
    }
  }
  const n = 9;
  return [r / n, g / n, b / n, a / n];
}

function sample(x, y) {
  // background: rounded square with diagonal indigo->violet gradient
  const d = roundedRectSDF(x, y, 256, 256, 232, 232, 104);
  let alpha = Math.min(1, Math.max(0, 0.5 - d)); // ~1px AA
  if (alpha <= 0) return [0, 0, 0, 0];
  const t = (x + y) / (SIZE * 2);
  let r = lerp(99, 139, t);   // #6366f1 -> #8b5cf6
  let g = lerp(102, 92, t);
  let b = lerp(241, 246, t);
  // top-left sheen
  const sheen = Math.max(0, 1 - Math.hypot(x - 150, y - 130) / 420);
  r = Math.min(255, r + sheen * 26);
  g = Math.min(255, g + sheen * 30);
  b = Math.min(255, b + sheen * 60);

  const WHITE = [255, 255, 255];
  // shadow under the glyph
  let shade = 0;

  // --- download arrow (thick stroke + head + tray) ---
  // shaft
  let sd = segDist(x, y, 256, 128, 256, 322);
  const shaftW = 34;
  // arrowhead triangle
  const head = [[196, 296], [256, 372], [316, 296]];
  // tray line
  const tray = segDist(x, y, 148, 414, 364, 414);
  const trayW = 30;

  let glyph = 0;
  if (sd < shaftW) glyph = 1;
  else if (inPoly(head, x, y)) glyph = 1;
  else if (tray < trayW) glyph = 1;

  // --- small play triangle (top-right) to hint "lecture video" ---
  const play = [[352, 168], [352, 232], [412, 200]];
  const isPlay = inPoly(play, x, y);

  shade = 4 * Math.max(0, 1 - Math.hypot(x - 262, y - 262) / 220);

  let cr = r, cg = g, cb = b;
  if (glyph) { cr = WHITE[0]; cg = WHITE[1]; cb = WHITE[2]; }
  if (isPlay) { cr = WHITE[0]; cg = WHITE[1]; cb = WHITE[2]; }
  return [cr, cg, cb, alpha];
}

// ---------------- PNG encoder ----------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(size, pixels) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------- render + downscale ----------------
function render(size) {
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // downsample from the 512 master
      const srcX = (x + 0.5) * (SIZE / size) - 0.5;
      const srcY = (y + 0.5) * (SIZE / size) - 0.5;
      let [r, g, b, a] = samplePixel(srcX, srcY);
      const o = (y * size + x) * 4;
      px[o] = Math.round(r);
      px[o + 1] = Math.round(g);
      px[o + 2] = Math.round(b);
      px[o + 3] = Math.round(a * 255);
    }
  }
  return px;
}

function encodeICO(sizes) {
  const pngs = sizes.map((s) => encodePNG(s, render(s)));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  for (let i = 0; i < sizes.length; i++) {
    const e = Buffer.alloc(16);
    const s = sizes[i];
    e[0] = s >= 256 ? 0 : s;
    e[1] = s >= 256 ? 0 : s;
    e[2] = 0; e[3] = 0; // palette
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(pngs[i].length, 8);
    e.writeUInt32LE(6 + 16 * pngs.length + pngs.slice(0, i).reduce((n, p) => n + p.length, 0), 12);
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs]);
}

// ---------------- main ----------------
const buildDir = path.join(process.cwd(), 'build');
fs.mkdirSync(buildDir, { recursive: true });

const png512 = encodePNG(512, render(512));
fs.writeFileSync(path.join(buildDir, 'icon.png'), png512);
fs.writeFileSync(path.join(buildDir, 'icon.ico'), encodeICO([256, 48, 32, 16]));
console.log('icon.png  ', png512.length, 'bytes');
console.log('icon.ico  ', fs.statSync(path.join(buildDir, 'icon.ico')).size, 'bytes');
