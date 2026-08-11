/**
 * What happens when the source is not one of the six formats everybody ships.
 *
 * Every fixture here is built by ffmpeg at test time rather than committed,
 * because the point of the file is coverage of a long tail and a long tail is
 * a lot of binaries. The sources are the same `example/assets` clips the rest
 * of the suite uses, re-containered and re-encoded.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from "./detect.ts";
import { ffmpeg, probe } from "./ffmpeg.ts";
import { isOptimizable, optimizeAsset } from "./optimize.ts";
import { resolveOptions } from "./options.ts";

const ASSETS = join(import.meta.dir, "..", "example", "assets");
const WORK = join(import.meta.dir, "..", "node_modules", ".cache", "bun-optimize-plugin-formats");
const options = resolveOptions({ cacheDir: join(WORK, "cache") });
/**
 * Most fixtures here are tiny or synthetic, so a WebP or a WebM of them is
 * often the larger file and rule 7 would keep the source. `force` takes size
 * out of the question and leaves the routing on its own.
 */
const forced = resolveOptions({ cacheDir: join(WORK, "cache"), force: true });

await rm(WORK, { recursive: true, force: true });
await mkdir(WORK, { recursive: true });

afterAll(async () => {
  await rm(WORK, { recursive: true, force: true });
});

const asset = (name: string) => join(ASSETS, name);

/** Build a fixture with ffmpeg. The output path is always the last argument. */
async function make(name: string, args: string[]): Promise<string> {
  const path = join(WORK, name);
  const { ok, stderr } = await ffmpeg(["-y", ...args, path]);
  if (!ok) throw new Error(`could not build ${name}\n${stderr.split("\n").slice(-6).join("\n")}`);
  return path;
}

/** Copy bytes under a name that lies about them. */
async function misnamed(name: string, from: string): Promise<string> {
  const path = join(WORK, name);
  await Bun.write(path, Bun.file(asset(from)));
  return path;
}

// ------------------------------------------------------ the still image tail

test.each(["tga", "pcx", "ppm", "pgm", "sgi", "jp2", "bmp", "xbm", "tiff"])(
  "a .%s still image becomes a webp",
  async extension => {
    const source = await make(`still.${extension}`, ["-i", asset("sample.png")]);
    const result = await optimizeAsset(source, forced);
    expect(extname(result.path)).toBe(".webp");
  },
);

test("a format the sniffer does not know is encoded by ffmpeg, and the report says so", async () => {
  const source = await make("reported.tga", ["-i", asset("sample.png")]);
  const result = await optimizeAsset(source, forced);
  expect(result.reason).toContain("via ffmpeg");
});

test("a bmp Bun.Image cannot decode is encoded by ffmpeg instead of kept", async () => {
  // ffmpeg writes a BMP variant `Bun.Image` recognises and then refuses, which
  // is the third refusal: not an unknown format and not a missing OS codec.
  const source = await make("decode-failed.bmp", ["-i", asset("sample.png")]);
  const result = await optimizeAsset(source, forced);
  expect(result.reason).toContain("ERR_IMAGE_DECODE_FAILED");
  expect(extname(result.path)).toBe(".webp");
});

test("an uncompressed still is smaller as a webp, with no force needed", async () => {
  const source = await make("plain.tga", ["-i", asset("sample.png")]);
  const result = await optimizeAsset(source, options);
  expect(extname(result.path)).toBe(".webp");
  expect(result.outputSize).toBeLessThan(result.sourceSize);
});

// ------------------------------------------------------------ the audio tail

test.each([
  ["flac", ["-c:a", "flac"]],
  ["aiff", ["-c:a", "pcm_s16be"]],
  ["au", ["-c:a", "pcm_s16be"]],
  ["wma", ["-c:a", "wmav2"]],
  ["aac", ["-c:a", "aac"]],
  ["mka", ["-c:a", "libmp3lame"]],
])("a .%s file becomes opus in webm", async (extension, encoder) => {
  const source = await make(`sound.${extension}`, ["-i", asset("sample.wav"), ...encoder]);
  const result = await optimizeAsset(source, forced);
  expect(extname(result.path)).toBe(".webm");
  expect((await probe(result.path)).audio?.codec).toBe("opus");
});

test("an audio-only mp4 is routed as audio, not refused for having no video", async () => {
  const source = await make("audio-only.mp4", ["-i", asset("sample.mp3"), "-c:a", "aac"]);
  const result = await optimizeAsset(source, forced);
  expect(extname(result.path)).toBe(".webm");

  const streams = await probe(result.path);
  expect(streams.audio?.codec).toBe("opus");
  expect(streams.video).toBeUndefined();
});

test("album art does not turn a song into a film", async () => {
  const source = await make("cover.mp3", [
    // prettier-ignore
    "-i", asset("sample.mp3"), "-i", asset("sample.jpg"),
    "-map", "0:a", "-map", "1:v", "-c", "copy", "-disposition:v", "attached_pic",
  ]);
  // The cover is a video stream by every other measure, and routing on it would
  // encode the artwork as a one-frame film and throw the music away.
  const before = await probe(source);
  expect(before.coverArt).toBe(true);
  expect(before.video).toBeUndefined();

  const result = await optimizeAsset(source, forced);
  const after = await probe(result.path);
  expect(extname(result.path)).toBe(".webm");
  expect(after.audio?.codec).toBe("opus");
  expect(after.video).toBeUndefined();
});

// ------------------------------------------------------------ the video tail

