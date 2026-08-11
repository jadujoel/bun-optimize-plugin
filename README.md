# @jadujoel/bun-optimize-plugin

A Bun build plugin that optimizes the assets in your bundle. Images become
WebP. Audio and video become WebM. Everything else is copied unchanged.

The plugin rewrites the resolved path of each asset import, so the emitted file
carries the new extension and every `<img>`, `<video>`, `<audio>`, `<link>`,
and `import` points at the optimized file. Nothing in your source changes.

```html
<!-- you write this -->
<img src="./assets/logo.png" />
<video src="./assets/clip.mov"></video>
```

```html
<!-- the build emits this -->
<img src="./logo-gy9ecr02.webp" />
<video src="./clip-2yapf8wf.webm"></video>
```

## Install

```sh
bun add @jadujoel/bun-optimize-plugin
```

The `ffmpeg` binary ships with the `ffmpeg-helper` dependency. No system
`ffmpeg` is used.

## Usage

```ts
import { optimizePlugin } from "@jadujoel/bun-optimize-plugin";

await Bun.build({
  entrypoints: ["./index.html"],
  plugins: [optimizePlugin({ verbose: true })],
  outdir: "dist",
});
```

`OptimizePlugin` is the same plugin with the default options.

```ts
import { OptimizePlugin } from "@jadujoel/bun-optimize-plugin";
```

## Formats

| Input                                                        | Output           | Encoder                        |
| ------------------------------------------------------------ | ---------------- | ------------------------------ |
| Audio (`.wav .mp3 .m4a .ogg .caf .opus`)                       | `.webm`          | Opus, `libopus`                |
| Video (`.mov .mp4 .webm .mkv`)                                 | `.webm`          | VP9 and Opus, `libvpx-vp9`     |
| Animated image (`.gif`, animated `.apng` or `.webp`)           | `.webp`          | animated WebP, `libwebp_anim`  |
| Still image (`.png .jpg .jpeg .webp .avif .heic .bmp .tiff`)   | `.webp`          | WebP, `Bun.Image`              |
| Anything else                                                  | copied unchanged | —                              |

There are two output formats, `.webp` and `.webm`. One asset produces one file.
There is no second output file and no alternative codec behind an option.

## Rules

1. **Animation is detected from the bytes.** `Bun.Image` decodes a `.gif` or an
   `.apng` as a single frame and drops the animation without an error, so the
   plugin checks the GIF image descriptors, the PNG `acTL` chunk, and the WebP
   `ANIM` chunk before it picks an encoder. A `.png` that is really an APNG
   takes the animated path.
2. **Every image output works in an `<img>` tag.** An animated image becomes an
   animated WebP, never a `.webm`.
3. **Alpha is preserved for images.** Animated WebP and still WebP carry alpha.
   VP9 alpha needs `-pix_fmt yuva420p`, which Safari does not play, so a video
   with alpha loses the alpha channel.
4. **The smaller file wins.** If every candidate is larger than the source, the
   source is emitted unchanged. Set `force: true` to turn this rule off and get
   one format per media type instead.
5. **An asset already in the target format is not re-encoded.** A `.webp` and a
   `.webm` source pass through. An Opus source is remuxed into WebM, not
   re-encoded. A VP9 video with Opus audio is remuxed too.
6. **Results are cached by content hash.** The key is the source bytes plus the
   encode options. A rebuild with an unchanged asset runs no encoder.
7. **Metadata is stripped.** EXIF, GPS, and ICC profiles other than sRGB are
   removed. The EXIF orientation is applied first.

## Options

```ts
optimizePlugin({
  /** WebP quality for still and animated images, 1 to 100. Default 80. */
  quality: 80,
  /** Also encode a lossless WebP and keep the smaller file. Default true. */
  tryLossless: true,
  /** VP9 constant quality, 0 to 63. Lower is better quality. Default 36. */
  videoQuality: 36,
  /** Opus bitrate. Default: 48k mono, 96k stereo, 128k above that. */
  audioBitrate: undefined,
  /** Emit the converted file even when it is larger. Default false. */
  force: false,
  /** Cache directory. Default node_modules/.cache/bun-optimize-plugin. */
  cacheDir: undefined,
  /** Read the cache but never write it. Default false. */
  disableCache: false,
  /** Print one line per asset and a summary. Default false. */
  verbose: false,
  /** Maximum number of encode jobs at the same time. Default the CPU count. */
  concurrency: navigator.hardwareConcurrency,
});
```

`tryLossless` wins on flat art, screenshots, and logos. It loses on photographs,
and it doubles the image encode time. Set it to `false` for a photo library.

### `force`

By default an asset that no encoder can shrink is emitted unchanged, so a
bundle can still hold an `.avif`, an `.ogg`, or a `.png`. `force: true` emits
the converted file anyway. Every image becomes a `.webp` and every audio and
video file becomes a `.webm`, whatever the size.

```ts
optimizePlugin({ force: true });
```

```
optimize  assets/sample.avif    401 B ->  654 B (+63%)  webp q80, forced
optimize  assets/sample.ogg    9.3 kB -> 9.9 kB (+7%)   remux opus to webm, forced
optimize  assets/sample.png    1.7 kB ->   84 B (-95%)  webp lossless
optimize  16 assets  274.4 kB -> 93.3 kB (-66%)
```

Two cases ignore `force`, because neither one has a conversion to do.

- A `.webp` or `.webm` source is already in the target format. It passes
  through untouched.
- A file no encoder can read is copied unchanged, and the plugin prints a
  warning.

Use `force` when one format per media type matters more than bytes, such as a
player that must not branch on the container. Leave it off to ship the smallest
bundle.

## Example

```sh
bun run example
```

The example builds `example/index.html`, which references every format in
`example/assets`.

```
optimize  assets/sample.wav   86.2 kB -> 7.8 kB (-91%)  opus 48k
optimize  assets/sample.png    1.7 kB ->  84 B (-95%)  webp lossless
optimize  assets/sample.mov   17.4 kB -> 14.0 kB (-19%)  vp9 crf36
optimize  assets/sample.avif    401 B ->  401 B (-0%)  kept source, it is smaller
optimize  16 assets  274.4 kB -> 91.8 kB (-67%)
```

## Known limits

- iOS Safari older than 17.4 does not play WebM. Audio and video break on those
  versions. The single-format rule accepts this.
- SVG is copied unchanged. Minification needs a dependency, and none is chosen.
- `Bun.Image` cannot decode TIFF on Linux, and cannot decode HEIC or AVIF there.
  Such a file is copied unchanged.
- A failed encode is not an error. The plugin prints a warning and copies the
  source.

## Test

```sh
bun test
bun run typecheck
```
