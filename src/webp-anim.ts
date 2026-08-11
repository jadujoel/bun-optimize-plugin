/**
 * Reads an animated WebP back into pictures, so a lossy one can be measured
 * before it ships.
 *
 * Without this there is no gate for animation, and `libwebp_anim` merges
 * frames: it will turn 56 frames into 55, which is invisible, and 63 into 4,
 * which is a different animation. Both are smaller, so a pipeline that judges
 * by file size alone ships the second one and calls it a win.
 *
 * The way in is that **each frame of an animated WebP is a complete still WebP
 * bitstream**. An `ANMF` chunk's payload is a 16-byte header followed by the
 * ordinary `ALPH`/`VP8 `/`VP8L` chunks a single-image file is made of, so
 * wrapping one in a fresh `RIFF…WEBP` container gives `Bun.Image` something it
 * already decodes. ffmpeg is not involved and there is no new dependency.
 *
 * That still does not give the picture. Frames are sub-rectangles of the canvas
 * with their own blend and dispose rules, so a frame decoded on its own is a
 * fragment. `eachScreen` replays the animation the way a browser would and
 * hands back what is actually on screen.
 *
 * Bytes in, pixels out: no I/O anywhere in this file.
 * Container format: https://developers.google.com/speed/webp/docs/riff_container
 */

import type { Pixels } from "./png.ts";

const RIFF = 0x52494646; // "RIFF", read big-endian
const WEBP = 0x57454250; // "WEBP"

export interface AnimFrame {
  /** Offset of this frame's rectangle within the canvas. Always even. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** How long this frame stays on screen. */
  durationMs: number;
  /**
   * The spec's blending method, as the question a compositor asks: replace the
   * rectangle, or blend over what is under it. Flag bit 1 means *do not* blend,
   * which is why this is not simply the bit.
   */
  overwrite: boolean;
  /** Flag bit 0: clear this rectangle to transparent once the frame is done. */
  disposeToBackground: boolean;
  /** This frame's own picture, as a standalone WebP file ready to decode. */
  still: Uint8Array;
}

export interface Animation {
  width: number;
  height: number;
  /** 0 means forever. */
  loopCount: number;
  frames: AnimFrame[];
  durationMs: number;
}

function fourCC(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
}

/** WebP writes its sizes and offsets as 24-bit little-endian. */
function u24(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
}

function put24(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = value & 0xff;
  bytes[at + 1] = (value >> 8) & 0xff;
  bytes[at + 2] = (value >> 16) & 0xff;
}

/**
 * Parse an animated WebP. Returns null for anything that is not one — a still
 * WebP, a PNG, a truncated file — because "not an animation" is an ordinary
 * answer here and not an error.
 */
export function parseAnimation(bytes: Uint8Array): Animation | null {
  if (bytes.length < 30) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== RIFF || view.getUint32(8) !== WEBP) return null;

  let width = 0;
  let height = 0;
  let loopCount = 0;
  let sawAnim = false;
  const frames: AnimFrame[] = [];

  let at = 12;
  while (at + 8 <= bytes.length) {
    const tag = fourCC(bytes, at);
    const size = view.getUint32(at + 4, true);
    const payload = at + 8;
    // A size that runs past the end is a truncated file, not an animation.
    if (payload + size > bytes.length) return null;

    if (tag === "VP8X") {
      width = u24(bytes, payload + 4) + 1;
      height = u24(bytes, payload + 7) + 1;
    } else if (tag === "ANIM") {
      sawAnim = true;
      loopCount = view.getUint16(payload + 4, true);
    } else if (tag === "ANMF") {
      const flags = bytes[payload + 15]!;
      const frameWidth = u24(bytes, payload + 6) + 1;
      const frameHeight = u24(bytes, payload + 9) + 1;
      frames.push({
        x: u24(bytes, payload) * 2,
        y: u24(bytes, payload + 3) * 2,
        width: frameWidth,
        height: frameHeight,
        durationMs: u24(bytes, payload + 12),
        overwrite: ((flags >> 1) & 1) === 1,
        disposeToBackground: (flags & 1) === 1,
        still: standalone(bytes.subarray(payload + 16, payload + size), frameWidth, frameHeight),
      });
    }

    at = payload + size + (size & 1); // chunks are padded to an even length
  }

  if (!sawAnim || frames.length === 0 || width === 0 || height === 0) return null;
  return {
    width,
    height,
    loopCount,
    frames,
    durationMs: frames.reduce((total, frame) => total + frame.durationMs, 0),
  };
}

