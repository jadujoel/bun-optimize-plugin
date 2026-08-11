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
4. Keep the smaller file. If the optimized output is larger than the source,
   emit the source.
5. Never re-encode an asset that is already in the target format at or below
   the target quality. Re-encoding a `.webp` or a `.webm` loses quality and
   gains nothing.
6. Cache by content hash of the source plus the encode options. ffmpeg runs
   cost seconds, and a bundler plugin runs on every build.
7. Strip metadata. EXIF, GPS, and ICC profiles other than sRGB are removed.
   Apply the EXIF orientation first (`Bun.Image` does this by default).
8. Use the bundled `ffmpeg-helper` binary, not a system `ffmpeg`.

## Caveats to resolve

- iOS Safari older than 17.4 does not play WebM. Audio and video break on those
  versions. The single-format rule accepts this.
- SVG minification needs a dependency. None is chosen yet, so SVG is copied
  unchanged.
- `Bun.Image` cannot decode TIFF on Linux.
- Quality settings, target resolutions, and `srcset` generation are not
  specified yet.
- `Bun.Image.placeholder()` returns a ThumbHash data URL of about 500 bytes.
  It is a candidate low-quality image placeholder feature.
