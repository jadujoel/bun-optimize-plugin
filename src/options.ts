import { join } from "node:path";
import { DEFAULT_GATE, type Gate } from "./quality.ts";

export interface OptimizeOptions {
  /**
   * WebP qualities to try for still and animated images, 1 to 100.
   *
   * This is a ladder, not a setting. Every step is encoded, decoded again, and
   * measured against the source, and the smallest one that stays inside `gate`
   * wins. So `gate` decides the quality and this decides where the encoder is
   * allowed to look.
   *
   * A single number pins the ladder to one step. That step is still measured,
   * so a quality the gate refuses falls back to lossless or to the source. Set
   * `gate: false` to pin a quality unconditionally; with no gate there is
   * nothing to choose between steps, so the highest one is used.
   * @default [92, 88, 82]
   */
  quality?: number | number[];
  /**
   * How much error a lossy candidate may carry before it is thrown away, as a
   * root-mean-square error and a 99.9th-percentile channel error over
   * alpha-premultiplied RGBA. `false` turns the measurement off and picks
   * purely by file size.
   *
   * The default was verified by eye on photographic artwork at 1:1. Flat art,
   * screenshots, and logos want `STRICT_GATE`, which ships more bytes and
   * refuses posterisation on a gradient.
   * @default { rmse: 4, p999: 44 }
   */
  gate?: Gate | false;
  /**
   * Also encode a lossless WebP and keep the smaller of the two files.
   * Lossless wins on flat art, screenshots, and logos. It loses on
   * photographs, and it doubles the encode time.
   *
   * It is also the floor under the gate: a lossless candidate carries no error,
   * so it always passes. With this off, an image whose every lossy candidate is
   * refused keeps its source.
   * @default true
   */
  tryLossless?: boolean;
  /**
   * Resample any still image wider than this before encoding it, keeping the
   * aspect ratio. Off by default, because resampling changes the picture.
   *
   * Worth setting. A 3911 px background for a 920 px layout compresses to
   * 329 kB, so no byte count ever complains about it, and it still costs
   * 60 MB of resident bitmap and the decode time that goes with it. An image
   * over the cap is reported in the verbose log even when this is off.
   *
   * Animations are never resampled.
   */
  maxWidth?: number;
  /**
   * VP9 constant quality, 0 to 63. A lower number is better quality.
   *
   * 32 is where the size-against-SSIM curve stops paying on real footage:
   * crf 24 is 800 kB at SSIM 0.9981 and crf 32 is 486 kB at 0.9967, while
   * crf 36 gives up more than it saves.
   * @default 32
   */
  videoQuality?: number;
  /**
   * Opus bitrate, for example `"96k"`. The default follows the channel count:
   * 48k for mono, 96k for stereo, 128k above that.
   */
  audioBitrate?: string;
  /**
   * Emit the converted file even when it is larger than the source, so every
   * image is a WebP and every audio and video file is a WebM. This turns off
   * the "keep the smaller file" rule.
   *
   * A source that is already WebP or WebM still passes through untouched. It
   * is already in the target format, so there is nothing to convert.
   * @default false
   */
  force?: boolean;
  /**
   * Directory for the content-hash cache.
   * @default "node_modules/.cache/bun-optimize-plugin"
   */
  cacheDir?: string;
  /**
   * Read the cache but never write it.
   * @default false
   */
  disableCache?: boolean;
  /**
   * Print one line per asset, and a summary at the end of the build.
   * @default false
   */
  verbose?: boolean;
  /**
   * Maximum number of encode jobs that run at the same time.
   * @default the CPU count
   */
  concurrency?: number;
}

export interface ResolvedOptions {
  /** The ladder, always ascending, so the smallest candidate is tried first. */
  quality: number[];
  gate: Gate | null;
  tryLossless: boolean;
  maxWidth: number | null;
  videoQuality: number;
  audioBitrate?: string;
  force: boolean;
  cacheDir: string;
  disableCache: boolean;
  verbose: boolean;
  concurrency: number;
}

/** Bumped when an encode setting changes, so old cache entries are ignored. */
export const CACHE_VERSION = 2;

/** The ladder the gate walks when nothing else is asked for. */
export const DEFAULT_QUALITY = [92, 88, 82];

function ladder(quality: OptimizeOptions["quality"]): number[] {
  const steps = quality === undefined ? DEFAULT_QUALITY : typeof quality === "number" ? [quality] : quality;
  if (steps.length === 0) throw new Error("bun-optimize-plugin: quality must name at least one step.");
  return [...steps].sort((a, b) => a - b);
}

export function resolveOptions(options: OptimizeOptions = {}): ResolvedOptions {
  return {
    quality: ladder(options.quality),
    gate: options.gate === false ? null : (options.gate ?? DEFAULT_GATE),
    tryLossless: options.tryLossless ?? true,
    maxWidth: options.maxWidth ?? null,
    videoQuality: options.videoQuality ?? 32,
    audioBitrate: options.audioBitrate,
    force: options.force ?? false,
    cacheDir: options.cacheDir ?? join(process.cwd(), "node_modules", ".cache", "bun-optimize-plugin"),
    disableCache: options.disableCache ?? false,
    verbose: options.verbose ?? false,
    concurrency: options.concurrency ?? navigator.hardwareConcurrency ?? 4,
  };
}

/** The part of the options that changes the bytes of an output file. */
export function encodeKey(options: ResolvedOptions): string {
  return JSON.stringify({
    version: CACHE_VERSION,
    quality: options.quality,
    gate: options.gate,
    tryLossless: options.tryLossless,
    maxWidth: options.maxWidth,
    videoQuality: options.videoQuality,
    audioBitrate: options.audioBitrate ?? null,
    force: options.force,
  });
}
