# Asset optimization intent

## Output formats

| Input                          | Default output           | Codec / encoder                | Tool               |
| ------------------------------ | ------------------------ | ------------------------------ | ------------------ |
| Audio (`.wav .mp3 .m4a .ogg .caf .opus`) | `.webm`        | Opus (`libopus`)               | ffmpeg             |
| Video (`.mov .mp4 .webm .mkv`) | `.webm`                  | VP9 (`libvpx-vp9`) + Opus      | ffmpeg             |
| Animated image (`.gif`, animated `.apng` / `.webp`) | `.webp` | animated WebP (`libwebp_anim`) | ffmpeg             |
| Still image (`.png .jpg .jpeg .webp .avif .heic .bmp .tiff`) | `.webp` | WebP                    | `Bun.Image`        |
| Anything else                  | copied unchanged         | —                              | —                  |

Two output formats, `.webp` and `.webm`. There is no second output file for any
input, and no alternative codec behind an option. An asset produces one file.

## Rules

1. Detect animation from the bytes, not from the extension. `Bun.Image`
   decodes `.gif` and `.apng` as a **single frame** and drops the animation
   without an error. Check for the GIF `NETSCAPE2.0` block or a second image
   descriptor, the PNG `acTL` chunk, and the WebP `ANIM` chunk.
2. Every image output stays usable in an `<img>` tag. Animated WebP is the
   reason. An animated image never becomes a `.webm`.
3. Preserve alpha. Animated WebP and still WebP carry alpha everywhere. VP9
   alpha needs `-pix_fmt yuva420p` and Safari does not play it, so a video with
   alpha loses the alpha channel.
4. Measure every lossy candidate, do not assume it. Decode it again and compare
   it to the source over alpha-premultiplied RGBA. A candidate past the gate is
   discarded, so `quality` is a ladder the gate walks and not a setting. A file
   size does not describe a picture.
5. Prove every encode before keeping it. An animated WebP is replayed frame by
   frame; a video and an audio file are decoded again and checked for lost
   frames and a changed runtime. ffmpeg reports success on an encode that wrote
   4 of 63 frames, and that file is smaller, so size cannot be the only judge.
6. Judge animation by time, not by frame index. `libwebp_anim` merges frames.
   A merge of two identical frames is invisible and must pass. A merge that
   holds one picture for half a second is a different animation and must not.
   Compare what is on screen at the midpoint of each source frame.
7. Keep the smaller file. If the optimized output is larger than the source,
   emit the source.
8. Never re-encode an asset that is already in the target format at or below
   the target quality. Re-encoding a `.webp` or a `.webm` loses quality and
   gains nothing.
9. Cache by content hash of the source plus everything that changes the output
   bytes, the gate and the width cap included. ffmpeg runs cost seconds, and a
   bundler plugin runs on every build.
10. Strip metadata. EXIF, GPS, and ICC profiles other than sRGB are removed.
    Apply the EXIF orientation first (`Bun.Image` does this by default).
11. Use the bundled `ffmpeg-helper` binary, not a system `ffmpeg`.
12. Resolution is a decision made once, before any candidate is encoded.
    `maxWidth` resamples the source and the gate then runs against the
    resampled image, so a shipped file is judged against the picture it is
    meant to be. Bytes on the wire are not the cost of an oversized image: a
    3911 × 4050 source is 60 MB of resident bitmap and still ships as 329 kB.

## Caveats to resolve

- iOS Safari older than 17.4 does not play WebM. Audio and video break on those
  versions. The single-format rule accepts this.
- SVG minification needs a dependency. None is chosen yet, so SVG is copied
  unchanged.
- `Bun.Image` cannot decode TIFF, HEIC, or AVIF on Linux. TIFF falls back to
  ffmpeg. The bundled ffmpeg 5.0.1 does not read a still HEIC or AVIF, so those
  two are copied unchanged on Linux.
- `maxWidth` is one number for every asset. A backdrop and a figure drawn at a
  third of its width want different caps, and `srcset` generation would want
  several outputs per source, which rule 3's one-file-per-asset forbids today.
- The gate is one number for every asset. Flat art wants `STRICT_GATE` and
  photographs want the default, and nothing here measures which is which.
- PNG is never a candidate. Indexed PNG still beats WebP on flat artwork with
  few colours, and which is which is not predictable by eye. Admitting it would
  mean two output containers for still images.
- `Bun.Image.placeholder()` returns a ThumbHash data URL of about 500 bytes.
  It is a candidate low-quality image placeholder feature.
- Intrinsic width and height are read for every image and then discarded.
  Exposing them would let a page set `width`/`height` and stop paying for
  layout shift.
