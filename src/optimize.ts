import { mkdir, rename, rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { judgeAnimation } from "./animation.ts";
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, isAnimated, sniffImageFormat } from "./detect.ts";
import { countFrames, decodeFrames, ffmpeg, probe, type Probe } from "./ffmpeg.ts";
import { encodeKey, type ResolvedOptions } from "./options.ts";
import { decodePng } from "./png.ts";
import { compare, describe, image, toPixels, withinGate, type Gate, type Pixels } from "./quality.ts";

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

/** What one encoder produced, and anything worth saying about the asset. */
interface Encoded {
  candidates: Candidate[];
  /** Reported whether or not a candidate won. Rejections live here. */
  note?: string;
}

/**
 * A decoded bitmap this large is worth mentioning even when it compresses well.
 * Bytes on the wire are not the cost of an oversized image: a 3911×4050 source
 * is 60 MB of resident bitmap and the decode time that goes with it, and it
 * still ships as 329 kB of WebP. `maxWidth` is the fix; this is the warning.
 */
const LARGE_DECODE = 16 * 1024 * 1024;

/**
 * How many of the source's frames a video encode must still decode to.
 *
 * Deliberately loose. A variable-frame-rate source encoded at a constant rate
 * legitimately changes its frame count, so demanding equality would refuse
 * correct encodes and keep the original file instead. The failure this catches
 * is not subtle: an encoder that writes 4 of 63 frames reports success and
 * produces a much smaller file. Re-timing is caught by the runtime check.
 */
const MIN_FRAME_RATIO = 0.5;

/**
 * How far an encode's runtime may drift from its source's, as a share and as a
 * floor in seconds.
 *
 * Also deliberately loose. Opus pads, and a VBR MP3 with no Xing header makes
 * ffmpeg estimate its own duration from the bitrate, so a few percent of drift
 * is ordinary. A truncated encode is not a few percent. A refusal here keeps
 * the source and says so in the log, which is the safe way to be wrong.
 */
const RUNTIME_DRIFT = 0.05;
const RUNTIME_FLOOR = 0.25;

/**
 * The ladder to walk, given whether the gate is measuring.
 *
 * With a gate, every step is a real candidate: they are ascending, so the first
 * one that passes is also the smallest. Without a gate there is nothing to
 * choose between steps — the smallest file would always win, which would pin
 * every asset to the bottom of the ladder — so only the best step is encoded.
 */
