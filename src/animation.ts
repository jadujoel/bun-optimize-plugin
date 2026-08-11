/**
 * The gate for animation, which is the gate still images have always had.
 *
 * `libwebp_anim` merges frames. Some merges are invisible — two identical
 * frames become one — and some are a different animation, such as 63 frames
 * collapsing to 4. Both produce a smaller file, so a pipeline that judges by
 * size alone ships the second one.
 *
 * The candidate is therefore replayed frame by frame and compared to the source
 * **by time, not by frame index**. Each source frame's midpoint is looked up in
 * the candidate's timeline, and the two pictures at that instant are compared
 * with the same metric the still images use. A harmless merge passes. A merge
 * that holds one picture for half a second does not.
 */

import { decodePng } from "./png.ts";
import { compare, describe, toPixels, withinGate, type Difference, type Gate, type Pixels } from "./quality.ts";
import { eachScreen, frameAtTime, parseAnimation, sampleTimes } from "./webp-anim.ts";

export type Verdict = { ok: true; worst: Difference } | { ok: false; why: string };

/**
 * How far the candidate's runtime may drift from the source's, in
 * milliseconds. A GIF states its delays in hundredths of a second, so a few
 * milliseconds of rounding is ordinary and a re-timed animation is not.
 */
function runtimeTolerance(frames: number): number {
  return Math.max(50, frames);
}

/** ffmpeg writes PNG frames, so most reads never touch `Bun.Image`. */
async function readPixels(bytes: Uint8Array): Promise<Pixels | null> {
  return decodePng(bytes) ?? (await toPixels(bytes));
}

/**
 * Whether an animated WebP still looks like the animation it came from.
 *
 * `sourceFrames` are full-canvas PNGs in order and `sourceDurations` is how
 * long each stays on screen. Both come from one ffmpeg decode, so they describe
 * the same timeline the encoder was handed.
 */
export async function judgeAnimation(
  encoded: Uint8Array,
  sourceFrames: readonly string[],
  sourceDurations: readonly number[],
  gate: Gate,
): Promise<Verdict> {
  const animation = parseAnimation(encoded);
  if (!animation) return { ok: false, why: "not a readable animation" };

  if (sourceFrames.length === 0 || sourceFrames.length !== sourceDurations.length) {
    // ffmpeg's frame files and its own timeline disagree, so there is nothing
    // to sample against. Refuse rather than guess.
    return {
      ok: false,
      why: `source decoded ${sourceFrames.length} frames against ${sourceDurations.length} timings`,
    };
  }

  const sourceMs = Math.round(sourceDurations.reduce((total, ms) => total + ms, 0));
  if (Math.abs(animation.durationMs - sourceMs) > runtimeTolerance(sourceFrames.length)) {
    return { ok: false, why: `runtime ${animation.durationMs}ms against ${sourceMs}ms` };
  }

  /** Which source frames land inside each candidate frame, by index. */
  const wanted = new Map<number, number[]>();
  const times = sampleTimes(sourceDurations);
  for (let source = 0; source < times.length; source++) {
    const at = frameAtTime(animation, times[source]!);
    if (at === -1) return { ok: false, why: `nothing on screen at ${Math.round(times[source]!)}ms` };
    const list = wanted.get(at);
    if (list) list.push(source);
    else wanted.set(at, [source]);
  }

  let worst: Difference = { rmse: 0, p999: 0 };
  let failure: string | undefined;

  await eachScreen(animation, toPixels, async (index, screen) => {
    if (failure) return;
    for (const source of wanted.get(index) ?? []) {
      const expected = await readPixels(new Uint8Array(await Bun.file(sourceFrames[source]!).bytes()));
      if (!expected) {
        failure = `frame ${source + 1} of the source did not decode`;
        return;
      }
      const difference = compare(expected, screen);
      if (!difference) {
        failure =
          `frame ${source + 1} is ${expected.width}×${expected.height}, ` +
          `the canvas is ${screen.width}×${screen.height}`;
        return;
      }
      worst = {
        rmse: Math.max(worst.rmse, difference.rmse),
        p999: Math.max(worst.p999, difference.p999),
      };
      if (!withinGate(difference, gate)) {
        failure = `frame ${source + 1} ${describe(difference)}`;
        return;
      }
    }
  });

  return failure ? { ok: false, why: failure } : { ok: true, worst };
}
