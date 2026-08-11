import { mkdir, rename, rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, isAnimated, sniffImageFormat } from "./detect.ts";
import { ffmpeg, probe } from "./ffmpeg.ts";
import { encodeKey, type ResolvedOptions } from "./options.ts";

export interface OptimizeResult {
  /** The file the bundler emits. Equal to the source when the source wins. */
  path: string;
  /** Size of the source file in bytes. */
  sourceSize: number;
  /** Size of the emitted file in bytes. */
  outputSize: number;
  /** Short explanation, for the verbose log. */
  reason: string;
}

interface CacheRecord {
  file: string | null;
  sourceSize: number;
  outputSize: number;
  reason: string;
}

interface Candidate {
  path: string;
  size: number;
  reason: string;
}

/** True for an extension this plugin can route. Every other file is copied. */
export function isOptimizable(file: string): boolean {
  const ext = extname(file).toLowerCase();
  return AUDIO_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext) || IMAGE_EXTENSIONS.has(ext);
}

function opusBitrate(options: ResolvedOptions, channels: number): string {
  if (options.audioBitrate) return options.audioBitrate;
  if (channels <= 1) return "48k";
  if (channels === 2) return "96k";
  return "128k";
}

/** Encode to a unique temporary file, so two builds never share a partial write. */
async function encodeToTemp(
  directory: string,
  extension: string,
  args: (output: string) => string[],
  reason: string,
): Promise<Candidate | null> {
  const output = join(directory, `tmp-${crypto.randomUUID()}${extension}`);
  const { ok, stderr } = await ffmpeg(args(output));
  if (!ok) {
    await rm(output, { force: true });
    throw new Error(stderr.split("\n").slice(-6).join("\n").trim());
  }
  const size = Bun.file(output).size;
  if (size === 0) {
    await rm(output, { force: true });
    return null;
  }
  return { path: output, size, reason };
}

async function writeTemp(
  directory: string,
  extension: string,
  bytes: Uint8Array,
  reason: string,
): Promise<Candidate> {
  const output = join(directory, `tmp-${crypto.randomUUID()}${extension}`);
  await Bun.write(output, bytes);
  return { path: output, size: bytes.byteLength, reason };
}

/**
 * True when `Bun.Image` refused the format on this machine.
 *
 * AVIF, HEIC, and TIFF decode through the OS codec, so they work on macOS and
 * on Windows and fail on Linux. The fallback encoder runs on that rejection.
 */
function isUnsupportedFormat(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "ERR_IMAGE_FORMAT_UNSUPPORTED";
}

/**
 * Encode a still image to WebP with ffmpeg, for a format `Bun.Image` refuses.
 *
 * This covers TIFF on Linux. The bundled ffmpeg is 5.0.1, and its MOV demuxer
 * does not read a still AVIF or HEIC, so those two throw here and the caller
 * keeps the source.
 */
async function encodeStillImageWithFfmpeg(
  source: string,
  directory: string,
  options: ResolvedOptions,
): Promise<Candidate[]> {
  const common = ["-y", "-i", source, "-map_metadata", "-1", "-frames:v", "1", "-c:v", "libwebp"];
  const candidates: Candidate[] = [];
  const lossy = await encodeToTemp(
    directory,
    ".webp",
    output => [...common, "-lossless", "0", "-q:v", String(options.quality), "-pix_fmt", "yuva420p", "-f", "webp", output],
    `webp q${options.quality} via ffmpeg`,
  );
  if (lossy) candidates.push(lossy);
  if (options.tryLossless) {
    const lossless = await encodeToTemp(
      directory,
      ".webp",
      output => [...common, "-lossless", "1", "-pix_fmt", "bgra", "-f", "webp", output],
      "webp lossless via ffmpeg",
    );
    if (lossless) candidates.push(lossless);
  }
  return candidates;
}

/**
 * Encode a still image to WebP with `Bun.Image`.
 *
 * `Bun.Image` decodes from the bytes, so EXIF, GPS, and non-sRGB ICC profiles
 * never reach the output. `autoOrient` applies the EXIF orientation first.
 *
 * A format the OS codec owns falls back to ffmpeg. The first encode proves the
 * decoder, so the lossless encode after it never hits that fallback.
 */