/**
 * Wrap a frame's own chunks in a single-image WebP file.
 *
 * The `VP8X` is written unconditionally rather than only when there is alpha:
 * it is what carries the canvas size, and a frame that is a sub-rectangle would
 * otherwise decode at the wrong size or not at all. Its alpha flag has to match
 * whether an `ALPH` chunk follows, so it is read from the payload.
 */
export function standalone(inner: Uint8Array, width: number, height: number): Uint8Array {
  const hasAlpha = inner.length >= 4 && fourCC(inner, 0) === "ALPH";

  const vp8x = new Uint8Array(18);
  vp8x.set([0x56, 0x50, 0x38, 0x58], 0); // "VP8X"
  new DataView(vp8x.buffer).setUint32(4, 10, true);
  vp8x[8] = hasAlpha ? 0x10 : 0x00;
  put24(vp8x, 12, width - 1);
  put24(vp8x, 15, height - 1);

  const body = vp8x.length + inner.length;
  const file = new Uint8Array(12 + body);
  file.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  new DataView(file.buffer).setUint32(4, 4 + body, true);
  file.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
  file.set(vp8x, 12);
  file.set(inner, 12 + vp8x.length);
  return file;
}

/** Decode one frame's standalone WebP to RGBA. Injected so the replay is pure. */
export type DecodeStill = (webp: Uint8Array) => Promise<Pixels | null>;

/**
 * Replay the animation, handing each screen to `visit` as it is reached — full
 * canvas, RGBA, in order.
 *
 * Streaming rather than returning a list, because the list is large: a 700×939
 * animation over 63 frames is 166 MB of RGBA held for no reason when the caller
 * only ever looks at one screen at a time. `visit` gets the live canvas and must
 * not keep it. The next frame is drawn into the same buffer.
 *
 * The canvas starts fully transparent. The spec has an `ANIM` background colour,
 * but browsers treat it as a hint for the area outside the canvas and start
 * transparent.
 */
export async function eachScreen(
  animation: Animation,
  decode: DecodeStill,
  visit: (index: number, screen: Pixels) => Promise<void> | void,
): Promise<void> {
  const canvas = new Uint8Array(animation.width * animation.height * 4);
  const screen: Pixels = { width: animation.width, height: animation.height, data: canvas };

  for (let index = 0; index < animation.frames.length; index++) {
    const frame = animation.frames[index]!;
    const patch = await decode(frame.still);
    if (!patch) throw new Error(`frame ${index + 1} did not decode`);
    if (patch.width !== frame.width || patch.height !== frame.height) {
      throw new Error(
        `frame ${index + 1} decoded ${patch.width}×${patch.height}, container says ${frame.width}×${frame.height}`,
      );
    }
    draw(canvas, animation.width, animation.height, patch, frame);
    await visit(index, screen);
    if (frame.disposeToBackground) clear(canvas, animation.width, animation.height, frame);
  }
}

/** Every screen of the animation, copied. `eachScreen` is what the gate uses. */
export async function composite(animation: Animation, decode: DecodeStill): Promise<Pixels[]> {
  const screens: Pixels[] = [];
  await eachScreen(animation, decode, (_, screen) => {
    screens.push({ width: screen.width, height: screen.height, data: new Uint8Array(screen.data) });
  });
  return screens;
}

