import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { decodePng } from "./png.ts";
import { image } from "./quality.ts";

const ASSETS = join(import.meta.dir, "..", "example", "assets");

async function read(name: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(join(ASSETS, name)).arrayBuffer());
}

const source = await read("sample.png");

describe("decodePng", () => {
  test("reads the size and one pixel per four bytes", async () => {
    const png = await image(source).png().bytes();
    const pixels = decodePng(png)!;
    expect(pixels.width).toBeGreaterThan(0);
    expect(pixels.data.length).toBe(pixels.width * pixels.height * 4);
  });

  test.each([
    ["truecolour", { compressionLevel: 1 }],
    ["indexed", { palette: true, colors: 256, compressionLevel: 1 }],
    ["indexed and dithered", { palette: true, colors: 64, dither: true, compressionLevel: 1 }],
  ])("every colour type decodes to the same canvas: %s", async (_label, options) => {
    const reference = decodePng(await image(source).png({ compressionLevel: 1 }).bytes())!;
    const pixels = decodePng(await image(source).png(options).bytes());
    expect(pixels).not.toBeNull();
    expect(pixels!.width).toBe(reference.width);
    expect(pixels!.height).toBe(reference.height);
  });

  test("a lossless round trip is byte exact", async () => {
    // PNG in, PNG out, no re-quantisation anywhere: the pixels must survive.
    const once = decodePng(await image(source).png({ compressionLevel: 1 }).bytes())!;
    const twice = decodePng(await image(source).png({ compressionLevel: 9 }).bytes())!;
    expect(Buffer.from(twice.data).equals(Buffer.from(once.data))).toBe(true);
  });

  test("a fully opaque source decodes with alpha 255", async () => {
    const pixels = decodePng(await image(await read("sample.jpg")).png().bytes())!;
    for (let i = 3; i < pixels.data.length; i += 4) {
      expect(pixels.data[i]).toBe(255);
    }
  });

  test.each([
    ["a jpeg", "sample.jpg"],
    ["a webp", "sample.webp"],
    ["a zip", "sample.zip"],
  ])("%s is not a png", async (_label, name) => {
    expect(decodePng(await read(name))).toBeNull();
  });

  test("an empty buffer is not a png", () => {
    expect(decodePng(new Uint8Array(0))).toBeNull();
  });

  test("a truncated png is refused rather than half decoded", async () => {
    const png = await image(source).png().bytes();
    expect(decodePng(png.subarray(0, png.length - 40))).toBeNull();
  });

  test("an interlaced png is refused rather than guessed at", async () => {
    // Flip the IHDR interlace byte and repair nothing else: the CRC is not
    // checked, so this reaches the interlace branch and must stop there.
    const png = new Uint8Array(await image(source).png().bytes());
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect(String.fromCharCode(png[12]!, png[13]!, png[14]!, png[15]!)).toBe("IHDR");
    png[8 + 8 + 12] = 1; // IHDR payload starts at 16; interlace is its 13th byte
    expect(view.getUint32(8)).toBe(13);
    expect(decodePng(png)).toBeNull();
  });
});
