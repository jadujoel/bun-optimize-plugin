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

| Input            | Output           | Encoder                       |
| ---------------- | ---------------- | ----------------------------- |
| Audio            | `.webm`          | Opus, `libopus`               |
| Video            | `.webm`          | VP9 and Opus, `libvpx-vp9`    |
| Animated image   | `.webp`          | animated WebP, `libwebp_anim` |
| Still image      | `.webp`          | WebP, `Bun.Image` or ffmpeg   |
| Anything else    | copied unchanged | —                             |

There are two output formats, `.webp` and `.webm`. One asset produces one file.
There is no second output file and no alternative codec behind an option.

**Which row an asset lands in is decided by its bytes, not by its name.** A
`.jpg` holding a PNG, an `.mp4` holding one still picture, and a `.ogg` holding
a film all reach the right encoder. The extension only decides whether the
plugin opens the file at all:

- **Audio:** `.wav .wave .w64 .mp3 .mp2 .m4a .m4b .aac .ogg .oga .opus .flac
  .alac .aiff .aif .aifc .caf .wma .weba .mka .au .snd .amr .voc .ape`
- **Video:** `.mov .qt .mp4 .m4v .webm .mkv .mk3d .avi .wmv .asf .flv .f4v .3gp
  .3g2 .mpg .mpeg .mpe .m1v .m2v .ogv .m2ts .mts .vob .dv`
- **Image:** `.png .apng .jpg .jpeg .jpe .jfif .pjpeg .pjp .webp .gif .avif
  .avifs .heic .heif .heics .bmp .dib .tif .tiff .tga .pcx .ppm .pgm .pbm .pnm
  .pam .sgi .jp2 .j2k .jpf .jpx .psd .xbm .xpm .dpx`

`Bun.Image` reads JPEG, PNG, WebP, GIF, BMP, and — through the OS codec, so on
macOS and Windows only — TIFF, HEIC, and AVIF. Everything else in the image list
is decoded by the bundled ffmpeg, and so is any file `Bun.Image` refuses.

Some things are deliberately left alone. `.exr`, `.hdr`, `.dds`, `.ktx`, and
`.basis` hold dynamic range or GPU texture layout that a WebP cannot carry, and
whatever reads them is not an `<img>` tag. `.ico` holds several resolutions
where a WebP holds one. `.svg` needs a minifier this plugin does not have.
`.ts` is TypeScript far more often than it is an MPEG transport stream. Use
`exclude` to leave anything else alone as well.

