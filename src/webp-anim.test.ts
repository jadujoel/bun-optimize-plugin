import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ffmpeg } from "./ffmpeg.ts";
import type { Pixels } from "./png.ts";
import { toPixels } from "./quality.ts";
import {
  composite,
  frameAtTime,
  parseAnimation,
  sampleTimes,
  standalone,
  type AnimFrame,
  type Animation,
} from "./webp-anim.ts";

const ASSETS = join(import.meta.dir, "..", "example", "assets");
const SCRATCH = join(import.meta.dir, "..", "node_modules", ".cache", "webp-anim-test");
await mkdir(SCRATCH, { recursive: true });

afterAll(async () => {
  await rm(SCRATCH, { recursive: true, force: true });
});

/** Encode one of the example animations and hand back the bytes. */
async function encode(name: string, args: string[]): Promise<Uint8Array> {
  const output = join(SCRATCH, `${name}-${args.join("")}.webp`.replaceAll(/[^a-z0-9.-]/gi, ""));
  const { ok, stderr } = await ffmpeg([
    ...["-y", "-i", join(ASSETS, name), "-c:v", "libwebp_anim", "-loop", "0", "-pix_fmt", "bgra"],
    ...args,
    ...["-f", "webp", output],
  ]);
  if (!ok) throw new Error(stderr.split("\n").slice(-4).join("\n"));
  return new Uint8Array(await Bun.file(output).arrayBuffer());
}

describe("parseAnimation", () => {
  test("an apng of ten frames encodes to ten frames of 100ms", async () => {
    const animation = parseAnimation(await encode("sample.apng", ["-lossless", "1"]))!;
    expect(animation.frames).toHaveLength(10);
    expect(animation.durationMs).toBe(1000);
    expect(animation.frames.map(frame => frame.durationMs)).toEqual(Array(10).fill(100));
    expect(animation.width).toBe(128);
    expect(animation.height).toBe(128);
  });

  test("every frame is a standalone webp that decodes on its own", async () => {
    const animation = parseAnimation(await encode("sample.gif", ["-lossless", "1"]))!;
    expect(animation.frames).toHaveLength(2);
    for (const frame of animation.frames) {
      const pixels = await toPixels(frame.still);
      expect(pixels).not.toBeNull();
      expect(pixels!.width).toBe(frame.width);
      expect(pixels!.height).toBe(frame.height);
    }
  });

  test.each([
    ["a still webp", "sample.webp"],
    ["a png", "sample.png"],
  ])("%s is not an animation", async (_label, name) => {
    const bytes = new Uint8Array(await Bun.file(join(ASSETS, name)).arrayBuffer());
    expect(parseAnimation(bytes)).toBeNull();
  });

  test("a truncated animation is refused, not half read", async () => {
    const bytes = await encode("sample.apng", ["-lossless", "1"]);
    expect(parseAnimation(bytes.subarray(0, bytes.length - 100))).toBeNull();
  });
});

describe("standalone", () => {
  test("wraps a frame in a RIFF container that states the frame's size", () => {
    const inner = Uint8Array.of(0x56, 0x50, 0x38, 0x20, 1, 0, 0, 0, 9); // "VP8 " and a byte
    const file = standalone(inner, 321, 240);
    expect(String.fromCharCode(...file.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...file.subarray(8, 12))).toBe("WEBP");
    expect(String.fromCharCode(...file.subarray(12, 16))).toBe("VP8X");
    expect(file[24]! | (file[25]! << 8) | (file[26]! << 16)).toBe(320); // width - 1
    expect(file[27]! | (file[28]! << 8) | (file[29]! << 16)).toBe(239); // height - 1
    expect(file[20]! & 0x10).toBe(0); // no ALPH chunk, so no alpha flag
  });

  test("sets the alpha flag when the frame carries an ALPH chunk", () => {
    const inner = Uint8Array.of(0x41, 0x4c, 0x50, 0x48, 1, 0, 0, 0, 0);
    expect(standalone(inner, 4, 4)[20]! & 0x10).toBe(0x10);
  });
});