async function encodeStillImage(
  source: string,
  bytes: Uint8Array,
  directory: string,
  options: ResolvedOptions,
): Promise<Candidate[]> {
  let lossy: Uint8Array;
  try {
    lossy = await new Bun.Image(bytes, { autoOrient: true }).webp({ quality: options.quality }).bytes();
  } catch (error) {
    if (!isUnsupportedFormat(error)) throw error;
    return encodeStillImageWithFfmpeg(source, directory, options);
  }

  const candidates: Candidate[] = [];
  candidates.push(await writeTemp(directory, ".webp", lossy, `webp q${options.quality}`));
  if (options.tryLossless) {
    const lossless = await new Bun.Image(bytes, { autoOrient: true }).webp({ lossless: true }).bytes();
    candidates.push(await writeTemp(directory, ".webp", lossless, "webp lossless"));
  }
  return candidates;
}

/**
 * Encode an animated image to animated WebP with ffmpeg.
 *
 * `-pix_fmt bgra` keeps the alpha channel and is what `libwebp_anim` wants.
 * `yuva420p` loses the alpha and produces a larger file.
 */
async function encodeAnimatedImage(
  source: string,
  directory: string,
  options: ResolvedOptions,
): Promise<Candidate[]> {
  const common = ["-y", "-i", source, "-map_metadata", "-1", "-c:v", "libwebp_anim", "-loop", "0", "-pix_fmt", "bgra"];
  const candidates: Candidate[] = [];
  const lossy = await encodeToTemp(
    directory,
    ".webp",
    output => [...common, "-lossless", "0", "-q:v", String(options.quality), "-f", "webp", output],
    `animated webp q${options.quality}`,
  );
  if (lossy) candidates.push(lossy);
  if (options.tryLossless) {
    const lossless = await encodeToTemp(
      directory,
      ".webp",
      output => [...common, "-lossless", "1", "-f", "webp", output],
      "animated webp lossless",
    );
    if (lossless) candidates.push(lossless);
  }
  return candidates;
}

async function encodeAudio(
  source: string,
  directory: string,
  options: ResolvedOptions,
): Promise<Candidate[]> {
  const streams = await probe(source);
  if (!streams.audio) throw new Error("no audio stream was found");

  // Rule 5: an Opus source is remuxed, never re-encoded.
  if (streams.audio.codec === "opus") {
    const remux = await encodeToTemp(
      directory,
      ".webm",
      output => ["-y", "-i", source, "-vn", "-map_metadata", "-1", "-c:a", "copy", "-f", "webm", output],
      "remux opus to webm",
    );
    return remux ? [remux] : [];
  }

  const bitrate = opusBitrate(options, streams.audio.channels);
  const encoded = await encodeToTemp(
    directory,
    ".webm",
    output => [
      // prettier-ignore
      "-y", "-i", source, "-vn", "-map_metadata", "-1",
      "-c:a", "libopus", "-b:a", bitrate, "-vbr", "on",
      "-f", "webm", output,
    ],
    `opus ${bitrate}`,
  );
  return encoded ? [encoded] : [];
}

/**
 * Encode video to VP9 plus Opus in WebM.
 *
 * Rule 3: VP9 alpha needs `-pix_fmt yuva420p`, and Safari does not play it, so
 * `yuv420p` is forced and a source with alpha loses the alpha channel.
 */
async function encodeVideo(
  source: string,
  directory: string,
  options: ResolvedOptions,
): Promise<Candidate[]> {
  const streams = await probe(source);
  if (!streams.video) throw new Error("no video stream was found");

  const audioIsTarget = !streams.audio || streams.audio.codec === "opus";
  // Rule 5: a VP9 source with Opus audio, or with no audio, is remuxed.
  if (streams.video.codec === "vp9" && audioIsTarget) {
    const remux = await encodeToTemp(
      directory,
      ".webm",
      output => [
        // prettier-ignore
        "-y", "-i", source, "-map", "0:v:0", "-map", "0:a:0?",
        "-map_metadata", "-1", "-c", "copy", "-f", "webm", output,
      ],
      "remux vp9 to webm",
    );
    return remux ? [remux] : [];
  }

  const audioArgs = streams.audio
    ? ["-c:a", "libopus", "-b:a", opusBitrate(options, streams.audio.channels), "-vbr", "on"]
    : ["-an"];
  const encoded = await encodeToTemp(
    directory,
    ".webm",
    output => [
      // prettier-ignore
      "-y", "-i", source, "-map", "0:v:0", "-map", "0:a:0?", "-map_metadata", "-1",
      "-c:v", "libvpx-vp9", "-crf", String(options.videoQuality), "-b:v", "0",
      "-row-mt", "1", "-pix_fmt", "yuv420p",
      ...audioArgs,
      "-f", "webm", output,
    ],
    `vp9 crf${options.videoQuality}`,
  );
  return encoded ? [encoded] : [];
}