function ladderFor(options: ResolvedOptions, measuring: boolean): number[] {
  return measuring ? options.quality : [options.quality.at(-1)!];
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

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function tempPath(directory: string, extension: string): string {
  return join(directory, `tmp-${crypto.randomUUID()}${extension}`);
}

/** Encode to a unique temporary file, so two builds never share a partial write. */
async function encodeToTemp(
  directory: string,
  extension: string,
  args: (output: string) => string[],
  reason: string,
): Promise<Candidate | null> {
  const output = tempPath(directory, extension);
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
  const output = tempPath(directory, extension);
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
 * Measure one lossy candidate against the source and say whether it may ship.
 *
 * A candidate that cannot be decoded is refused rather than trusted. The gate
 * exists because file size does not describe a picture, so an unmeasurable
 * candidate is not a small win, it is an unknown.
 */
async function judgeStill(
  encoded: Uint8Array,
  reference: Pixels,
  gate: Gate,
  label: string,
): Promise<{ ok: true; reason: string } | { ok: false; why: string }> {
  const pixels = await toPixels(encoded).catch(() => null);
  const difference = pixels && compare(reference, pixels);
  if (!difference) return { ok: false, why: `${label} could not be measured` };
  if (!withinGate(difference, gate)) return { ok: false, why: `${label} ${describe(difference)}` };
  return { ok: true, reason: `${label} (${describe(difference)})` };
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
): Promise<Encoded> {
  // `-2` keeps the height even, which every WebP encoder path here wants.
  const scale = options.maxWidth ? ["-vf", `scale='min(${options.maxWidth},iw)':-2`] : [];
  const common = ["-y", "-i", source, "-map_metadata", "-1", "-frames:v", "1", ...scale, "-c:v", "libwebp"];

  // The gate needs the source as pixels, and `Bun.Image` is what refused it.
  // ffmpeg decodes it to a PNG instead, resampled the same way the candidates
  // are, so the comparison is against the picture that is actually shipping.
  let reference: Pixels | null = null;
  if (options.gate) {
    const png = tempPath(directory, ".png");
    const { ok } = await ffmpeg(["-y", "-i", source, "-frames:v", "1", ...scale, png]);
    if (ok) reference = decodePng(new Uint8Array(await Bun.file(png).bytes()));
    await rm(png, { force: true });
  }

  const gate = reference ? options.gate : null;
  const candidates: Candidate[] = [];
  const rejected: string[] = [];

  for (const quality of ladderFor(options, gate !== null)) {
    const label = `webp q${quality} via ffmpeg`;
    const candidate = await encodeToTemp(
      directory,
      ".webp",
      output => [...common, "-lossless", "0", "-q:v", String(quality), "-pix_fmt", "yuva420p", "-f", "webp", output],
      label,
    );
    if (!candidate) continue;
    if (!gate || !reference) {
      candidates.push(candidate);
      break;
    }
    const encoded = new Uint8Array(await Bun.file(candidate.path).bytes());
    const verdict = await judgeStill(encoded, reference, gate, label);
    if (verdict.ok) {
      candidates.push({ ...candidate, reason: verdict.reason });
      break;
    }
    rejected.push(verdict.why);
    await rm(candidate.path, { force: true });
  }

  if (options.tryLossless) {
    const lossless = await encodeToTemp(
      directory,
      ".webp",
      output => [...common, "-lossless", "1", "-pix_fmt", "bgra", "-f", "webp", output],
      "webp lossless via ffmpeg",
    );
    if (lossless) candidates.push(lossless);
  }

  return { candidates, note: candidates.length === 0 && rejected.length ? rejected.join("; ") : undefined };
}

/**
 * Encode a still image to WebP with `Bun.Image`.
 *
 * `Bun.Image` decodes from the bytes, so EXIF, GPS, and non-sRGB ICC profiles
 * never reach the output. `autoOrient` applies the EXIF orientation first.
 *
 * The ladder is walked from the smallest candidate up, and the first one inside
 * the gate wins. Lossless is encoded alongside it when asked for, because a
 * lossless WebP beats a lossy one on flat art often enough to be worth the
 * comparison, and because it is the floor under the gate: it carries no error,
 * so there is always something to ship.
 *
 * A format the OS codec owns falls back to ffmpeg.
 */
async function encodeStillImage(
  source: string,
  bytes: Uint8Array,
  directory: string,
  options: ResolvedOptions,
): Promise<Encoded> {
  let metadata: Bun.Image.Metadata;
  try {
    metadata = await image(bytes).metadata();
  } catch (error) {
    if (!isUnsupportedFormat(error)) throw error;
    return encodeStillImageWithFfmpeg(source, directory, options);
  }

  const notes: string[] = [];
  const cap = options.maxWidth && metadata.width > options.maxWidth ? options.maxWidth : null;
  if (cap) {
    notes.push(`${metadata.width}×${metadata.height} resampled to ${cap}px wide`);
  } else if (metadata.width * metadata.height * 4 > LARGE_DECODE) {
    // Not an error, and not something a byte count can see. Say it anyway.
    notes.push(`${metadata.width}×${metadata.height} decodes to ${megabytes(metadata.width * metadata.height * 4)}`);
  }

  const encode = (settings: { quality?: number; lossless?: boolean }): Promise<Uint8Array> => {
    const pipeline = image(bytes);
    if (cap) pipeline.resize(cap);
    return pipeline.webp(settings).bytes();
  };

  // What every candidate is measured against: the source, resampled exactly
  // the way the candidates are. A shipped file is judged against the picture it
  // is meant to be, so the cap is a resolution decision made once, here.
  let reference: Pixels | null = null;
  if (options.gate) {
    reference = await toPixels(bytes, cap ?? undefined);
    if (!reference) notes.push("the source could not be measured, so the gate was skipped");
  }

  const gate = reference ? options.gate : null;
  const candidates: Candidate[] = [];
  const rejected: string[] = [];

  for (const quality of ladderFor(options, gate !== null)) {
    const label = `webp q${quality}`;
    const encoded = await encode({ quality });
    if (!gate || !reference) {
      candidates.push(await writeTemp(directory, ".webp", encoded, label));
      break;
    }
    const verdict = await judgeStill(encoded, reference, gate, label);
    if (verdict.ok) {
      candidates.push(await writeTemp(directory, ".webp", encoded, verdict.reason));
      break;
    }
    rejected.push(verdict.why);
  }

  if (options.tryLossless) {
    const encoded = await encode({ lossless: true });
    candidates.push(await writeTemp(directory, ".webp", encoded, "webp lossless"));
  }

  if (candidates.length === 0 && rejected.length) notes.push(rejected.join("; "));
  return { candidates, note: notes.length ? notes.join(", ") : undefined };
}

/**
 * Encode an animated image to animated WebP with ffmpeg, and prove the result
 * is still the same animation.
 *
 * `-pix_fmt bgra` keeps the alpha channel and is what `libwebp_anim` wants.
 * `yuva420p` loses the alpha and produces a larger file.
 *
 * Every candidate is judged, lossless included. Frame merging is a property of
 * the encoder, not of the quality setting, so a lossless encode can lose the
 * animation just as a lossy one can. See `judgeAnimation`.
 */
async function encodeAnimatedImage(
  source: string,
  directory: string,
  options: ResolvedOptions,
): Promise<Encoded> {
  const common = ["-y", "-i", source, "-map_metadata", "-1", "-c:v", "libwebp_anim", "-loop", "0", "-pix_fmt", "bgra"];
  const gate = options.gate;

  const ladder: Array<{ label: string; lossless: boolean; args: string[] }> = ladderFor(options, gate !== null).map(
    quality => ({
      label: `animated webp q${quality}`,
      lossless: false,
      args: ["-lossless", "0", "-q:v", String(quality)],
    }),
  );
  if (options.tryLossless) {
    ladder.push({ label: "animated webp lossless", lossless: true, args: ["-lossless", "1"] });
  }

  const encodeStep = (args: string[], label: string): Promise<Candidate | null> =>
    encodeToTemp(directory, ".webp", output => [...common, ...args, "-f", "webp", output], label);

  if (!gate) {
    const candidates: Candidate[] = [];
    for (const { label, args } of ladder) {
      const candidate = await encodeStep(args, label);
      if (candidate) candidates.push(candidate);
    }
    return { candidates };
  }

  const frames = join(directory, `frames-${crypto.randomUUID()}`);
  await mkdir(frames, { recursive: true });
  const candidates: Candidate[] = [];
  const rejected: string[] = [];

  try {
    const decoded = await decodeFrames(source, frames);
    if (decoded.files.length === 0) return { candidates: [], note: "the source decoded to no frames" };

    let accepted = false;
    for (const { label, lossless, args } of ladder) {
      // The lossy steps ascend, so the first one that passes is also the
      // smallest and the rest are not worth judging. Lossless is encoded
      // anyway, and the caller keeps whichever file is smaller.
      if (!lossless && accepted) continue;

      const candidate = await encodeStep(args, label);
      if (!candidate) continue;

      const encoded = new Uint8Array(await Bun.file(candidate.path).bytes());
      const verdict = await judgeAnimation(encoded, decoded.files, decoded.durations, gate);
      if (verdict.ok) {
        candidates.push({ ...candidate, reason: `${label} (${describe(verdict.worst)})` });
        if (!lossless) accepted = true;
        continue;
      }
      rejected.push(`${label} ${verdict.why}`);
      await rm(candidate.path, { force: true });
    }
  } finally {
    await rm(frames, { recursive: true, force: true });
  }

  // A rejection list under a winning candidate is noise. Above one it is the answer.
  return { candidates, note: candidates.length === 0 && rejected.length ? rejected.join("; ") : undefined };
}

/**
 * Whether an encode still holds the same footage.
 *
 * ffmpeg reports success on an encode that dropped most of its frames, so the
 * only proof is a decode of the result. WebM alpha is why the decoder is named:
 * the native `vp9` decoder cannot see Matroska's alpha side data and presents
 * even a good file as opaque.
 */
async function verifyEncode(
  source: string,
  output: string,
  before: Probe,
  video: boolean,
): Promise<{ ok: true; note: string } | { ok: false; why: string }> {
  const after = await probe(output);

  if (before.duration !== undefined && after.duration !== undefined) {
    const drift = Math.abs(after.duration - before.duration);
    if (drift > Math.max(RUNTIME_FLOOR, before.duration * RUNTIME_DRIFT)) {
      return { ok: false, why: `runtime ${after.duration.toFixed(2)}s against ${before.duration.toFixed(2)}s` };
    }
  }

  if (!video) return { ok: true, note: "runtime verified" };

  const [sourceFrames, outputFrames] = await Promise.all([countFrames(source), countFrames(output, "libvpx-vp9")]);
  if (outputFrames === 0) return { ok: false, why: "the result decoded no frames" };
  if (sourceFrames > 0 && outputFrames < sourceFrames * MIN_FRAME_RATIO) {
    return { ok: false, why: `decoded ${outputFrames} of ${sourceFrames} frames` };
  }
  return { ok: true, note: `${outputFrames} frames verified` };
}

/** Keep a verified candidate, or throw the file away and say why. */
async function verified(
  candidate: Candidate | null,
  source: string,
  before: Probe,
  video: boolean,
): Promise<Encoded> {
  if (!candidate) return { candidates: [] };
  const verdict = await verifyEncode(source, candidate.path, before, video);
  if (!verdict.ok) {
    await rm(candidate.path, { force: true });
    return { candidates: [], note: `${candidate.reason} rejected — ${verdict.why}` };
  }
  return { candidates: [candidate], note: verdict.note };
}

async function encodeAudio(source: string, directory: string, options: ResolvedOptions): Promise<Encoded> {
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
    return verified(remux, source, streams, false);
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
  return verified(encoded, source, streams, false);
}

/**
 * Encode video to VP9 plus Opus in WebM.
 *
 * Rule 3: VP9 alpha needs `-pix_fmt yuva420p`, and Safari does not play it, so
 * `yuv420p` is forced and a source with alpha loses the alpha channel.
 */
async function encodeVideo(source: string, directory: string, options: ResolvedOptions): Promise<Encoded> {
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
    return verified(remux, source, streams, true);
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
  return verified(encoded, source, streams, true);
}

/** Route one asset to the encoder its bytes call for. */
async function encodeCandidates(
  source: string,
  bytes: Uint8Array,
  directory: string,
  options: ResolvedOptions,
): Promise<Encoded> {
  const ext = extname(source).toLowerCase();

  if (IMAGE_EXTENSIONS.has(ext)) {
    const format = sniffImageFormat(bytes);
    // Rule 5: WebP is already the target format.
    if (format === "webp") return { candidates: [] };
    if (isAnimated(bytes, format)) return encodeAnimatedImage(source, directory, options);
    return encodeStillImage(source, bytes, directory, options);
  }

  if (VIDEO_EXTENSIONS.has(ext)) {
    // Rule 5: WebM is already the target format.
    if (ext === ".webm") return { candidates: [] };
    return encodeVideo(source, directory, options);
  }

  if (AUDIO_EXTENSIONS.has(ext)) return encodeAudio(source, directory, options);
  return { candidates: [] };
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
  let encoded: Encoded = { candidates: [] };
  let failure: string | null = null;
  try {
    encoded = await encodeCandidates(source, bytes, directory, options);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    // An encoder that threw part way through the ladder leaves its earlier
    // candidates behind, and nothing else knows their names. The cache
    // directory belongs to this one asset, so anything still called `tmp-` in
    // it is rubbish.
    for (const name of new Bun.Glob("tmp-*").scanSync(directory)) {
      await rm(join(directory, name), { force: true });
    }
  }

  // Rule 4: keep the smaller file. The source competes with every candidate,
  // unless `force` is set, and then the source only wins when there is no
  // candidate at all.
  let winner: Candidate | null = null;
  for (const candidate of encoded.candidates) {
    if (!options.force && candidate.size >= sourceSize) continue;
    if (!winner || candidate.size < winner.size) winner = candidate;
  }
  for (const candidate of encoded.candidates) {
    if (candidate !== winner) await rm(candidate.path, { force: true });
  }

  const explain = (...parts: Array<string | null | undefined>): string => parts.filter(Boolean).join("; ");

  let result: OptimizeResult;
  let file: string | null = null;
  if (winner) {
    file = `${name}.${winner.path.split(".").pop()}`;
    await rename(winner.path, join(directory, file));
    const forced = winner.size >= sourceSize ? `${winner.reason}, forced` : winner.reason;
    result = {
      path: join(directory, file),
      sourceSize,
      outputSize: winner.size,
      reason: explain(forced, encoded.note),
    };
  } else {
    const kept = failure
      ? `encode failed, kept source: ${failure}`
      : encoded.candidates.length > 0
        ? "kept source, it is smaller"
        : "kept source, already optimal";
    result = { path: source, sourceSize, outputSize: sourceSize, reason: explain(kept, encoded.note) };
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
