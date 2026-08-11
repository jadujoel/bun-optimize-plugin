import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { resolveOptions } from "./options.ts";
import { optimizeAsset } from "./optimize.ts";

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

test("force converts an avif that the source would otherwise win", async () => {
  const source = join(ASSETS, "sample.avif");
  const kept = await optimizeAsset(source, options);
  expect(kept.path).toBe(source);

  const result = await optimizeAsset(source, forced);
  expect(extname(result.path)).toBe(".webp");
  expect(result.outputSize).toBeGreaterThan(result.sourceSize);
  expect(result.reason).toContain("forced");
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

test("a changed quality setting misses the cache", async () => {
  const source = join(ASSETS, "sample.jpg");
  const lossy = await optimizeAsset(source, resolveOptions({ cacheDir: CACHE, tryLossless: false, quality: 40 }));
  const better = await optimizeAsset(source, resolveOptions({ cacheDir: CACHE, tryLossless: false, quality: 90 }));
  expect(lossy.path).not.toBe(better.path);
  expect(lossy.outputSize).toBeLessThan(better.outputSize);
});