describe("frameAtTime", () => {
  const animation = {
    frames: [{ durationMs: 100 }, { durationMs: 200 }, { durationMs: 100 }],
  } as Animation;

  test.each([
    [0, 0],
    [99, 0],
    [100, 1],
    [299, 1],
    [300, 2],
    [399, 2],
  ])("%dms is on frame %d", (ms, index) => {
    expect(frameAtTime(animation, ms)).toBe(index);
  });

  test("past the end and before the start there is nothing on screen", () => {
    expect(frameAtTime(animation, 400)).toBe(-1);
    expect(frameAtTime(animation, -1)).toBe(-1);
  });
});

describe("sampleTimes", () => {
  test("takes the midpoint of each frame, never a boundary", () => {
    expect(sampleTimes([100, 200, 100])).toEqual([50, 200, 350]);
  });

  test("an empty timeline has nothing to sample", () => {
    expect(sampleTimes([])).toEqual([]);
  });
});

describe("composite", () => {
  /** A 2×2 canvas, so a whole screen fits in one assertion. */
  function frame(patch: Partial<AnimFrame>): AnimFrame {
    return {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      durationMs: 100,
      overwrite: true,
      disposeToBackground: false,
      still: new Uint8Array(0),
      ...patch,
    };
  }

  const RED = Uint8Array.of(255, 0, 0, 255);
  const HALF_BLUE = Uint8Array.of(0, 0, 255, 128);

  /** Hands each frame back the picture its `still` names, by index. */
  function decoder(patches: Pixels[]) {
    return async (still: Uint8Array): Promise<Pixels> => patches[still[0]!]!;
  }

  test("a frame lands at its own offset and leaves the rest of the canvas alone", async () => {
    const animation: Animation = {
      width: 2,
      height: 2,
      loopCount: 0,
      durationMs: 100,
      frames: [frame({ x: 0, y: 1, still: Uint8Array.of(0) })],
    };
    const screens = await composite(animation, decoder([{ width: 1, height: 1, data: RED }]));
    expect(Array.from(screens[0]!.data.subarray(0, 8))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(screens[0]!.data.subarray(8, 12))).toEqual([255, 0, 0, 255]);
  });

  test("a later frame blends over an earlier one unless it overwrites", async () => {
    const patches = [
      { width: 1, height: 1, data: RED },
      { width: 1, height: 1, data: HALF_BLUE },
    ];
    const blended: Animation = {
      width: 1,
      height: 1,
      loopCount: 0,
      durationMs: 200,
      frames: [
        frame({ still: Uint8Array.of(0) }),
        frame({ still: Uint8Array.of(1), overwrite: false }),
      ],
    };
    const [, second] = await composite(blended, decoder(patches));
    // Half blue over opaque red: the result stays opaque and mixes the two.
    expect(second!.data[3]).toBe(255);
    expect(second!.data[0]).toBeGreaterThan(100);
    expect(second!.data[2]).toBeGreaterThan(100);

    const overwritten: Animation = {
      ...blended,
      frames: [frame({ still: Uint8Array.of(0) }), frame({ still: Uint8Array.of(1), overwrite: true })],
    };
    const [, replaced] = await composite(overwritten, decoder(patches));
    expect(Array.from(replaced!.data)).toEqual([0, 0, 255, 128]);
  });

  test("dispose to background clears the rectangle before the next frame", async () => {
    const animation: Animation = {
      width: 1,
      height: 1,
      loopCount: 0,
      durationMs: 200,
      frames: [
        frame({ still: Uint8Array.of(0), disposeToBackground: true }),
        frame({ still: Uint8Array.of(1), overwrite: false }),
      ],
    };
    const patches = [
      { width: 1, height: 1, data: RED },
      { width: 1, height: 1, data: HALF_BLUE },
    ];
    const [first, second] = await composite(animation, decoder(patches));
    expect(Array.from(first!.data)).toEqual([255, 0, 0, 255]);
    // The red was disposed, so the half-transparent blue blends over nothing.
    expect(Array.from(second!.data)).toEqual([0, 0, 255, 128]);
  });

  test("a frame that decodes at the wrong size is an error, not a silent crop", async () => {
    const animation: Animation = {
      width: 2,
      height: 2,
      loopCount: 0,
      durationMs: 100,
      frames: [frame({ width: 2, height: 2, still: Uint8Array.of(0) })],
    };
    const wrong = [{ width: 1, height: 1, data: RED }];
    await expect(composite(animation, decoder(wrong))).rejects.toThrow(/decoded 1×1/);
  });
});
