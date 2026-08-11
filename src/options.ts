import { join } from "node:path";

export interface OptimizeOptions {
  /**
   * WebP quality for still and animated images, 1 to 100.
   * @default 80
   */
  quality?: number;
  /**
   * Also encode a lossless WebP and keep the smaller of the two files.
   * Lossless wins on flat art, screenshots, and logos. It loses on
   * photographs, and it doubles the encode time.
   * @default true
   */
  tryLossless?: boolean;
  /**
   * VP9 constant quality, 0 to 63. A lower number is better quality.
   * @default 36
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

export interface ResolvedOptions extends Required<Omit<OptimizeOptions, "audioBitrate">> {
  audioBitrate?: string;
}

/** Bumped when an encode setting changes, so old cache entries are ignored. */
export const CACHE_VERSION = 1;

export function resolveOptions(options: OptimizeOptions = {}): ResolvedOptions {
  return {
    quality: options.quality ?? 80,
    tryLossless: options.tryLossless ?? true,
    videoQuality: options.videoQuality ?? 36,
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
    tryLossless: options.tryLossless,
    videoQuality: options.videoQuality,
    audioBitrate: options.audioBitrate ?? null,
    force: options.force,
  });
}
