// Generates icon-192.png and icon-512.png from the app's color palette.
// Pure Node.js, no dependencies — runs during Docker build.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crcBuf]);
}

function inRoundedRect(px, py, x1, y1, x2, y2, r) {
  if (px < x1 || px >= x2 || py < y1 || py >= y2) return false;
  if (px < x1 + r && py < y1 + r) return (px-(x1+r))**2 + (py-(y1+r))**2 <= r*r;
  if (px >= x2 - r && py < y1 + r) return (px-(x2-r))**2 + (py-(y1+r))**2 <= r*r;
  if (px < x1 + r && py >= y2 - r) return (px-(x1+r))**2 + (py-(y2-r))**2 <= r*r;
  if (px >= x2 - r && py >= y2 - r) return (px-(x2-r))**2 + (py-(y2-r))**2 <= r*r;
  return true;
}

function generatePNG(size) {
  const BG = [0x0a, 0x0e, 0x14]; // #0a0e14
  const OG = [0xff, 0x6b, 0x1a]; // #ff6b1a
  const s = size / 512;
  const x1 = Math.round(80 * s), y1 = Math.round(80 * s);
  const x2 = Math.round(432 * s), y2 = Math.round(432 * s);
  const rx = Math.round(48 * s);

  const stride = 1 + size * 3;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // PNG filter: None
    for (let x = 0; x < size; x++) {
      const o = y * stride + 1 + x * 3;
      const c = inRoundedRect(x, y, x1, y1, x2, y2, rx) ? OG : BG;
      raw[o] = c[0]; raw[o+1] = c[1]; raw[o+2] = c[2];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB

  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const outDir = path.join(__dirname, 'frontend');
for (const size of [192, 512]) {
  const file = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(file, generatePNG(size));
  console.log(`Generated ${file}`);
}
