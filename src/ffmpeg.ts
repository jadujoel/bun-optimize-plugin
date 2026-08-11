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

export interface Probe {
  /** The demuxer ffmpeg chose, for example `matroska,webm` or `png_pipe`. */
  container?: string;
  /** The first video stream that is footage. Cover art is not footage. */
  video?: { codec: string };
  audio?: AudioStream;
  /** True when the file carries a still picture as an attachment. */
  coverArt?: boolean;
  /** Runtime in seconds, or undefined when the container does not say. */
  duration?: number;
}

const INPUT_LINE = /^Input #\d+, (.+?), from /m;
const STREAM_LINE = /Stream #\d+:\d+[^:]*: (Audio|Video): ([A-Za-z0-9_]+)/;
const DURATION_LINE = /Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/;

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
  for (const line of stderr.split("\n")) {
    const match = line.match(STREAM_LINE);
    if (!match) continue;
    const [, type, codec] = match as unknown as [string, "Audio" | "Video", string];
    if (type === "Video" && line.includes("(attached pic)")) result.coverArt = true;
    else if (type === "Video" && !result.video) result.video = { codec };
    if (type === "Audio" && !result.audio) result.audio = { codec, channels: channelsOf(line) };
  }
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
