// Generates icon-192.png and icon-512.png — pure Node.js, no dependencies.
// Design: garage door (3 horizontal orange panels on dark background).
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
  if (px < x1 + r && py < y1 + r) return (px - (x1 + r)) ** 2 + (py - (y1 + r)) ** 2 <= r * r;
  if (px >= x2 - r && py < y1 + r) return (px - (x2 - r)) ** 2 + (py - (y1 + r)) ** 2 <= r * r;
  if (px < x1 + r && py >= y2 - r) return (px - (x1 + r)) ** 2 + (py - (y2 - r)) ** 2 <= r * r;
  if (px >= x2 - r && py >= y2 - r) return (px - (x2 - r)) ** 2 + (py - (y2 - r)) ** 2 <= r * r;
  return true;
}

function inCircle(px, py, cx, cy, r) {
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

function generatePNG(size) {
  const s = size / 512;
  const BG  = [0x0a, 0x0e, 0x14]; // #0a0e14 dark
  const OG  = [0xff, 0x6b, 0x1a]; // #ff6b1a orange
  const MID = [0x14, 0x1a, 0x24]; // slightly lighter dark for door gap lines

  // Icon outer rounded rect (the app icon shape)
  const iconR = Math.round(96 * s);

  // Three garage door panels — equal height, slight gaps between them
  const panelX1 = Math.round(72 * s);
  const panelX2 = Math.round(440 * s);
  const panelR  = Math.round(18 * s);
  const panelH  = Math.round(90 * s);
  const gap     = Math.round(24 * s);
  const totalH  = 3 * panelH + 2 * gap;
  const startY  = Math.round((size - totalH) / 2);

  const panels = [0, 1, 2].map(i => ({
    y1: startY + i * (panelH + gap),
    y2: startY + i * (panelH + gap) + panelH,
  }));

  // Horizontal groove lines inside each panel (decorative detail)
  const grooveH = Math.max(1, Math.round(3 * s));

  const stride = 1 + size * 3;
  const raw = Buffer.alloc(size * stride);

  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x++) {
      const o = y * stride + 1 + x * 3;

      // Clip to icon shape
      if (!inRoundedRect(x, y, 0, 0, size, size, iconR)) {
        raw[o] = 0; raw[o + 1] = 0; raw[o + 2] = 0; // transparent → black (PNG bg)
        continue;
      }

      let color = BG;

      // Draw each panel
      for (const p of panels) {
        if (inRoundedRect(x, y, panelX1, p.y1, panelX2, p.y2, panelR)) {
          // Groove line across center of panel
          const mid = Math.round((p.y1 + p.y2) / 2);
          if (y >= mid - grooveH && y < mid + grooveH) {
            color = MID;
          } else {
            color = OG;
          }
          break;
        }
      }

      raw[o] = color[0]; raw[o + 1] = color[1]; raw[o + 2] = color[2];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, 'frontend');
for (const size of [192, 512]) {
  const file = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(file, generatePNG(size));
  console.log(`Generated ${file} (${size}x${size})`);
}
