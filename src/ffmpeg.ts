/**
 * The bundled ffmpeg binary.
 *
 * Rule 11 of intent.md: use the `ffmpeg-helper` binary, not a system `ffmpeg`.
 * The `path` export of `ffmpeg-helper` is resolved against the current working
 * directory, so it is wrong whenever the build runs from a subdirectory. Only
 * the binary table is imported here, and the package directory is resolved
 * from this module instead.
 */

import { architecture, binaries, isSupportedArchitecture, isSupportedPlatform, platf } from "ffmpeg-helper";
import { dirname, join } from "node:path";


if (!isSupportedPlatform(platf) || !isSupportedArchitecture(architecture)) {
  throw new Error(`bun-optimize-plugin: ffmpeg has no binary for ${platf}-${architecture}.`);
}

/** Absolute path to the bundled ffmpeg binary for this platform. */
export const ffmpegPath = join(
  dirname(Bun.resolveSync("ffmpeg-helper/package.json", import.meta.dir)),
  binaries[platf][architecture],
);

export interface FfmpegResult {
  ok: boolean;
  stderr: string;
}

/** Run ffmpeg and collect stderr. ffmpeg writes every diagnostic to stderr. */
export async function ffmpeg(args: string[]): Promise<FfmpegResult> {
  const proc = Bun.spawn([ffmpegPath, "-hide_banner", "-nostdin", ...args], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { ok: code === 0, stderr };
}

export interface AudioStream {
  codec: string;
  channels: number;
}

export interface VideoStream {
  codec: string;
  /**
   * The pixel format the decoder presents, for example `yuv420p` or
   * `yuva444p12le`. Undefined when the stream line does not name one.
   *
   * This is the decoder's output format and not always the container's. A GIF
   * reports `bgra` and never `pal8`, and a WebM holding VP9 alpha reports
   * `yuv420p`. See `carriesAlpha`.
   */
  pixelFormat?: string;
}

export interface Probe {
  /** The demuxer ffmpeg chose, for example `matroska,webm` or `png_pipe`. */
  container?: string;
  /** The first video stream that is footage. Cover art is not footage. */
  video?: VideoStream;
  audio?: AudioStream;
  /**
   * How many audio streams the file holds. Only the first one is ever encoded,
   * so a file with more than one loses the rest and the log has to say so.
   */
  audioTracks?: number;
  /** True when the file carries a still picture as an attachment. */
  coverArt?: boolean;
  /** Runtime in seconds, or undefined when the container does not say. */
  duration?: number;
}

const INPUT_LINE = /^Input #\d+, (.+?), from /m;
const STREAM_LINE = /Stream #\d+:\d+[^:]*: (Audio|Video): ([A-Za-z0-9_]+)/;
const DURATION_LINE = /Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/;
const PIXEL_FORMAT = /^[a-z][a-z0-9]*$/;

/**
 * Pixel formats that carry an alpha channel.
 *
 * `yuva` and `gbrap` cover the planar families, including every bit depth.
 * `ya8` and `ya16le` are grey plus alpha. The four packed permutations are what
 * a PNG, a TGA, or a GIF decodes to. `rgba64` and `bgra64` start with those
 * same four letters, so the prefix test covers them too.
 */
const ALPHA_FORMATS = /^(yuva|gbrap|ya8|ya16|rgba|argb|abgr|bgra)/;

/**
 * The pixel format from an ffmpeg video stream line.
 *
 * The format is the field after the codec, and the codec field carries its own
 * parenthesised profile and tag: `Video: prores (4444) (ap4h / 0x68347061),
 * yuva444p12le(tv, progressive), 320x240`. The format's own parentheses hold a
 * comma, so the fields after it are fragments and only the early ones are
 * worth reading. Each candidate is checked against the shape of a format name,
 * which is what stops `320x240` or a bitrate from being read as one.
 */
export function pixelFormatOf(line: string): string | undefined {
  const marker = line.indexOf(": Video: ");
  if (marker === -1) return undefined;
  const fields = line.slice(marker + ": Video: ".length).split(",");
  for (const field of fields.slice(1, 4)) {
    const name = field.trim().split("(")[0]!.trim();
    if (PIXEL_FORMAT.test(name)) return name;
  }
  return undefined;
}

/**
 * True when `format` can hold an alpha channel at all.
 *
 * Capability, not use. A ProRes 4444 export routinely carries a fully opaque
 * alpha channel, and dropping that one costs nothing. `alphaMinimum` is what
 * separates the two.
 */
export function carriesAlpha(format: string | undefined): boolean {
  return format !== undefined && ALPHA_FORMATS.test(format);
}

/** The alpha value of a fully opaque pixel, on the 8-bit scale `alphaMinimum` reports. */
export const OPAQUE_ALPHA = 255;

/**
 * The lowest alpha value anywhere in `file`, from 0 to 255.
 *
 * `undefined` means the measurement did not run, and for this filter chain that
 * is the same answer as "there is no alpha channel": `alphaextract` refuses a
 * frame it cannot take an alpha plane from and the whole run fails with
 * `Failed to inject frame into filter network`. A caller that already knows the
 * source declares an alpha channel should read `undefined` as a failure, and
 * one that is guessing should read it as an absence. See `alphaPlan`.
 *
 * `format=gray` is not optional. Without it a 12-bit source reports its minimum
 * on a 16-bit scale, and 65328 against a maximum that moves with the bit depth
 * is not a number anything can compare.
 *
 * `decoder` matters for the same reason it matters to `countFrames`: Matroska
 * keeps a VP9 alpha plane in side data that only `libvpx-vp9` reads.
 */
export async function alphaMinimum(file: string, decoder?: string): Promise<number | undefined> {
  const flags = decoder ? ["-c:v", decoder] : [];
  const { stderr } = await ffmpeg([
    ...flags,
    "-i",
    file,
    "-vf",
    "alphaextract,format=gray,signalstats,metadata=print:key=lavfi.signalstats.YMIN",
    "-f",
    "null",
    "-",
  ]);
  // Reduced rather than spread into `Math.min`, because a long clip reports one
  // line per frame and an argument list is not the place to put 18000 of them.
  let lowest: number | undefined;
  for (const match of stderr.matchAll(/lavfi\.signalstats\.YMIN=(\d+)/g)) {
    const value = Number(match[1]);
    if (lowest === undefined || value < lowest) lowest = value;
  }
  return lowest;
}

/**
 * Demuxers that only ever read one picture.
 *
 * ffmpeg presents a still image as a video stream, so nothing in a stream list
 * separates a TGA from a one-second clip. The demuxer does: every still format
 * arrives through a `_pipe` demuxer, through `image2`, or through `ico`. This
 * is what stops a renamed video from shipping as a single WebP frame, and what
 * stops a TGA from shipping as a WebM.
 */
export function isStillContainer(container: string | undefined): boolean {
  if (!container) return false;
  return container.endsWith("_pipe") || container === "image2" || container === "ico";
}

function channelsOf(line: string): number {
  if (/\bmono\b/.test(line)) return 1;
  if (/\bstereo\b/.test(line)) return 2;
  const match = line.match(/\b(\d+) channels\b/);
  return match ? Number(match[1]) : 2;
}

/** Seconds from an ffmpeg `Duration:` line. `Duration: N/A` gives undefined. */
export function reportDuration(report: string): number | undefined {
  const match = report.match(DURATION_LINE);
  if (!match) return undefined;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/**
 * How many frames ffmpeg decoded, from the last progress line of its report.
 *
 * This is the number the encode gate turns on. An encoder that writes 4 of 63
 * frames reports success and produces a much smaller file, so nothing but a
 * decode of the result catches it.
 */
export function framesDecoded(report: string): number {
  const matches = [...report.matchAll(/frame=\s*(\d+)/g)];
  return matches.length ? Number(matches.at(-1)![1]) : 0;
}

/**
 * Decode `file` to nothing and count the frames.
 *
 * `decoder` matters for WebM alpha: only `libvpx-vp9` reads the alpha side
 * data, and the native `vp9` decoder presents even a good file as opaque.
 */
export async function countFrames(file: string, decoder?: string): Promise<number> {
  const flags = decoder ? ["-c:v", decoder] : [];
  const { stderr } = await ffmpeg([...flags, "-i", file, "-f", "null", "-"]);
  return framesDecoded(stderr);
}

/**
 * Read the container, the first audio and video stream, and the runtime.
 *
 * ffmpeg exits with a non-zero code because no output file is given, so the
 * exit code is ignored and only stderr is parsed.
 *
 * A video stream marked `(attached pic)` is cover art, not footage. An MP3 or
 * an M4A with album art carries one, and routing it as video would encode the
 * artwork as a one-frame film and throw the music away.
 */
export async function probe(file: string): Promise<Probe> {
  const { stderr } = await ffmpeg(["-i", file]);
  const result: Probe = { container: stderr.match(INPUT_LINE)?.[1], duration: reportDuration(stderr) };
  let audioTracks = 0;
  for (const line of stderr.split("\n")) {
    const match = line.match(STREAM_LINE);
    if (!match) continue;
    const [, type, codec] = match as unknown as [string, "Audio" | "Video", string];
    if (type === "Video" && line.includes("(attached pic)")) result.coverArt = true;
    else if (type === "Video" && !result.video) result.video = { codec, pixelFormat: pixelFormatOf(line) };
    if (type === "Audio") {
      audioTracks++;
      if (!result.audio) result.audio = { codec, channels: channelsOf(line) };
    }
  }
  if (audioTracks) result.audioTracks = audioTracks;
  return result;
}

export interface DecodedFrames {
  /** One full-canvas PNG per frame, in order. */
  files: string[];
  /** How long each frame stays on screen, in milliseconds. */
  durations: number[];
}

/**
 * Decode an animation to one full-canvas PNG per frame.
 *
 * ffmpeg applies the dispose and blend rules before the frames reach disk, so
 * each file is what is on screen at that moment. `-vsync 0` keeps every source
 * frame instead of resampling to a fixed rate, which for a variable-delay GIF
 * or APNG would silently drop or duplicate frames.
 *
 * The timeline comes from `showinfo`, not from the container. That is
 * deliberate: it is the timeline the encoder was handed, so a gate built on it
 * compares two views of the same decode rather than a decode against a parse.
 * ffmpeg 5.0.1 prints no per-frame duration, so each frame lasts until the next
 * one starts, and the last frame borrows the runtime or the previous gap.
 */
export async function decodeFrames(file: string, into: string): Promise<DecodedFrames> {
  const { stderr } = await ffmpeg(["-i", file, "-vsync", "0", "-vf", "showinfo", join(into, "%05d.png")]);
  const times = [...stderr.matchAll(/pts_time:([0-9.]+)/g)].map(match => Number(match[1]) * 1000);
  const files = [...new Bun.Glob("*.png").scanSync(into)].sort().map(name => join(into, name));

  const durations: number[] = [];
  for (let index = 0; index < times.length - 1; index++) {
    durations.push(times[index + 1]! - times[index]!);
  }
  if (times.length) {
    const total = reportDuration(stderr);
    const last = times.at(-1)!;
    // A runtime the container reports is exact. Without one, the last frame is
    // assumed to be as long as the one before it, which is right for every
    // constant-rate animation and close enough for the rest.
    durations.push(total !== undefined && total * 1000 > last ? total * 1000 - last : (durations.at(-1) ?? 100));
  }
  return { files, durations };
}
