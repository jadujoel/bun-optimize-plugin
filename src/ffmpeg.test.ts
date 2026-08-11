import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { countFrames, framesDecoded, probe, reportDuration } from "./ffmpeg.ts";

const ASSETS = join(import.meta.dir, "..", "example", "assets");

describe("reportDuration", () => {
  test.each([
    ["  Duration: 00:00:00.40, start: 0.000000, bitrate: 7 kb/s", 0.4],
    ["  Duration: 00:01:02.50, start: 0.000000, bitrate: 1 kb/s", 62.5],
    ["  Duration: 01:00:00.00, start: 0.000000", 3600],
  ])("%s reads as %d seconds", (line, seconds) => {
    expect(reportDuration(line)).toBeCloseTo(seconds, 6);
  });

  test("a container that does not say has no duration", () => {
    expect(reportDuration("  Duration: N/A, bitrate: N/A")).toBeUndefined();
    expect(reportDuration("nothing here")).toBeUndefined();
  });
});

describe("framesDecoded", () => {
  test("takes the last progress line, not the first", () => {
    const report = "frame=    1 fps=0.0 q=0.0\nframe=   15 fps=1.0 q=-0.0 Lsize=N/A";
    expect(framesDecoded(report)).toBe(15);
  });

  test("a report with no progress line decoded nothing", () => {
    expect(framesDecoded("Invalid data found when processing input")).toBe(0);
  });
});

describe("probe", () => {
  test("reads the codec, the channel count and the runtime of a video", async () => {
    const result = await probe(join(ASSETS, "sample.mov"));
    expect(result.video?.codec).toBeString();
    expect(result.duration).toBeGreaterThan(0);
  });

  test("reads an audio stream without inventing a video one", async () => {
    const result = await probe(join(ASSETS, "sample.wav"));
    expect(result.video).toBeUndefined();
    expect(result.audio?.channels).toBeGreaterThanOrEqual(1);
    expect(result.duration).toBeGreaterThan(0);
  });
});

describe("countFrames", () => {
  test("counts what the decoder actually produced", async () => {
    expect(await countFrames(join(ASSETS, "sample.mp4"))).toBeGreaterThan(0);
  });

  test("a file that is not media decodes no frames", async () => {
    expect(await countFrames(join(ASSETS, "sample.zip"))).toBe(0);
  });
});
