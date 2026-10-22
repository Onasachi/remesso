#!/usr/bin/env node
/// Writes the brand assets from one description of the mark.
///
///   node scripts/build-brand-assets.mjs            # write them
///   node scripts/build-brand-assets.mjs --check    # fail on drift
///
/// The mark is a ring with a gap and a dot sitting in it — all circles and one
/// arc — so it is rasterised here analytically rather than by a renderer. That
/// is why this needs no dependencies: a PNG is zlib plus four chunks, and macOS
/// ships no SVG rasteriser. Hand-editing the PNGs instead would leave the icon
/// and the on-screen mark free to drift apart, which is exactly the failure a
/// brand is meant to prevent.
///
/// The wordmark is NOT exported here: it is live text (Fraunces, SOFT 100,
/// WONK 1) and rendering it would need the font and a text rasteriser. The app
/// draws it with <Wordmark/>; the design project holds the PNG exports.
import { deflateSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = process.argv.includes("--check");

/// Brand palette, hex as published in `Remesso Brand.dc.html`. Keep in step
/// with the OKLCH channels in web/app/globals.css — these are the same colours
/// written for stacks that have no oklch().
const C = {
  teal: "#008787", //  oklch(0.56 0.105 195)  actions, ring
  tealLight: "#5fc9c6", //  oklch(0.7 0.11 192)   ring on ink
  ink: "#0f2125", //  oklch(0.235 0.025 215) text, dark ground
  marigold: "#f59926", //  oklch(0.76 0.16 65)    the dot
  paper: "#f3f8f8", //  oklch(0.976 0.006 195) page ground
};

/// The mark, in its 100×100 viewBox. The ring is centred with a 72° gap, and
/// the dot sits on the ring's own circle at the middle of that gap — which is
/// why it reads as one object travelling round rather than two shapes.
const R = 35; //  ring radius
const W = 22; //  ring stroke width
const CX = 50, CY = 50;
const GAP_FROM = -81, GAP_TO = -9; //  degrees, y-down, the undrawn span
const DOT = { x: 74.75, y: 25.25, r: 14 };
const ARC = "M84.57 44.53A35 35 0 1 1 55.47 15.43";

// ---------------------------------------------------------------- SVG

/// `ring` and `dot` are any CSS colour; the one-colour version passes the same
/// value for both.
function markSvg(ring, dot = C.marigold) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <path d="${ARC}" fill="none" stroke="${ring}" stroke-width="${W}"/>
  <circle cx="${DOT.x}" cy="${DOT.y}" r="${DOT.r}" fill="${dot}"/>
</svg>
`;
}

/// The app icon: a rounded square with the mark at 60% of the side. 22% of the
/// side is the radius iOS and Android both read as "squircle-ish" without
/// looking like a circle once the OS masks it.
function iconSvg(bg, ring) {
  const S = 512, rad = S * 0.22, m = S * 0.6, o = (S - m) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">
  <rect width="${S}" height="${S}" rx="${rad}" ry="${rad}" fill="${bg}"/>
  <g transform="translate(${o} ${o}) scale(${m / 100})">
    <path d="${ARC}" fill="none" stroke="${ring}" stroke-width="${W}"/>
    <circle cx="${DOT.x}" cy="${DOT.y}" r="${DOT.r}" fill="${C.marigold}"/>
  </g>
</svg>
`;
}

// ------------------------------------------------------------ raster

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/// Coverage of the ring at a point, 0 or 1. The arc's ends are butt caps, so
/// the gap is bounded by two radial lines rather than rounded off.
function inRing(x, y) {
  const dx = x - CX, dy = y - CY;
  const d = Math.hypot(dx, dy);
  if (d < R - W / 2 || d > R + W / 2) return false;
  let a = (Math.atan2(dy, dx) * 180) / Math.PI; //  −180..180, y down
  if (a < -180) a += 360;
  return !(a > GAP_FROM && a < GAP_TO);
}

const inDot = (x, y) => Math.hypot(x - DOT.x, y - DOT.y) <= DOT.r;

/// Inside a rounded square of side `s` with corner radius `rad`.
function inRounded(x, y, s, rad) {
  const dx = Math.max(Math.abs(x - s / 2) - (s / 2 - rad), 0);
  const dy = Math.max(Math.abs(y - s / 2) - (s / 2 - rad), 0);
  return dx * dx + dy * dy <= rad * rad;
}

