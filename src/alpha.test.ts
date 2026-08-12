/**
 * Rule 16 for the alpha plane: probe the channel, measure whether it is used,
 * and refuse an encode that lost one it was meant to keep.
 *
 * The fixtures are built by ffmpeg at test time rather than committed, the way
 * `formats.test.ts` builds its own. `alphamerge` puts the luma of the second
 * input into the alpha of the first, so a black mask with a white box in it is
 * a clip whose alpha is used, and an all-white mask is a clip that carries an
 * alpha channel and does not use it. The second one is the case that matters:
 * it is what a ProRes 4444 export usually is.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { OPAQUE_ALPHA, alphaMinimum, carriesAlpha, ffmpeg, pixelFormatOf, probe } from "./ffmpeg.ts";
import { optimizeAsset, verifyEncode } from "./optimize.ts";
import { resolveOptions } from "./options.ts";

const ASSETS = join(import.meta.dir, "..", "example", "assets");
const WORK = join(import.meta.dir, "..", "node_modules", ".cache", "bun-optimize-plugin-alpha");

await rm(WORK, { recursive: true, force: true });
await mkdir(WORK, { recursive: true });

afterAll(async () => {
  await rm(WORK, { recursive: true, force: true });
});

const settings = (extra: Parameters<typeof resolveOptions>[0] = {}) =>
  resolveOptions({ cacheDir: join(WORK, "cache"), ...extra });

/** A ProRes 4444 clip, with the alpha channel `mask` describes. */
async function prores(name: string, mask: string): Promise<string> {
  const path = join(WORK, name);
  const { ok, stderr } = await ffmpeg([
    // prettier-ignore
    "-y",
    "-f", "lavfi", "-i", "color=c=red:s=320x240:d=1:r=10",
    "-f", "lavfi", "-i", mask,
    "-filter_complex", "[0:v][1:v]alphamerge",
    "-frames:v", "10", "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le",
    path,
  ]);
  if (!ok) throw new Error(`could not build ${name}\n${stderr.split("\n").slice(-6).join("\n")}`);
  return path;
}

const USED_MASK = "color=c=black:s=320x240:d=1:r=10,drawbox=x=80:y=60:w=160:h=120:color=white:t=fill";
const OPAQUE_MASK = "color=c=white:s=320x240:d=1:r=10";

const used = await prores("alpha-used.mov", USED_MASK);
const opaque = await prores("alpha-opaque.mov", OPAQUE_MASK);

/** The lowest alpha value in a WebM, read the only way a WebM will give it up. */
const webmAlpha = (file: string) => alphaMinimum(file, "libvpx-vp9");

// ------------------------------------------------------------------- the probe

test.each([
  ["  Stream #0:0[0x1]: Video: prores (4444) (ap4h / 0x68347061), yuva444p12le(tv, progressive), 320x240", "yuva444p12le"],
  ["  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 320x240 [SAR 1:1]", "yuv420p"],
  ["  Stream #0:0: Video: vp9 (Profile 0), yuv420p(tv, progressive), 320x240, SAR 1:1 DAR 4:3, 25 fps", "yuv420p"],
  ["  Stream #0:0: Video: gif, bgra, 320x240 [SAR 64:64 DAR 4:3], 10 fps, 10 tbr", "bgra"],
  ["  Stream #0:1: Video: png, rgba(pc), 100x100 (attached pic)", "rgba"],
])("%s names its pixel format", (line, format) => {
  expect(pixelFormatOf(line)).toBe(format);
});

test("a line with no pixel format names none", () => {
  expect(pixelFormatOf("  Stream #0:0: Audio: aac (LC), 44100 Hz, stereo, fltp, 128 kb/s")).toBeUndefined();
  expect(pixelFormatOf("Duration: 00:00:01.00, start: 0.000000")).toBeUndefined();
});

test("the pixel format is read from a real file, not only from a line", async () => {
  const streams = await probe(used);
  expect(streams.video?.pixelFormat).toStartWith("yuva444p");
  expect(carriesAlpha(streams.video?.pixelFormat)).toBeTrue();

  const plain = await probe(join(ASSETS, "sample.mp4"));
  expect(plain.video?.pixelFormat).toBe("yuv420p");
  expect(carriesAlpha(plain.video?.pixelFormat)).toBeFalse();
});

test.each(["yuva420p", "yuva444p12le", "gbrap", "ya8", "rgba", "argb", "abgr", "bgra", "rgba64le"])(
  "%s carries alpha",
  format => {
    expect(carriesAlpha(format)).toBeTrue();
  },
);

test.each(["yuv420p", "yuv444p10le", "gbrp", "gray", "yuvj420p", "nv12", undefined])(
  "%s does not carry alpha",
  format => {
    expect(carriesAlpha(format)).toBeFalse();
  },
);

// ------------------------------------------------------------- the measurement

test("a used alpha channel measures below opaque", async () => {
  expect(await alphaMinimum(used)).toBe(0);
});

test("an alpha channel that is there and unused measures fully opaque", async () => {
  expect(await alphaMinimum(opaque)).toBe(OPAQUE_ALPHA);
});

