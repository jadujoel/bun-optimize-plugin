/**
 * A small PNG decoder, for the quality gate.
 *
 * `Bun.Image` has no raw-pixel terminal, so the gate compares two pictures by
 * encoding both to PNG and reading them back here. That keeps every comparison
 * in process: no image dependency, and no ffmpeg spawn per frame.
 *
 * Only the subset `Bun.Image` emits is read. Adam7 interlacing returns null
 * rather than a guess, and so does anything else this cannot decode exactly.
 * A null answer makes the gate refuse a candidate it cannot judge.
 */

import { inflateSync } from "node:zlib";

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, 8 bits per channel, not premultiplied. */
  data: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** Samples per pixel for each PNG colour type. Type 3 is one palette index. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

interface Header {
  width: number;
  height: number;
  depth: number;
  colorType: number;
  interlace: number;
}

function fourCC(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
}

/** Reverse PNG's per-scanline filters into a flat raster of `stride` bytes a row. */
function unfilter(raw: Uint8Array, height: number, bpp: number, stride: number): Uint8Array | null {
  const raster = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const type = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    for (let x = 0; x < stride; x++) {
      const encoded = raw[src + x]!;
      const a = x >= bpp ? raster[dst + x - bpp]! : 0;
      const b = y > 0 ? raster[up + x]! : 0;
      const c = y > 0 && x >= bpp ? raster[up + x - bpp]! : 0;
      let value: number;
      switch (type) {
        case 0:
          value = encoded;
          break;
        case 1:
          value = encoded + a;
          break;
        case 2:
          value = encoded + b;
          break;
        case 3:
          value = encoded + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = encoded + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          return null; // not a filter type the spec defines
      }
      raster[dst + x] = value & 0xff;
    }
  }
  return raster;
}

/** Read sample `index` of a row. Sub-byte depths are packed most significant first. */
function sampleAt(raster: Uint8Array, rowStart: number, index: number, depth: number): number {
  if (depth === 8) return raster[rowStart + index]!;
  if (depth === 16) return raster[rowStart + index * 2]!; // the high byte is the 8-bit value
  const perByte = 8 / depth;
  const byte = raster[rowStart + Math.floor(index / perByte)]!;
  const shift = 8 - depth * ((index % perByte) + 1);
  return (byte >> shift) & ((1 << depth) - 1);
}

/** Decode a PNG to RGBA, or null when this decoder cannot read it exactly. */
export function decodePng(bytes: Uint8Array): Pixels | null {
  if (bytes.length < 8) return null;
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== SIGNATURE[i]) return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let header: Header | null = null;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const parts: Uint8Array[] = [];

  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at);
    const type = fourCC(bytes, at + 4);
    const payload = at + 8;
    if (payload + length > bytes.length) return null;
    if (type === "IHDR") {
      header = {
        width: view.getUint32(payload),
        height: view.getUint32(payload + 4),
        depth: bytes[payload + 8]!,
        colorType: bytes[payload + 9]!,
        interlace: bytes[payload + 12]!,
      };
    } else if (type === "PLTE") {
      palette = bytes.subarray(payload, payload + length);
    } else if (type === "tRNS") {
      transparency = bytes.subarray(payload, payload + length);
    } else if (type === "IDAT") {
      parts.push(bytes.subarray(payload, payload + length));
    } else if (type === "IEND") {
      break;
    }
    at = payload + length + 4; // the trailing CRC is not checked
  }

  if (!header || parts.length === 0) return null;
  if (header.interlace !== 0) return null;
  const { width, height, depth, colorType } = header;
  if (width <= 0 || height <= 0) return null;
  const channels = CHANNELS[colorType];
  if (!channels) return null;
  if (colorType === 3 && !palette) return null;
  if (depth !== 1 && depth !== 2 && depth !== 4 && depth !== 8 && depth !== 16) return null;
  if (depth !== 8 && depth !== 16 && colorType !== 0 && colorType !== 3) return null;

  let total = 0;
  for (const part of parts) total += part.length;
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }

  let raw: Uint8Array;
  try {
    raw = new Uint8Array(inflateSync(joined));
  } catch {
    return null;
  }

  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  if (raw.length < (stride + 1) * height) return null;

  const raster = unfilter(raw, height, bpp, stride);
  if (!raster) return null;

  // A sub-byte or 16-bit sample is scaled to 8 bits. A palette index is not a
  // sample and is read raw, which is why type 3 never reaches `scale`.
  const maxSample = (1 << depth) - 1;
  const scale = (value: number): number =>
    depth === 16 ? value : Math.round((value * 255) / maxSample);

  // `tRNS` says which colour is fully transparent. Its 16-bit fields are read
  // as 8-bit here, so it is honoured at depth 8 and below only.
  const transparentGray =
    colorType === 0 && transparency && transparency.length >= 2 && depth <= 8
      ? ((transparency[0]! << 8) | transparency[1]!)
      : -1;
  const transparentRgb =
    colorType === 2 && transparency && transparency.length >= 6 && depth <= 8
      ? [
          (transparency[0]! << 8) | transparency[1]!,
          (transparency[2]! << 8) | transparency[3]!,
          (transparency[4]! << 8) | transparency[5]!,
        ]
      : null;

  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    for (let x = 0; x < width; x++) {
      const to = (y * width + x) * 4;
      const first = x * channels;

      if (colorType === 3) {
        const index = sampleAt(raster, rowStart, first, depth);
        const from = index * 3;
        if (from + 2 >= palette!.length) return null;
        data[to] = palette![from]!;
        data[to + 1] = palette![from + 1]!;
        data[to + 2] = palette![from + 2]!;
        data[to + 3] = transparency && index < transparency.length ? transparency[index]! : 255;
        continue;
      }

      if (colorType === 0 || colorType === 4) {
        const gray = sampleAt(raster, rowStart, first, depth);
        const value = scale(gray);
        data[to] = value;
        data[to + 1] = value;
        data[to + 2] = value;
        data[to + 3] =
          colorType === 4
            ? scale(sampleAt(raster, rowStart, first + 1, depth))
            : gray === transparentGray
              ? 0
              : 255;
        continue;
      }

      const r = sampleAt(raster, rowStart, first, depth);
      const g = sampleAt(raster, rowStart, first + 1, depth);
      const b = sampleAt(raster, rowStart, first + 2, depth);
      data[to] = scale(r);
      data[to + 1] = scale(g);
      data[to + 2] = scale(b);
      if (colorType === 6) {
        data[to + 3] = scale(sampleAt(raster, rowStart, first + 3, depth));
      } else {
        const clear = transparentRgb && r === transparentRgb[0] && g === transparentRgb[1] && b === transparentRgb[2];
        data[to + 3] = clear ? 0 : 255;
      }
    }
  }

  return { width, height, data };
}
