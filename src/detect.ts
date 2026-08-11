/**
 * Byte sniffing for asset routing.
 *
 * Rule 1 of intent.md: animation is detected from the bytes, never from the
 * extension. `Bun.Image` decodes a GIF or an APNG as a single frame and drops
 * the animation without an error, so a `.png` that is really an APNG must not
 * reach `Bun.Image`.
 */

/** The container formats this plugin routes on. */
export type ImageFormat = "gif" | "png" | "jpeg" | "webp" | "avif" | "heic" | "bmp" | "tiff" | "unknown";

/**
 * The three tables below decide which files the plugin opens. They do not
 * decide what happens next: the bytes do that. A `.mp4` holding a still JPEG
 * becomes a WebP, and a `.png` holding a film becomes a WebM. So an extension
 * in the wrong table costs nothing, and an extension in no table is copied.
 *
 * `.ts` is deliberately absent. It names an MPEG transport stream and it names
 * TypeScript, and claiming it would put this plugin in front of every source
 * file in the build.
 */

/** Extensions the plugin opens and expects to hold sound. */
// prettier-ignore
export const AUDIO_EXTENSIONS = new Set([
  ".wav", ".wave", ".w64", ".mp3", ".mp2", ".m4a", ".m4b", ".aac", ".ogg", ".oga",
  ".opus", ".flac", ".alac", ".aiff", ".aif", ".aifc", ".caf", ".wma", ".weba",
  ".mka", ".au", ".snd", ".amr", ".voc", ".ape",
]);

/** Extensions the plugin opens and expects to hold moving pictures. */
// prettier-ignore
export const VIDEO_EXTENSIONS = new Set([
  ".mov", ".qt", ".mp4", ".m4v", ".webm", ".mkv", ".mk3d", ".avi", ".wmv", ".asf",
  ".flv", ".f4v", ".3gp", ".3g2", ".mpg", ".mpeg", ".mpe", ".m1v", ".m2v", ".ogv",
  ".m2ts", ".mts", ".vob", ".dv",
]);

/**
 * Extensions the plugin opens and expects to hold a picture.
 *
 * A picture meant for a screen is here. Data that only looks like a picture is
 * not: `.exr`, `.hdr`, `.dds`, `.ktx`, and `.basis` carry high dynamic range or
 * GPU texture layout that a WebP cannot hold, and whatever reads them is not an
 * `<img>` tag. `.svg` needs a minifier this plugin does not have, and `.ico`
 * carries several resolutions in one file where a WebP carries one.
 */
// prettier-ignore
export const IMAGE_EXTENSIONS = new Set([
  ".png", ".apng", ".jpg", ".jpeg", ".jpe", ".jfif", ".pjpeg", ".pjp", ".webp",
  ".gif", ".avif", ".avifs", ".heic", ".heif", ".heics", ".bmp", ".dib", ".tif",
  ".tiff", ".tga", ".pcx", ".ppm", ".pgm", ".pbm", ".pnm", ".pam", ".sgi", ".jp2",
  ".j2k", ".jpf", ".jpx", ".psd", ".xbm", ".xpm", ".dpx",
]);

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = offset; i < offset + length; i++) out += String.fromCharCode(bytes[i]!);
  return out;
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0
  );
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0
  );
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

/** Identify the container from the magic bytes. The extension is ignored. */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat {
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "gif";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, [0x42, 0x4d])) return "bmp";
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return "tiff";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "webp";
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);
    if (brand === "avif" || brand === "avis") return "avif";
    if (brand.startsWith("hei") || brand.startsWith("mif") || brand.startsWith("msf")) return "heic";
  }
  return "unknown";
}

/**
 * Count the image descriptors in a GIF, stopping at `limit`.
 *
 * A GIF is a header, an optional global color table, then a block stream. Only
 * a second image descriptor (`0x2C`) proves animation. The `NETSCAPE2.0` loop
 * extension is a hint that single-frame files also carry, so it is not used.
 */
function gifFrameCount(bytes: Uint8Array, limit = 2): number {
  let offset = 6;
  if (bytes.length < 13) return 0;
  const packed = bytes[10]!;
  offset = 13;
  if (packed & 0x80) offset += 3 * (1 << ((packed & 0x07) + 1));

  let frames = 0;
  while (offset < bytes.length && frames < limit) {
    const block = bytes[offset]!;
    if (block === 0x3b) break; // trailer
    if (block === 0x21) {
      // extension: label, then sub-blocks terminated by a zero length
      offset += 2;
      while (offset < bytes.length) {
        const size = bytes[offset]!;
        offset += 1 + size;
        if (size === 0) break;
      }
      continue;
    }
    if (block === 0x2c) {
      frames++;
      offset += 10;
      const localPacked = bytes[offset - 1]!;
      if (localPacked & 0x80) offset += 3 * (1 << ((localPacked & 0x07) + 1));
      offset += 1; // LZW minimum code size
      while (offset < bytes.length) {
        const size = bytes[offset]!;
        offset += 1 + size;
        if (size === 0) break;
      }
      continue;
    }
    break; // unknown block, the parse cannot continue safely
  }
  return frames;
}

/** True when the PNG carries an `acTL` chunk, which makes it an APNG. */
function pngIsAnimated(bytes: Uint8Array): boolean {
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = u32be(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    if (type === "acTL") return true;
    if (type === "IDAT" || type === "IEND") return false;
    offset += 12 + length; // length + type + data + crc
    if (length > bytes.length) return false;
  }
  return false;
}

/** True when the WebP carries an `ANIM` chunk or the VP8X animation flag. */
function webpIsAnimated(bytes: Uint8Array): boolean {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4);
    const size = u32le(bytes, offset + 4);
    if (type === "ANIM" || type === "ANMF") return true;
    if (type === "VP8X" && offset + 9 <= bytes.length) {
      if ((bytes[offset + 8]! & 0x02) !== 0) return true;
    }
    offset += 8 + size + (size % 2); // chunks are padded to an even size
  }
  return false;
}

/**
 * True when the bytes hold more than one frame.
 *
 * Only GIF, PNG, and WebP can be animated among the formats this plugin
 * accepts, so every other format answers false.
 */
export function isAnimated(bytes: Uint8Array, format = sniffImageFormat(bytes)): boolean {
  if (format === "gif") return gifFrameCount(bytes) > 1;
  if (format === "png") return pngIsAnimated(bytes);
  if (format === "webp") return webpIsAnimated(bytes);
  return false;
}