/// Renders the app icon at `size`, 4×4 supersampled. Returns RGBA rows.
///
/// Compositing order is tile → ring → dot, each as coverage over the one
/// before, so the dot sits on top of the ring exactly as the SVG draws it.
function renderIcon(size, bgHex, ringHex) {
  const bg = hex(bgHex), ring = hex(ringHex), dot = hex(C.marigold);
  const SS = 4, rad = size * 0.22, m = size * 0.6, off = (size - m) / 2;
  const px = Buffer.alloc(size * size * 4);

  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let cBg = 0, cRing = 0, cDot = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = pxi + (sx + 0.5) / SS;
          const y = py + (sy + 0.5) / SS;
          if (inRounded(x, y, size, rad)) cBg++;
          // Into the mark's own 100×100 space.
          const mx = ((x - off) / m) * 100;
          const my = ((y - off) / m) * 100;
          if (mx >= 0 && mx <= 100 && my >= 0 && my <= 100) {
            if (inDot(mx, my)) cDot++;
            else if (inRing(mx, my)) cRing++;
          }
        }
      }
      const n = SS * SS;
      let [r, g, b] = bg;
      let a = cBg / n;
      // `over` with the destination's own alpha held at `a`: the mark never
      // extends past the tile, so premultiplying is unnecessary here.
      const over = (src, cov) => {
        const f = cov / n;
        r = r * (1 - f) + src[0] * f;
        g = g * (1 - f) + src[1] * f;
        b = b * (1 - f) + src[2] * f;
        a = Math.max(a, f);
      };
      if (cRing) over(ring, cRing);
      if (cDot) over(dot, cDot);

      const i = (py * size + pxi) * 4;
      px[i] = Math.round(r);
      px[i + 1] = Math.round(g);
      px[i + 2] = Math.round(b);
      px[i + 3] = Math.round(a * 255);
    }
  }
  return px;
}

// --------------------------------------------------------------- PNG

const CRC_T = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_T[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/// 8-bit RGBA PNG. Every scanline uses filter 0 — the shapes are smooth and
/// zlib does the work; picking filters per line would save a few hundred bytes
/// for a lot more code.
function png(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; //  bit depth
  ihdr[9] = 6; //  colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/// An ICO carrying PNGs. Every browser since IE11 reads this; the alternative
/// is a BMP with an upside-down AND mask, which is not worth it.
function ico(images) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); //  type: icon
  head.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const dir = [];
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[4] = 1; //  colour planes
    e[6] = 32; //  bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    dir.push(e);
    offset += data.length;
  }
  return Buffer.concat([head, ...dir, ...images.map((i) => i.data)]);
}

// -------------------------------------------------------------- write

const written = [];
let drift = 0;

function emit(rel, buf) {
  const path = join(ROOT, rel);
  const body = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, "utf8");
  if (CHECK) {
    const same = existsSync(path) && readFileSync(path).equals(body);
    if (!same) {
      console.error(`drift: ${rel}`);
      drift++;
    }
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  written.push(`${rel}  ${(body.length / 1024).toFixed(1)} KB`);
}

// The mark, in every approved colourway. These are the files the brand page
// offers for download, and what anything outside this repo should use.
emit("web/public/brand/remesso-mark.svg", markSvg(C.teal));
emit("web/public/brand/remesso-mark-ink.svg", markSvg(C.ink));
emit("web/public/brand/remesso-mark-reversed.svg", markSvg(C.paper));
emit("web/public/brand/remesso-mark-mono.svg", markSvg("currentColor", "currentColor"));
emit("web/public/brand/remesso-app-icon.svg", iconSvg(C.teal, C.paper));
emit("web/public/brand/remesso-app-icon-ink.svg", iconSvg(C.ink, C.tealLight));

// What the browser and the phone home screen actually load.
emit("web/app/icon.png", png(512, renderIcon(512, C.teal, C.paper)));
emit("web/app/apple-icon.png", png(180, renderIcon(180, C.teal, C.paper)));
emit(
  "web/app/favicon.ico",
  ico([16, 32, 48].map((s) => ({ size: s, data: png(s, renderIcon(s, C.teal, C.paper)) }))),
);

if (CHECK) {
  if (drift) {
    console.error(`\n${drift} brand asset(s) differ. Run: node scripts/build-brand-assets.mjs`);
    process.exit(1);
  }
  console.log("brand assets up to date");
} else {
  console.log(written.join("\n"));
}
