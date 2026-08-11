import type { BunPlugin } from "bun";
import { isAbsolute, relative, resolve } from "node:path";
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from "./src/detect.ts";
import { resolveOptions, type OptimizeOptions } from "./src/options.ts";
import { optimizeAsset, type OptimizeResult } from "./src/optimize.ts";

export type { OptimizeOptions } from "./src/options.ts";
export type { OptimizeResult } from "./src/optimize.ts";
export { ffmpegPath } from "./src/ffmpeg.ts";
export { isAnimated, sniffImageFormat } from "./src/detect.ts";
export { optimizeAsset } from "./src/optimize.ts";

const EXTENSIONS = [...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS];
const FILTER = new RegExp(`\\.(${EXTENSIONS.map(ext => ext.slice(1)).join("|")})$`, "i");

/** Import kinds that point at an asset. An entry point is never rewritten. */
const ASSET_KINDS = new Set(["internal", "import-statement", "dynamic-import", "require-call", "url-token"]);

function format(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The size change as a signed percentage. `force` can make a file grow. */
function delta(sourceSize: number, outputSize: number): string {
  if (sourceSize === 0) return "0%";
  const percent = Math.round(((outputSize - sourceSize) / sourceSize) * 100);
  return `${percent > 0 ? "+" : ""}${percent}%`;
}

/** Run at most `limit` jobs at the same time. ffmpeg is not cheap. */
function createGate(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function gate<T>(job: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>(release => waiting.push(release));
    active++;
    try {
      return await job();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/**
 * A Bun bundler plugin that re-encodes images, audio, and video.
 *
 * Images become WebP, audio and video become WebM. The plugin rewrites the
 * resolved path of every matching import, so the emitted file carries the new
 * extension and every `<img>`, `<video>`, and `<audio>` tag in an HTML entry
 * point points at the optimized file.
 */
export function optimizePlugin(options: OptimizeOptions = {}): BunPlugin {
  const resolved = resolveOptions(options);
  return {
    name: "optimize-plugin",
    target: "bun",
    setup(build) {
      const gate = createGate(resolved.concurrency);
      const inFlight = new Map<string, Promise<OptimizeResult>>();
      const done = new Map<string, OptimizeResult>();

      build.onStart(() => {
        inFlight.clear();
        done.clear();
      });

      build.onResolve({ filter: FILTER, namespace: "file" }, async args => {
        if (!ASSET_KINDS.has(args.kind)) return undefined;
        if (!args.path.startsWith(".") && !isAbsolute(args.path)) return undefined;

        const source = isAbsolute(args.path) ? args.path : resolve(args.resolveDir, args.path);
        if (!(await Bun.file(source).exists())) return undefined;

        let pending = inFlight.get(source);
        if (!pending) {
          pending = gate(() => optimizeAsset(source, resolved)).then(result => {
            done.set(source, result);
            if (resolved.verbose) {
              console.log(
                `optimize  ${relative(process.cwd(), source)}  ` +
                  `${format(result.sourceSize)} -> ${format(result.outputSize)} ` +
                  `(${delta(result.sourceSize, result.outputSize)})  ${result.reason}`,
              );
            }
            return result;
          });
          inFlight.set(source, pending);
        }

        const result = await pending.catch(error => {
          console.warn(`optimize-plugin: ${source} was copied unchanged. ${error}`);
          return null;
        });
        if (!result || result.path === source) return undefined;
        return { path: result.path };
      });

      build.onEnd?.(() => {
        if (!resolved.verbose || done.size === 0) return;
        let sourceTotal = 0;
        let outputTotal = 0;
        for (const result of done.values()) {
          sourceTotal += result.sourceSize;
          outputTotal += result.outputSize;
        }
        console.log(
          `optimize  ${done.size} assets  ${format(sourceTotal)} -> ${format(outputTotal)} ` +
            `(${delta(sourceTotal, outputTotal)})`,
        );
      });
    },
  };
}

/** The plugin with the default options. */
export const OptimizePlugin: BunPlugin = optimizePlugin();
