# Asset optimization intent

## Output formats

| Input           | Default output   | Codec / encoder                | Tool                  |
| --------------- | ---------------- | ------------------------------ | --------------------- |
| Audio           | `.webm`          | Opus (`libopus`)               | ffmpeg                |
| Video           | `.webm`          | VP9 (`libvpx-vp9`) + Opus      | ffmpeg                |
| Animated image  | `.webp`          | animated WebP (`libwebp_anim`) | ffmpeg                |
| Still image     | `.webp`          | WebP                           | `Bun.Image` or ffmpeg |
| Anything else   | copied unchanged | —                              | —                     |

Two output formats, `.webp` and `.webm`. There is no second output file for any
input, and no alternative codec behind an option. An asset produces one file.

The row is chosen by the bytes. See rule 12.

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
   gains nothing. A track, not a file, is the unit: VP9 video beside AAC audio
   copies the picture and encodes only the sound. A file is left alone entirely
   only when its name, its container, and both its codecs are already what the
   plugin would emit, so an MKV holding VP9 and Opus is still remuxed — the
   bytes are right and no `<video>` tag accepts the name.
9. Cache by content hash of the source plus everything that changes the output
   bytes, the gate and the width cap included. ffmpeg runs cost seconds, and a
   bundler plugin runs on every build.
10. Strip metadata. EXIF, GPS, and ICC profiles other than sRGB are removed.
    Apply the EXIF orientation first (`Bun.Image` does this by default).
11. Use the bundled `ffmpeg-helper` binary, not a system `ffmpeg`.
12. The bytes choose the encoder, never the extension. The extension only
    decides whether the file is opened at all. A `.jpg` holding a PNG, an
    `.mp4` holding one still picture, a `.png` holding a film, and a `.ogg`
    holding a film are all things people ship, and the last of those is why
    this rule is not merely tidy: an audio encode strips video without a word.
    A picture the byte sniffer names is routed on the sniff. Everything else is
    handed to ffmpeg, and its answer decides: a still-image demuxer means a
    still picture, a video stream that is not cover art means footage, and
    sound with no footage means audio. Album art is a video stream by every
    other measure, and an MP3 that carries it must not become a one-frame film.
13. Decode with whatever will decode it. `Bun.Image` reads JPEG, PNG, WebP,
    GIF, BMP, and — through the OS codec — TIFF, HEIC, and AVIF. It refuses
    everything else three different ways, and all three fall back to ffmpeg,
    because shipping a source untouched over a refusal that another decoder
    does not share is a worse answer than a second attempt.
14. Convert pictures, not data that resembles a picture. `.exr`, `.hdr`,
    `.dds`, `.ktx`, and `.basis` hold dynamic range or GPU texture layout that
    a WebP cannot carry, and whatever reads them is not an `<img>` tag. `.ico`
    holds several resolutions where a WebP holds one. These are copied. So is
    anything the `exclude` option names, which is the escape hatch for a `.tga`
    that is really a texture.
15. Resolution is a decision made once, before any candidate is encoded.
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
- JPEG XL and QOI have no decoder here at all, in `Bun.Image` or in ffmpeg
  5.0.1, so their extensions are not claimed. They would only ever be copied,
  and claiming them would spend a process per build to learn that again.
- A file is read into memory whole to be hashed for the cache key. A 500 MB
  video costs 500 MB of resident buffer for a hash that a stream would give for
  nothing. Nothing else about a large video is loaded, so this is the one place
  the size shows up.
- `maxWidth` is one number for every asset. A backdrop and a figure drawn at a
  third of its width want different caps, and `srcset` generation would want
  several outputs per source, which the one-file-per-asset rule at the top of
  this document forbids today.
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