test.each([
  ["avi", ["-c:v", "mpeg4"]],
  ["m4v", ["-c:v", "libx264"]],
  ["mkv", ["-c:v", "libx265"]],
  ["flv", ["-c:v", "flv"]],
  ["mpg", ["-c:v", "mpeg2video"]],
  ["3gp", ["-c:v", "libx264", "-c:a", "aac", "-ar", "8000"]],
])("a .%s file becomes vp9 in webm", async (extension, encoder) => {
  const source = await make(`clip.${extension}`, ["-i", asset("sample.mov"), ...encoder]);
  const result = await optimizeAsset(source, forced);
  expect(extname(result.path)).toBe(".webm");
  expect((await probe(result.path)).video?.codec).toBe("vp9");
});

test("an ogg carrying video keeps its video", async () => {
  // `.ogg` is in the audio table, and an audio encode strips video without a
  // word. The bytes say Theora, so the bytes win.
  const source = await make("with-video.ogg", ["-i", asset("sample.mov"), "-c:v", "libtheora"]);
  const result = await optimizeAsset(source, forced);
  expect((await probe(result.path)).video?.codec).toBe("vp9");
});

test("a vp9 mp4 keeps its picture and only re-encodes the sound", async () => {
  // The source is VP9 video beside AAC audio. Only the audio is wrong, so only
  // the audio is encoded again.
  const source = await make("vp9.mp4", ["-i", asset("sample.mov"), "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "40"]);
  expect((await probe(source)).audio?.codec).toBe("aac");

  const result = await optimizeAsset(source, forced);
  expect(result.reason).toContain("vp9 copied to webm, opus");
  expect((await probe(result.path)).video?.codec).toBe("vp9");
});

test("a vp9 and opus mkv is remuxed, because .mkv is not a name a video tag takes", async () => {
  const source = await make("right-bytes.mkv", [
    // prettier-ignore
    "-i", asset("sample.mov"), "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "40", "-c:a", "libopus",
  ]);
  const result = await optimizeAsset(source, forced);
  expect(extname(result.path)).toBe(".webm");
  expect(result.reason).toContain("vp9 copied to webm, opus copied");
});

// -------------------------------------------------- content beats the name

test("a still picture wearing a video extension becomes a webp", async () => {
  const result = await optimizeAsset(await misnamed("liar.mp4", "sample.png"), forced);
  expect(extname(result.path)).toBe(".webp");
});

test("a film wearing an image extension becomes a webm", async () => {
  const result = await optimizeAsset(await misnamed("liar.png", "sample.mov"), forced);
  expect(extname(result.path)).toBe(".webm");
  expect((await probe(result.path)).video?.codec).toBe("vp9");
});

test("an animation wearing a still extension keeps its frames", async () => {
  const result = await optimizeAsset(await misnamed("liar.jpg", "sample.gif"), forced);
  expect(extname(result.path)).toBe(".webp");
  expect(result.reason).toContain("animated webp");
});

// --------------------------------------------- already in the target format

test("an audio-only webm is left alone", async () => {
  const source = await make("音.webm", ["-i", asset("sample.opus"), "-vn", "-c:a", "copy"]);
  const result = await optimizeAsset(source, forced);
  expect(result.path).toBe(source);
  expect(result.reason).toContain("already optimal");
});

test("a vp8 and vorbis webm is left alone, it is not the target codec but it is a webm", async () => {
  const source = await make("vp8.webm", ["-i", asset("sample.mov"), "-c:v", "libvpx", "-b:v", "200k"]);
  const result = await optimizeAsset(source, forced);
  expect(result.path).toBe(source);
  expect(result.reason).toContain("already optimal");
});

test("h264 in a file named .webm is re-encoded, because the name is not the format", async () => {
  const source = await make("fake.webm", ["-i", asset("sample.mov"), "-c:v", "libx264", "-f", "matroska"]);
  const result = await optimizeAsset(source, forced);
  expect(result.path).not.toBe(source);
  expect((await probe(result.path)).video?.codec).toBe("vp9");
});

// ------------------------------------------------------- nothing to work with

test("a file with no stream at all keeps its source and says what was wrong", async () => {
  const source = join(WORK, "prose.m4a");
  await Bun.write(source, "This is not a song.");
  const result = await optimizeAsset(source, forced);
  expect(result.path).toBe(source);
  expect(result.reason).toContain("no image, audio, or video stream was found");
});

test("an empty file keeps its source", async () => {
  const source = join(WORK, "empty.png");
  await Bun.write(source, "");
  const result = await optimizeAsset(source, forced);
  expect(result.path).toBe(source);
  expect(result.outputSize).toBe(0);
});

// --------------------------------------------------------- the extension gate

test("the video table does not claim .ts, which is also TypeScript", () => {
  expect(VIDEO_EXTENSIONS.has(".ts")).toBe(false);
  expect(isOptimizable("component.ts")).toBe(false);
});

test("no extension appears in two tables", () => {
  const seen = new Set<string>();
  for (const table of [AUDIO_EXTENSIONS, VIDEO_EXTENSIONS, IMAGE_EXTENSIONS]) {
    for (const extension of table) {
      expect(seen.has(extension)).toBe(false);
      seen.add(extension);
    }
  }
});

test("an extension is matched whatever its case", () => {
  expect(isOptimizable("PHOTO.TGA")).toBe(true);
  expect(isOptimizable("Clip.AVI")).toBe(true);
});

test.each([".exr", ".hdr", ".dds", ".svg", ".ico", ".ktx"])("%s is left for something else to handle", extension => {
  expect(isOptimizable(`texture${extension}`)).toBe(false);
});
