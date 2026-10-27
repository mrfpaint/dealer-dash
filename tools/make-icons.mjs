// Renders icon-192.png and icon-512.png (same pin design as icon.svg)
// with no dependencies. Run:  node tools/make-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const RED = [200, 16, 46], WHITE = [255, 255, 255];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (const b of buf) {
    c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// Colour of a point in the 100x100 design space (full-bleed red so it also works as maskable).
function colour(x, y) {
  const inHole = (x - 50) ** 2 + (y - 42) ** 2 <= 9 ** 2;
  const inHead = (x - 50) ** 2 + (y - 42) ** 2 <= 22 ** 2;
  // Tail: triangle from (33,52)-(67,52) down to (50,82)
  const inTail = y >= 52 && y <= 82 && Math.abs(x - 50) <= 17 * (82 - y) / 30;
  return !inHole && (inHead || inTail) ? WHITE : RED;
}

function png(size) {
  const ss = 4; // supersampling for smooth edges
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let py = 0; py < size; py++) {
    raw[py * (size * 3 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const c = colour(((px + (sx + .5) / ss) / size) * 100, ((py + (sy + .5) / ss) / size) * 100);
        acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2];
      }
      const o = py * (size * 3 + 1) + 1 + px * 3;
      for (let i = 0; i < 3; i++) raw[o + i] = Math.round(acc[i] / (ss * ss));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const s of [192, 512]) writeFileSync(new URL(`../icon-${s}.png`, import.meta.url), png(s));
console.log('icons written');