/** Route one asset to the encoder its bytes call for. */
async function encodeCandidates(
  source: string,
  bytes: Uint8Array,
  directory: string,
  options: ResolvedOptions,
): Promise<Candidate[]> {
  const ext = extname(source).toLowerCase();

  if (IMAGE_EXTENSIONS.has(ext)) {
    const format = sniffImageFormat(bytes);
    // Rule 5: WebP is already the target format.
    if (format === "webp") return [];
    if (isAnimated(bytes, format)) return encodeAnimatedImage(source, directory, options);
    return encodeStillImage(source, bytes, directory, options);
  }

  if (VIDEO_EXTENSIONS.has(ext)) {
    // Rule 5: WebM is already the target format.
    if (ext === ".webm") return [];
    return encodeVideo(source, directory, options);
  }

  if (AUDIO_EXTENSIONS.has(ext)) return encodeAudio(source, directory, options);
  return [];
}

/**
 * Optimize one asset and return the file the bundler should emit.
 *
 * The result is cached under the content hash of the source plus the encode
 * options, so a rebuild never runs ffmpeg twice for the same bytes.
 */
export async function optimizeAsset(source: string, options: ResolvedOptions): Promise<OptimizeResult> {
  const bytes = new Uint8Array(await Bun.file(source).arrayBuffer());
  const sourceSize = bytes.byteLength;
  const name = basename(source, extname(source));
  const key = Bun.hash(bytes).toString(16) + "-" + Bun.hash(encodeKey(options) + name).toString(16);
  const directory = join(options.cacheDir, key);
  const record = join(directory, "result.json");

  if (!options.disableCache) {
    const cached = await Bun.file(record)
      .json()
      .catch(() => null);
    if (cached) {
      const hit = cached as CacheRecord;
      const path = hit.file ? join(directory, hit.file) : source;
      if (!hit.file || (await Bun.file(path).exists())) {
        return { path, sourceSize: hit.sourceSize, outputSize: hit.outputSize, reason: hit.reason };
      }
    }
  }

  await mkdir(directory, { recursive: true });
  let candidates: Candidate[] = [];
  let failure: string | null = null;
  try {
    candidates = await encodeCandidates(source, bytes, directory, options);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  // Rule 4: keep the smaller file. The source competes with every candidate,
  // unless `force` is set, and then the source only wins when there is no
  // candidate at all.
  let winner: Candidate | null = null;
  for (const candidate of candidates) {
    if (!options.force && candidate.size >= sourceSize) continue;
    if (!winner || candidate.size < winner.size) winner = candidate;
  }
  for (const candidate of candidates) {
    if (candidate !== winner) await rm(candidate.path, { force: true });
  }

  let result: OptimizeResult;
  let file: string | null = null;
  if (winner) {
    file = `${name}.${winner.path.split(".").pop()}`;
    await rename(winner.path, join(directory, file));
    const reason = winner.size >= sourceSize ? `${winner.reason}, forced` : winner.reason;
    result = { path: join(directory, file), sourceSize, outputSize: winner.size, reason };
  } else {
    const reason = failure
      ? `encode failed, kept source: ${failure}`
      : candidates.length > 0
        ? "kept source, it is smaller"
        : "kept source, already optimal";
    result = { path: source, sourceSize, outputSize: sourceSize, reason };
  }

  if (!options.disableCache) {
    const stored: CacheRecord = {
      file,
      sourceSize: result.sourceSize,
      outputSize: result.outputSize,
      reason: result.reason,
    };
    await Bun.write(record, JSON.stringify(stored));
  }
  return result;
}
