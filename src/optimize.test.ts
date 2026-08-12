import { afterAll, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { ffmpeg } from "./ffmpeg.ts";
import { resolveOptions } from "./options.ts";
import { optimizeAsset } from "./optimize.ts";
import { STRICT_GATE } from "./quality.ts";

const ASSETS = join(import.meta.dir, "..", "example", "assets");
const CACHE = join(import.meta.dir, "..", "node_modules", ".cache", "bun-optimize-plugin-test");
const options = resolveOptions({ cacheDir: CACHE });

afterAll(async () => {
  await rm(CACHE, { recursive: true, force: true });
});

async function run(name: string) {
  const result = await optimizeAsset(join(ASSETS, name), options);
  return { ...result, extension: extname(result.path) };
}

/** Count the animation frame chunks of a WebP file. */
async function webpFrames(file: string): Promise<number> {
  const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
  let offset = 12;
  let frames = 0;
  while (offset + 8 <= bytes.length) {
    const type = String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
    const size = new DataView(bytes.buffer, bytes.byteOffset).getUint32(offset + 4, true);
    if (type === "ANMF") frames++;
    offset += 8 + size + (size % 2);
  }
  return frames;
}

test.each(["sample.png", "sample.jpg", "sample.jpeg"])("%s becomes a smaller webp", async name => {
  const result = await run(name);
  expect(result.extension).toBe(".webp");
  expect(result.outputSize).toBeLessThan(result.sourceSize);
});

test.each(["sample.wav", "sample.mp3", "sample.m4a", "sample.caf"])(
  "%s becomes a smaller webm",
  async name => {
    const result = await run(name);
    expect(result.extension).toBe(".webm");
    expect(result.outputSize).toBeLessThan(result.sourceSize);
  },
);

test.each(["sample.mov", "sample.mp4"])("%s becomes a smaller webm", async name => {
  const result = await run(name);
  expect(result.extension).toBe(".webm");
  expect(result.outputSize).toBeLessThan(result.sourceSize);
});

test("an animated gif keeps every frame", async () => {
  const result = await run("sample.gif");
  expect(result.extension).toBe(".webp");
  expect(await webpFrames(result.path)).toBe(2);
});

test("an apng keeps every frame", async () => {
  const result = await run("sample.apng");
  expect(result.extension).toBe(".webp");
  expect(await webpFrames(result.path)).toBe(10);
});

test("a webp source is never re-encoded", async () => {
  const result = await run("sample.webp");
  expect(result.path).toBe(join(ASSETS, "sample.webp"));
  expect(result.reason).toContain("already optimal");
});

test("a webm source is never re-encoded", async () => {
  const result = await run("sample.webm");
  expect(result.path).toBe(join(ASSETS, "sample.webm"));
  expect(result.reason).toContain("already optimal");
});

test("an opus source is remuxed, never re-encoded", async () => {
  const result = await run("sample.opus");
  // The WebM container is larger than Ogg for this one-second clip, so rule 4
  // keeps the source. The reason still proves the remux path ran.
  expect(result.outputSize).toBeLessThanOrEqual(result.sourceSize);
});

test("a source smaller than every candidate is kept", async () => {
  const result = await run("sample.avif");
  expect(result.path).toBe(join(ASSETS, "sample.avif"));
  expect(result.outputSize).toBe(result.sourceSize);
});

test("the second call reads the cache", async () => {
  const first = await run("sample.png");
  const second = await run("sample.png");
  expect(second.path).toBe(first.path);
  expect(second.outputSize).toBe(first.outputSize);
});

const forced = resolveOptions({ cacheDir: CACHE, force: true });

/**
 * True when this machine decodes AVIF. `Bun.Image` reads AVIF, HEIC, and TIFF
 * through the OS codec, which Linux does not have, and the bundled ffmpeg 5.0.1
 * does not demux a still AVIF either.
 */
const decodesAvif = await new Bun.Image(new Uint8Array(await Bun.file(join(ASSETS, "sample.avif")).arrayBuffer()))
  .webp({ quality: 80 })
  .bytes()
  .then(
    () => true,
    () => false,
  );

test("force converts an avif that the source would otherwise win", async () => {
  const source = join(ASSETS, "sample.avif");
  const kept = await optimizeAsset(source, options);
  expect(kept.path).toBe(source);

  const result = await optimizeAsset(source, forced);
  if (!decodesAvif) {
    // No AVIF decoder here, so force has nothing to convert and keeps the source.
    expect(result.path).toBe(source);
    expect(result.reason).toContain("encode failed");
    return;
  }
  expect(extname(result.path)).toBe(".webp");
  expect(result.outputSize).toBeGreaterThan(result.sourceSize);
  expect(result.reason).toContain("forced");
});

test("a format Bun.Image refuses falls back to ffmpeg", async () => {
  const source = join(CACHE, "fallback.tiff");
  await mkdir(CACHE, { recursive: true });
  await ffmpeg(["-y", "-i", join(ASSETS, "sample.png"), source]);

  // The "bun" backend drops the OS codec, so every machine refuses this TIFF
  // the way Linux does. ffmpeg decodes it, so the encode still produces a WebP.
  const backend = Bun.Image.backend;
  Bun.Image.backend = "bun";
  try {
    const result = await optimizeAsset(source, resolveOptions({ cacheDir: CACHE, force: true }));
    expect(extname(result.path)).toBe(".webp");
    expect(result.reason).toContain("via ffmpeg");
  } finally {
    Bun.Image.backend = backend;
  }
});

test("force converts an ogg to webm even though webm is larger", async () => {
  const result = await optimizeAsset(join(ASSETS, "sample.ogg"), forced);
  expect(extname(result.path)).toBe(".webm");
  expect(result.reason).toContain("remux opus to webm");
});

test.each(["sample.webp", "sample.webm"])("force leaves %s alone, it is the target format", async name => {
  const source = join(ASSETS, name);
  const result = await optimizeAsset(source, forced);
  expect(result.path).toBe(source);
});

test("force still keeps a source that cannot be encoded", async () => {
  const broken = join(CACHE, "forced-broken.mp4");
  await Bun.write(broken, "not a video");
  const result = await optimizeAsset(broken, forced);
  expect(result.path).toBe(broken);
  expect(result.reason).toContain("encode failed");
});

test("a file that cannot be decoded is kept, not thrown on", async () => {
  const broken = join(CACHE, "broken.png");
  const source = new Uint8Array(await Bun.file(join(ASSETS, "sample.png")).arrayBuffer());
  await Bun.write(broken, source.subarray(0, 200));

  const result = await optimizeAsset(broken, options);
  expect(result.path).toBe(broken);
  expect(result.reason).toContain("encode failed");
});

test("a file with a second audio track loses it, and the log says so", async () => {
  // Rule 16 reports this one rather than refusing it. Only the first track is
  // ever encoded, and a second track is a described audio track or another
  // language often enough that losing it without a word is not acceptable.
  const source = join(CACHE, "two-tracks.mp4");
  await mkdir(CACHE, { recursive: true });
  const wav = join(ASSETS, "sample.wav");
  await ffmpeg(["-y", "-i", wav, "-i", join(ASSETS, "sample.mp3"), "-map", "0:a", "-map", "1:a", "-c:a", "aac", source]);

  const result = await optimizeAsset(source, forced);
  expect(extname(result.path)).toBe(".webm");
  expect(result.reason).toContain("2 audio tracks, only the first was kept");

  const one = await optimizeAsset(wav, forced);
  expect(one.reason).not.toContain("audio tracks");
});

test("a changed quality setting misses the cache", async () => {
  const source = join(ASSETS, "sample.jpg");
  const pinned = { cacheDir: CACHE, tryLossless: false, gate: false as const };
  const lossy = await optimizeAsset(source, resolveOptions({ ...pinned, quality: 40 }));
  const better = await optimizeAsset(source, resolveOptions({ ...pinned, quality: 90 }));
  expect(lossy.path).not.toBe(better.path);
  expect(lossy.outputSize).toBeLessThan(better.outputSize);
});

test("a changed gate misses the cache", async () => {
  const source = join(ASSETS, "sample.jpg");
  const strict = await optimizeAsset(source, resolveOptions({ cacheDir: CACHE, gate: STRICT_GATE }));
  const loose = await optimizeAsset(source, resolveOptions({ cacheDir: CACHE, gate: { rmse: 30, p999: 200 } }));
  expect(strict.path).not.toBe(loose.path);
});

// ------------------------------------------------------------- the gate

/** Tighter than any lossy encoder can meet, so the refusal is the measurement. */
const IMPOSSIBLE_GATE = { rmse: 0.01, p999: 1 };

test("a quality the gate refuses does not ship, and the reason says why", async () => {
  const result = await optimizeAsset(
    join(ASSETS, "sample.png"),
    resolveOptions({ cacheDir: CACHE, tryLossless: false, quality: 20, gate: IMPOSSIBLE_GATE }),
  );
  expect(result.path).toBe(join(ASSETS, "sample.png"));
  expect(result.reason).toMatch(/webp q20 rmse \d+\.\d+, p99\.9 \d+/);
});

test("lossless is the floor under the gate, so there is always something to ship", async () => {
  // Every lossy step is refused. Lossless carries no error, so it passes, and
  // the asset still converts instead of falling back to its source.
  const result = await optimizeAsset(
    join(ASSETS, "sample.png"),
    resolveOptions({ cacheDir: CACHE, quality: 20, gate: IMPOSSIBLE_GATE }),
  );
  expect(extname(result.path)).toBe(".webp");
  expect(result.reason).toBe("webp lossless");
});

test("the same quality ships once the gate is turned off", async () => {
  const options = { cacheDir: CACHE, tryLossless: false, quality: 20 };
  const measured = await optimizeAsset(join(ASSETS, "sample.png"), resolveOptions({ ...options, gate: IMPOSSIBLE_GATE }));
  const unmeasured = await optimizeAsset(join(ASSETS, "sample.png"), resolveOptions({ ...options, gate: false }));
  expect(measured.path).toBe(join(ASSETS, "sample.png"));
  expect(extname(unmeasured.path)).toBe(".webp");
  expect(unmeasured.reason).toBe("webp q20");
});

test("an accepted candidate reports what it measured", async () => {
  const result = await run("sample.jpg");
  expect(result.extension).toBe(".webp");
  expect(result.reason).toMatch(/webp (lossless|q\d+ \(rmse )/);
});

test("with no gate the best step of the ladder is used, not the smallest", async () => {
  const options = { cacheDir: CACHE, tryLossless: false, gate: false as const };
  const ladder = await optimizeAsset(join(ASSETS, "sample.jpg"), resolveOptions({ ...options, quality: [70, 90] }));
  const best = await optimizeAsset(join(ASSETS, "sample.jpg"), resolveOptions({ ...options, quality: 90 }));
  expect(ladder.reason).toBe("webp q90");
  expect(ladder.outputSize).toBe(best.outputSize);
});

// ---------------------------------------------------------- the width cap

/** A source wide enough to exercise the cap, written into the cache directory. */
async function wide(name: string, width: number): Promise<string> {
  const path = join(CACHE, name);
  await mkdir(CACHE, { recursive: true });
  const source = new Uint8Array(await Bun.file(join(ASSETS, "sample.png")).arrayBuffer());
  await Bun.write(path, await new Bun.Image(source).resize(width).png().bytes());
  return path;
}

test("an image wider than the cap is resampled, and the report says by how much", async () => {
  const source = await wide("wide.png", 512);
  const result = await optimizeAsset(source, resolveOptions({ cacheDir: CACHE, maxWidth: 128 }));
  expect(result.reason).toContain("512×512 resampled to 128px wide");
  const output = await new Bun.Image(new Uint8Array(await Bun.file(result.path).arrayBuffer())).metadata();
  expect(output.width).toBe(128);
});

test("an image already inside the cap is left at its own size", async () => {
  const source = await wide("narrow.png", 64);
  const result = await optimizeAsset(source, resolveOptions({ cacheDir: CACHE, maxWidth: 128 }));
  expect(result.reason).not.toContain("resampled");
  const output = await new Bun.Image(new Uint8Array(await Bun.file(result.path).arrayBuffer())).metadata();
  expect(output.width).toBe(64);
});

test("a large decode is reported even when no cap is set", async () => {
  // Bytes on the wire are not the cost of an oversized image. Nothing else in
  // the pipeline can see this, so the report is the only place it shows up.
  const source = await wide("huge.png", 2100);
  const result = await optimizeAsset(
    source,
    resolveOptions({ cacheDir: CACHE, tryLossless: false, gate: false, quality: 90 }),
  );
  expect(result.reason).toContain("2100×2100 decodes to");
});

test("a changed cap misses the cache", async () => {
  const source = await wide("recapped.png", 512);
  const small = await optimizeAsset(source, resolveOptions({ cacheDir: CACHE, maxWidth: 64 }));
  const large = await optimizeAsset(source, resolveOptions({ cacheDir: CACHE, maxWidth: 256 }));
  expect(small.outputSize).not.toBe(large.outputSize);
});

// ------------------------------------------------------- animation and video

test("an animation ships only after every frame has been compared", async () => {
  const result = await run("sample.apng");
  expect(result.extension).toBe(".webp");
  expect(result.reason).toMatch(/animated webp (lossless|q\d+) \(rmse /);
  expect(await webpFrames(result.path)).toBe(10);
});

test("an animation is still measured when the encode is lossless", async () => {
  const result = await run("sample.gif");
  expect(result.reason).toContain("(rmse ");
  expect(await webpFrames(result.path)).toBe(2);
});

test("an encoded video is decoded again before it is kept", async () => {
  const result = await run("sample.mov");
  expect(result.extension).toBe(".webm");
  expect(result.reason).toMatch(/\d+ frames verified/);
});

test("an encoded audio file has its runtime verified", async () => {
  const result = await run("sample.wav");
  expect(result.extension).toBe(".webm");
  expect(result.reason).toContain("runtime verified");
});