test("a source with no alpha channel cannot be measured at all", async () => {
  // Not a bug and not an error. `alphaextract` refuses a frame it cannot take
  // an alpha plane from, so the absence and the failure are one answer here.
  expect(await alphaMinimum(join(ASSETS, "sample.mp4"))).toBeUndefined();
});

// --------------------------------------------------------------- the encode

test("a video whose alpha is used keeps it", async () => {
  const result = await optimizeAsset(used, settings());
  expect(extname(result.path)).toBe(".webm");
  expect(result.reason).toContain("yuva420p");
  expect(result.reason).toContain("alpha channel verified");
  expect(await webmAlpha(result.path)).toBe(0);
});

test("a video whose alpha channel is opaque loses it, and says so", async () => {
  const result = await optimizeAsset(opaque, settings());
  expect(extname(result.path)).toBe(".webm");
  expect(result.reason).toContain("fully opaque");
  expect(await webmAlpha(result.path)).toBeUndefined();
});

test("a video with no alpha channel is not measured and not mentioned", async () => {
  const result = await optimizeAsset(join(ASSETS, "sample.mp4"), settings());
  expect(extname(result.path)).toBe(".webm");
  expect(result.reason).not.toContain("alpha");
});

test("alpha drop flattens a used channel on purpose", async () => {
  const result = await optimizeAsset(used, settings({ alpha: "drop" }));
  expect(result.reason).toContain("`alpha` is `drop`");
  expect(await webmAlpha(result.path)).toBeUndefined();
});

test("alpha keep keeps a channel nothing uses", async () => {
  const result = await optimizeAsset(opaque, settings({ alpha: "keep" }));
  expect(result.reason).toContain("yuva420p");
  expect(await webmAlpha(result.path)).toBe(OPAQUE_ALPHA);
});

test("the alpha policy is part of the cache key", async () => {
  const kept = await optimizeAsset(used, settings({ alpha: "keep" }));
  const dropped = await optimizeAsset(used, settings({ alpha: "drop" }));
  expect(kept.path).not.toBe(dropped.path);
});

// -------------------------------------------------------------- the overrides

test("an override keeps one clip's alpha while the build drops the rest", async () => {
  // The case this was written for: one clip on the page has no background of
  // its own, so its alpha is what the dimmed page shows through. Every other
  // clip in the build is footage that wants the smaller flattened encode.
  const rose = await prores("signup-rose.mov", USED_MASK);
  const footage = await prores("interview.mov", USED_MASK);
  const options = settings({ alpha: "drop", overrides: [{ match: /signup-rose\.mov$/, alpha: "keep" }] });

  const kept = await optimizeAsset(rose, options);
  expect(await webmAlpha(kept.path)).toBe(0);
  expect(kept.reason).toContain("yuva420p");

  const flattened = await optimizeAsset(footage, options);
  expect(await webmAlpha(flattened.path)).toBeUndefined();
  expect(flattened.reason).toContain("`alpha` is `drop`");
});

// ------------------------------------------------------------------- the gate

test("an encode that lost the alpha channel is refused", async () => {
  const flattened = join(WORK, "flattened.webm");
  const kept = join(WORK, "kept.webm");
  const vp9 = ["-c:v", "libvpx-vp9", "-crf", "40", "-b:v", "0", "-an", "-f", "webm"];
  await ffmpeg(["-y", "-i", used, ...vp9, "-pix_fmt", "yuv420p", flattened]);
  await ffmpeg(["-y", "-i", used, ...vp9, "-pix_fmt", "yuva420p", kept]);
  const before = await probe(used);

  // The frames and the runtime of the flattened encode are perfectly good, and
  // it is the smaller file. Every gate but this one passes it.
  const withoutTheCheck = await verifyEncode(used, flattened, before, true, false);
  expect(withoutTheCheck.ok).toBeTrue();
  expect(Bun.file(flattened).size).toBeLessThan(Bun.file(kept).size);

  for (const requirement of ["present", "used"] as const) {
    const verdict = await verifyEncode(used, flattened, before, true, requirement);
    expect(verdict.ok).toBeFalse();
    expect(verdict.ok || verdict.why).toContain("no alpha channel");
  }

  const good = await verifyEncode(used, kept, before, true, "used");
  expect(good.ok).toBeTrue();
  expect(good.ok && good.note).toContain("alpha channel verified");
});

test("an alpha channel that came out opaque fails `used` and passes `present`", async () => {
  const flat = join(WORK, "opaque-alpha.webm");
  // A yuva420p encode of a source whose alpha is unused. The channel is there
  // and it says nothing. Against a source that was measured as using its alpha
  // channel that is a flattened encode wearing one, so `used` refuses it. When
  // nothing measured the source, an opaque result is the faithful result.
  await ffmpeg([
    // prettier-ignore
    "-y", "-i", opaque,
    "-c:v", "libvpx-vp9", "-crf", "40", "-b:v", "0", "-an",
    "-pix_fmt", "yuva420p", "-f", "webm", flat,
  ]);
  const before = await probe(opaque);

  const strict = await verifyEncode(opaque, flat, before, true, "used");
  expect(strict.ok).toBeFalse();
  expect(strict.ok || strict.why).toContain("fully opaque");

  expect((await verifyEncode(opaque, flat, before, true, "present")).ok).toBeTrue();
});
