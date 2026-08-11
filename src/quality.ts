/**
 * The quality gate: how much error a lossy candidate may carry before it is
 * thrown away.
 *
 * Picking the smallest file is not the same as picking the smallest file that
 * still looks right. Every lossy candidate is decoded again and compared to the
 * source pixel for pixel, and anything past the gate is discarded — so which
 * quality a given asset ships at is measured rather than assumed.
 */

import { decodePng, type Pixels } from "./png.ts";

export type { Pixels } from "./png.ts";

export interface Gate {
  /** Reject a candidate whose root-mean-square error over premultiplied RGBA
   *  exceeds this many 8-bit levels. */
  rmse: number;
  /** ...and whose worst 0.1% of pixels shift by more than this. Catches banding
   *  concentrated in one small gradient that RMSE alone would average away. */
  p999: number;
}

/**
 * The strict gate. At 2.0 a 256-colour palette is still admitted and
 * posterisation on a gradient is not, which is the right setting for flat art,
 * screenshots, and logos.
 *
 * It is not the default, and the reason is worth knowing before you reach for
 * it. Photographs do not behave like flat art: on a photographic collage every
 * lossy WebP fails this gate — q92 measures around rmse 3.5 and p99.9 40, and
 * the error barely moves down to q65, because it is spread thinly across
 * high-frequency texture rather than concentrated anywhere the eye lands.
 * Refusing all of them means shipping lossless, which costs roughly 5× the
 * bytes for a difference nobody can see at 1:1.
 */
export const STRICT_GATE: Gate = { rmse: 2, p999: 24 };

/**
 * The default gate, verified by eye on photographic artwork at 1:1 with the
 * difference amplified 4×. It admits q82 on a photograph and nothing below it,
 * and it still refuses hard-edged lettering, which spikes the percentile even
 * at q92.
 */
export const DEFAULT_GATE: Gate = { rmse: 4, p999: 44 };

export interface Difference {
  rmse: number;
  p999: number;
}

/**
 * Decode guard. A tiny file claiming a huge canvas should fail the build, not
 * allocate gigabytes inside a bundler plugin. The check runs on the header,
 * before any pixel buffer exists.
 */
export const MAX_PIXELS = 64 * 1024 * 1024;

/** Every decode goes through here, so the guard cannot be forgotten. */
export function image(bytes: Uint8Array): Bun.Image {
  return new Bun.Image(bytes, { autoOrient: true, maxPixels: MAX_PIXELS });
}

/**
 * Decode any format `Bun.Image` reads into comparable RGBA, optionally
 * resampled to `width` first. Returns null when the bytes decode to something
 * this cannot read, which makes the caller refuse the candidate.
 */
export async function toPixels(bytes: Uint8Array, width?: number): Promise<Pixels | null> {
  const pipeline = image(bytes);
  if (width) pipeline.resize(width);
  return decodePng(await pipeline.png({ compressionLevel: 1 }).bytes());
}

/**
 * RMSE and 99.9th-percentile channel error over alpha-premultiplied RGBA, so
 * colour drift hidden under transparency is not counted as visible damage.
 *
 * Returns null when the two pictures are different sizes, which is not a
 * measurement but a mistake upstream.
 */
export function compare(a: Pixels, b: Pixels): Difference | null {
  if (a.width !== b.width || a.height !== b.height) return null;
  const pixels = a.width * a.height;
  const histogram = new Uint32Array(256);
  let sumSquared = 0;

  for (let i = 0; i < pixels; i++) {
    const at = i * 4;
    const alphaA = a.data[at + 3]! / 255;
    const alphaB = b.data[at + 3]! / 255;
    for (let channel = 0; channel < 3; channel++) {
      const difference = a.data[at + channel]! * alphaA - b.data[at + channel]! * alphaB;
      sumSquared += difference * difference;
      histogram[Math.min(255, Math.round(Math.abs(difference)))]!++;
    }
    const alpha = a.data[at + 3]! - b.data[at + 3]!;
    sumSquared += alpha * alpha;
    histogram[Math.min(255, Math.abs(alpha))]!++;
  }

  const samples = pixels * 4;
  let seen = 0;
  let p999 = 0;
  for (let value = 255; value >= 0; value--) {
    seen += histogram[value]!;
    if (seen >= samples * 0.001) {
      p999 = value;
      break;
    }
  }
  return { rmse: Math.sqrt(sumSquared / samples), p999 };
}

/** True when a measured difference is inside the gate. */
export function withinGate(difference: Difference, gate: Gate): boolean {
  return difference.rmse <= gate.rmse && difference.p999 <= gate.p999;
}

/** A measured difference, for the verbose log. */
export function describe(difference: Difference): string {
  return `rmse ${difference.rmse.toFixed(2)}, p99.9 ${difference.p999}`;
}