/** One frame onto the canvas, honouring its blending method. */
function draw(
  canvas: Uint8Array,
  canvasWidth: number,
  canvasHeight: number,
  patch: Pixels,
  frame: AnimFrame,
): void {
  for (let row = 0; row < frame.height; row++) {
    const y = frame.y + row;
    if (y < 0 || y >= canvasHeight) continue;
    for (let column = 0; column < frame.width; column++) {
      const x = frame.x + column;
      if (x < 0 || x >= canvasWidth) continue;

      const from = (row * frame.width + column) * 4;
      const to = (y * canvasWidth + x) * 4;

      if (frame.overwrite) {
        canvas[to] = patch.data[from]!;
        canvas[to + 1] = patch.data[from + 1]!;
        canvas[to + 2] = patch.data[from + 2]!;
        canvas[to + 3] = patch.data[from + 3]!;
        continue;
      }
      blend(canvas, to, patch.data, from);
    }
  }
}

/**
 * The spec's own alpha blending, which is not the usual premultiplied form:
 *
 *   blend.A   = src.A + dst.A * (1 - src.A / 255)
 *   blend.RGB = (src.RGB * src.A + dst.RGB * dst.A * (1 - src.A / 255)) / blend.A
 *
 * A fully transparent result has no colour to carry, so it is written as zero
 * rather than left as whatever the division would have produced.
 */
function blend(dst: Uint8Array, to: number, src: Uint8Array, from: number): void {
  const srcAlpha = src[from + 3]!;
  if (srcAlpha === 255) {
    dst[to] = src[from]!;
    dst[to + 1] = src[from + 1]!;
    dst[to + 2] = src[from + 2]!;
    dst[to + 3] = 255;
    return;
  }
  if (srcAlpha === 0) return; // nothing to add

  const dstAlpha = dst[to + 3]!;
  const keep = 1 - srcAlpha / 255;
  const outAlpha = srcAlpha + dstAlpha * keep;

  if (outAlpha === 0) {
    dst[to] = 0;
    dst[to + 1] = 0;
    dst[to + 2] = 0;
    dst[to + 3] = 0;
    return;
  }

  for (let channel = 0; channel < 3; channel++) {
    dst[to + channel] = Math.round(
      (src[from + channel]! * srcAlpha + dst[to + channel]! * dstAlpha * keep) / outAlpha,
    );
  }
  dst[to + 3] = Math.round(outAlpha);
}

/** Dispose to background: the frame's rectangle goes back to transparent. */
function clear(canvas: Uint8Array, canvasWidth: number, canvasHeight: number, frame: AnimFrame): void {
  for (let row = 0; row < frame.height; row++) {
    const y = frame.y + row;
    if (y < 0 || y >= canvasHeight) continue;
    const start = (y * canvasWidth + frame.x) * 4;
    const width = Math.min(frame.width, canvasWidth - frame.x) * 4;
    if (width > 0) canvas.fill(0, start, start + width);
  }
}

/**
 * Which frame is on screen at `ms` into the first loop, or -1 past the end.
 *
 * This is what makes the gate independent of how the encoder chose to cut the
 * timeline up. Comparing frame *lists* asks the wrong question, because a merge
 * of two identical frames is invisible. Comparing what is on screen at a given
 * instant asks the right one.
 */
export function frameAtTime(animation: Animation, ms: number): number {
  if (ms < 0) return -1;
  let elapsed = 0;
  for (let index = 0; index < animation.frames.length; index++) {
    elapsed += animation.frames[index]!.durationMs;
    if (ms < elapsed) return index;
  }
  return -1;
}

/**
 * The instants to compare two timelines at: the midpoint of each source frame.
 *
 * Midpoints rather than starts, because a frame boundary is exactly where a
 * rounding millisecond decides which of two pictures is on screen, and neither
 * answer is wrong. The middle of a frame is unambiguous.
 */
export function sampleTimes(durations: readonly number[]): number[] {
  const times: number[] = [];
  let elapsed = 0;
  for (const duration of durations) {
    times.push(elapsed + duration / 2);
    elapsed += duration;
  }
  return times;
}
