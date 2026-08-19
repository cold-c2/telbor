// Generates build/icon.ico — a 64x64 pixel-art icon (pale wanderer on a dark field).
// Pure Node, no deps: writes a 32bpp BMP-based .ico by hand.
import fs from "fs";

const W = 256, H = 256;                        // electron-builder requires >= 256
function px(px_, py_) {
  const x = px_ >> 2, y = py_ >> 2;            // design in a crisp 64-grid, scaled 4x to 256
  let r = 11, g = 15, b = 26;                 // dark night-blue field
  const inb = (x0, x1, y0, y1) => x >= x0 && x < x1 && y >= y0 && y < y1;
  const pale = () => { r = 222; g = 222; b = 224; };
  // pale figure silhouette
  if (inb(29, 36, 9, 17)) pale();                          // head
  else if (inb(26, 39, 17, 41)) pale();                   // torso
  else if (inb(28, 31, 41, 55) || inb(34, 37, 41, 55)) pale();  // legs
  else if (inb(22, 26, 20, 38) || inb(39, 43, 20, 38)) pale();  // arms holding rifle
  // rifle across the arms
  if (inb(20, 45, 27, 30)) { r = 42; g = 42; b = 46; }
  // red glyph scrawl along the bottom
  if (inb(8, 56, 57, 60) && ((x * 3 + y) % 7 < 2)) { r = 139; g = 15; b = 15; }
  return [r, g, b, 255];
}

const hdr = Buffer.alloc(6);
hdr.writeUInt16LE(0, 0); hdr.writeUInt16LE(1, 2); hdr.writeUInt16LE(1, 4);
const andRow = Math.ceil(W / 32) * 4;
const imgSize = 40 + W * H * 4 + andRow * H;
const ent = Buffer.alloc(16);
const wb = W >= 256 ? 0 : W, hb = H >= 256 ? 0 : H;   // 0 means 256 in the ICO spec
ent.writeUInt8(wb, 0); ent.writeUInt8(hb, 1); ent.writeUInt8(0, 2); ent.writeUInt8(0, 3);
ent.writeUInt16LE(1, 4); ent.writeUInt16LE(32, 6); ent.writeUInt32LE(imgSize, 8); ent.writeUInt32LE(22, 12);
const bih = Buffer.alloc(40);
bih.writeUInt32LE(40, 0); bih.writeInt32LE(W, 4); bih.writeInt32LE(H * 2, 8);
bih.writeUInt16LE(1, 12); bih.writeUInt16LE(32, 14);
const pix = Buffer.alloc(W * H * 4);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const [r, g, b, a] = px(x, y);
  const o = ((H - 1 - y) * W + x) * 4;         // BMP is bottom-up, BGRA
  pix[o] = b; pix[o + 1] = g; pix[o + 2] = r; pix[o + 3] = a;
}
const andMask = Buffer.alloc(andRow * H, 0);
fs.mkdirSync("build", { recursive: true });
fs.writeFileSync("build/icon.ico", Buffer.concat([hdr, ent, bih, pix, andMask]));
console.log("wrote build/icon.ico (" + (imgSize + 22) + " bytes)");
