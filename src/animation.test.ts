import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { judgeAnimation } from "./animation.ts";
import { decodeFrames, ffmpeg } from "./ffmpeg.ts";
import { DEFAULT_GATE } from "./quality.ts";

const ASSETS = join(import.meta.dir, "..", "example", "assets");
const SCRATCH = join(import.meta.dir, "..", "node_modules", ".cache", "animation-test");
const SOURCE = join(ASSETS, "sample.apng");

await mkdir(SCRATCH, { recursive: true });
const decoded = await decodeFrames(SOURCE, SCRATCH);

afterAll(async () => {
  await rm(SCRATCH, { recursive: true, force: true });
});

/** Encode the source to animated WebP, `args` deciding how faithfully. */
async function encode(args: string[]): Promise<Uint8Array> {
  const output = join(SCRATCH, `${Bun.hash(args.join(" ")).toString(16)}.webp`);
  const { ok, stderr } = await ffmpeg([
    ...["-y", "-i", SOURCE, "-c:v", "libwebp_anim", "-loop", "0", "-pix_fmt", "bgra"],
    ...args,
    ...["-f", "webp", output],
  ]);
  if (!ok) throw new Error(stderr.split("\n").slice(-4).join("\n"));
  return new Uint8Array(await Bun.file(output).arrayBuffer());
}

function judge(encoded: Uint8Array) {
  return judgeAnimation(encoded, decoded.files, decoded.durations, DEFAULT_GATE);
}

test("the source decodes to one frame per timing", () => {
  expect(decoded.files).toHaveLength(10);
  expect(decoded.durations).toEqual(Array(10).fill(100));
});

describe("judgeAnimation", () => {
  test("a lossless encode is accepted, and carries no error at all", async () => {
    const verdict = await judge(await encode(["-lossless", "1"]));
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.worst).toEqual({ rmse: 0, p999: 0 });
  });

  test("an encode that dropped frames is refused", async () => {
    // `-r 2` resamples ten frames at 10 fps down to a handful.
    const verdict = await judge(await encode(["-lossless", "1", "-r", "2"]));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.why).toContain("runtime");
  });

  test("an encode that plays at the wrong speed is refused", async () => {
    const verdict = await judge(await encode(["-lossless", "1", "-vf", "setpts=PTS/4"]));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.why).toMatch(/runtime \d+ms against 1000ms/);
  });

  test("an encode whose pictures are wrong is refused, and the frame is named", async () => {
    // This fixture is saturated primary colour, which is the worst case for
    // WebP's chroma subsampling: even q92 is far outside the gate.
    const verdict = await judge(await encode(["-lossless", "0", "-q:v", "82"]));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.why).toMatch(/^frame \d+ rmse /);
  });

  test("a still webp is not an animation and cannot be judged as one", async () => {
    const still = new Uint8Array(await Bun.file(join(ASSETS, "sample.webp")).arrayBuffer());
    const verdict = await judge(still);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.why).toBe("not a readable animation");
  });

  test("a source with no frames to compare against is refused, not assumed good", async () => {
    const encoded = await encode(["-lossless", "1"]);
    const verdict = await judgeAnimation(encoded, [], [], DEFAULT_GATE);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.why).toContain("0 frames");
  });

  test("frames and timings that disagree are refused rather than guessed at", async () => {
    const encoded = await encode(["-lossless", "1"]);
    const verdict = await judgeAnimation(encoded, decoded.files, decoded.durations.slice(0, 5), DEFAULT_GATE);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.why).toContain("against 5 timings");
  });
});
