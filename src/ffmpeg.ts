/**
 * The bundled ffmpeg binary.
 *
 * Rule 8 of intent.md: use the `ffmpeg-helper` binary, not a system `ffmpeg`.
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
  video?: { codec: string };
  audio?: AudioStream;
}

const STREAM_LINE = /Stream #\d+:\d+[^:]*: (Audio|Video): ([A-Za-z0-9_]+)/;

function channelsOf(line: string): number {
  if (/\bmono\b/.test(line)) return 1;
  if (/\bstereo\b/.test(line)) return 2;
  const match = line.match(/\b(\d+) channels\b/);
  return match ? Number(match[1]) : 2;
}

/**
 * Read the first audio and video stream of a file.
 *
 * ffmpeg exits with a non-zero code because no output file is given, so the
 * exit code is ignored and only stderr is parsed.
 */
export async function probe(file: string): Promise<Probe> {
  const { stderr } = await ffmpeg(["-i", file]);
  const result: Probe = {};
  for (const line of stderr.split("\n")) {
    const match = line.match(STREAM_LINE);
    if (!match) continue;
    const [, type, codec] = match as unknown as [string, "Audio" | "Video", string];
    if (type === "Video" && !result.video) result.video = { codec };
    if (type === "Audio" && !result.audio) result.audio = { codec, channels: channelsOf(line) };
  }
  return result;
}