A source the plugin cannot decode at all is emitted unchanged, and `verbose`
says why. A build never fails because of an asset.

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
4. **The smallest file that still looks right wins.** Every lossy candidate is
   decoded again and compared to the source pixel for pixel. Anything past the
   gate is discarded, so which quality an asset ships at is measured rather than
   assumed. See [The quality gate](#the-quality-gate).
5. **An encode is proved before it is kept.** An animated WebP is replayed frame
   by frame against the source. A video and an audio file are decoded again and
   checked for lost frames and a changed runtime. An encoder that drops most of
   its frames reports success and produces a much smaller file, so nothing but a
   decode of the result catches it.
6. **The smaller file wins.** If every candidate is larger than the source, the
   source is emitted unchanged. Set `force: true` to turn this rule off and get
   one format per media type instead.
7. **An asset already in the target format is not re-encoded.** A `.webp` source
   passes through, and so does a `.webm` that really holds WebM codecs. An Opus
   track is copied into the WebM rather than encoded again, and so is a VP8,
   VP9, or AV1 picture. The two tracks are decided one at a time, so VP9 video
   beside AAC audio keeps its picture and re-encodes only the sound. Album art
   is not a picture track and never routes a song to the video encoder.
8. **Results are cached by content hash.** The key is the source bytes plus the
   encode options, the gate and the width cap included. A rebuild with an
   unchanged asset runs no encoder.
9. **Metadata is stripped.** EXIF, GPS, and ICC profiles other than sRGB are
   removed. The EXIF orientation is applied first.

## Options

```ts
optimizePlugin({
  /** WebP qualities to try, smallest passing step wins. Default [92, 88, 82]. */
  quality: [92, 88, 82],
  /** How much error a lossy candidate may carry. Default { rmse: 4, p999: 44 }. */
  gate: { rmse: 4, p999: 44 },
  /** Also encode a lossless WebP and keep the smaller file. Default true. */
  tryLossless: true,
  /** Resample any still image wider than this. Default off. */
  maxWidth: undefined,
  /** VP9 constant quality, 0 to 63. Lower is better quality. Default 32. */
  videoQuality: 32,
  /** Opus bitrate. Default: 48k mono, 96k stereo, 128k above that. */
  audioBitrate: undefined,
  /** Emit the converted file even when it is larger. Default false. */
  force: false,
  /** Leave any source whose path matches this alone. Default off. */
  exclude: undefined,
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
and it doubles the image encode time. It is also the floor under the gate: a
lossless candidate carries no error, so it always passes. With it off, an image
whose every lossy candidate is refused keeps its source.

## The quality gate

A file size does not describe a picture. Picking the smallest candidate is not
the same as picking the smallest candidate that still looks right, so every
lossy encode is decoded again and measured against the source.

The measurement is two numbers over alpha-premultiplied RGBA.

- `rmse` — the average channel error, in 8-bit levels.
- `p999` — the 99.9th-percentile channel error. This catches banding in one
  small gradient that the average would hide.

`quality` is a ladder, not a setting. Every step is encoded and measured, and
the smallest one inside the gate wins. So the gate decides the quality and the
ladder decides where the encoder may look. A stricter gate ships better pictures
and more bytes.

```ts
import { optimizePlugin, STRICT_GATE } from "@jadujoel/bun-optimize-plugin";

// Flat art, screenshots, and logos.
optimizePlugin({ gate: STRICT_GATE });      // { rmse: 2, p999: 24 }

// Photographs. This is the default.
optimizePlugin({ gate: { rmse: 4, p999: 44 } });

// Pick by file size alone, the way every other asset plugin does.
optimizePlugin({ gate: false, quality: 80 });
```

The default is not the strict number, and the reason is worth knowing.
Photographs do not behave like flat art: on a photographic collage every lossy
WebP fails `STRICT_GATE` — q92 measures around rmse 3.5 and p99.9 40, and the
error barely moves down to q65, because it is spread thinly across
high-frequency texture rather than concentrated anywhere the eye lands. Refusing
all of them means shipping lossless, which costs roughly 5× the bytes for a
difference nobody can see at 1:1.

The verbose log reports what was measured, and what was refused when nothing was
accepted.

```
optimize  assets/photo.png    6.0 MB -> 497.0 kB (-92%)  webp q82 (rmse 2.81, p99.9 11)
optimize  assets/logo.png     1.7 kB ->   84 B (-95%)  webp lossless
optimize  assets/ink.png      1.7 kB ->  1.7 kB (0%)   kept source, already optimal; webp q82 rmse 5.39, p99.9 80
```

### Animation

Animation gets the same gate, and it is the reason the gate exists at all.
`libwebp_anim` merges frames. Some merges are invisible — two identical frames
become one — and some are a different animation, such as 63 frames collapsing to
4. Both produce a smaller file, so a pipeline that judges by size alone ships
the second one and calls it a win.

The candidate is therefore replayed frame by frame and compared to the source
**by time, not by frame index**. Each source frame's midpoint is looked up in
the candidate's timeline, and the two pictures at that instant are compared. A
harmless merge passes. A merge that holds one picture for half a second does
not. A lossless encode is measured too, because frame merging is a property of
the encoder and not of the quality setting.

## `maxWidth`

Off by default, because resampling changes the picture. It is still worth
setting.

Bytes on the wire are not the cost of an oversized image. A 3911 × 4050
background for a 920 px layout compresses to 329 kB, so no byte count ever
complains about it, and it still costs 60 MB of resident bitmap and the decode
time that goes with it — on the landing page, before anything else can paint.

```ts
optimizePlugin({ maxWidth: 1840 });  // 2× a 920 px layout
```

An image over the cap is resampled before a single candidate is encoded, and the
gate then runs against the resampled image, so a shipped file is judged against
the picture it is meant to be. An image over `LARGE_DECODE` is reported in the
verbose log even when no cap is set.

```
optimize  assets/sky.png    6.0 MB -> 508.8 kB (-92%)  webp q82 (rmse 2.81, p99.9 11); 3000×2000 resampled to 1840px wide
optimize  assets/sky.png    6.0 MB -> 372.8 kB (-94%)  webp lossless; 3000×2000 decodes to 22.9 MB
```

Animations are never resampled.

### `force`

By default an asset that no encoder can shrink is emitted unchanged, so a
bundle can still hold an `.avif`, an `.ogg`, or a `.png`. `force: true` emits
the converted file anyway. Every image becomes a `.webp` and every audio and
video file becomes a `.webm`, whatever the size.

```ts
optimizePlugin({ force: true });
```

```
optimize  assets/sample.avif    401 B ->  654 B (+63%)  webp lossless, forced
optimize  assets/sample.ogg    9.3 kB -> 9.9 kB (+7%)   remux opus to webm, forced; runtime verified
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
optimize  assets/sample.wav   86.2 kB -> 7.8 kB (-91%)  opus 48k; runtime verified
optimize  assets/sample.png    1.7 kB ->  84 B (-95%)  webp lossless
optimize  assets/sample.mov   17.4 kB -> 14.9 kB (-14%)  vp9 crf32; 15 frames verified
optimize  assets/sample.gif     397 B ->  140 B (-65%)  animated webp lossless (rmse 0.00, p99.9 0)
optimize  assets/sample.avif    401 B ->  401 B (-0%)  kept source, it is smaller
optimize  16 assets  274.4 kB -> 91.8 kB (-67%)
```

## Known limits

- iOS Safari older than 17.4 does not play WebM. Audio and video break on those
  versions. The single-format rule accepts this.
- SVG is copied unchanged. Minification needs a dependency, and none is chosen.
- `Bun.Image` cannot decode TIFF, HEIC, or AVIF on Linux. Those three formats
  need the OS codec, which macOS and Windows have. A refused format falls back
  to ffmpeg, which decodes TIFF. The bundled ffmpeg is 5.0.1, and it does not
  read a still HEIC or AVIF, so a HEIC or an AVIF is copied unchanged on Linux,
  even under `force: true`.
- A failed encode is not an error. The plugin prints a warning and copies the
  source.
- The gate measures a picture against its own source. It cannot tell you that
  the source is the wrong size for the box it is drawn in, or that an asset is
  loaded on a page that never shows it. Those are the two largest wins on a real
  site, and they are decisions only the page can make.
- The frame check on video is deliberately loose. A variable-frame-rate source
  encoded at a constant rate legitimately changes its frame count, so demanding
  equality would refuse correct encodes. The check catches catastrophic loss;
  the runtime check catches re-timing.

## Test

```sh
bun test
bun run typecheck
```
