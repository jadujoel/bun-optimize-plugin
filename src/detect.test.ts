import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { isAnimated, sniffImageFormat } from "./detect.ts";

const ASSETS = join(import.meta.dir, "..", "example", "assets");

async function read(name: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(join(ASSETS, name)).arrayBuffer());
}

describe("sniffImageFormat", () => {
  test.each([
    ["sample.png", "png"],
    ["sample.apng", "png"],
    ["sample.jpg", "jpeg"],
    ["sample.jpeg", "jpeg"],
    ["sample.gif", "gif"],
    ["sample.webp", "webp"],
    ["sample.avif", "avif"],
  ])("%s is %s", async (name, expected) => {
    expect(sniffImageFormat(await read(name))).toBe(expected as never);
  });

  test("a zip is not an image", async () => {
    expect(sniffImageFormat(await read("sample.zip"))).toBe("unknown");
  });

  test("an empty buffer is not an image", () => {
    expect(sniffImageFormat(new Uint8Array(0))).toBe("unknown");
  });
});

describe("isAnimated", () => {
  test("a gif with two frames is animated", async () => {
    expect(isAnimated(await read("sample.gif"))).toBe(true);
  });

  test("an apng is animated even though it sniffs as png", async () => {
    const bytes = await read("sample.apng");
    expect(sniffImageFormat(bytes)).toBe("png");
    expect(isAnimated(bytes)).toBe(true);
  });

  test.each(["sample.png", "sample.jpg", "sample.jpeg", "sample.webp", "sample.avif"])(
    "%s is a still image",
    async name => {
      expect(isAnimated(await read(name))).toBe(false);
    },
  );

  test("a truncated gif does not loop forever", () => {
    const header = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01]);
    expect(isAnimated(header)).toBe(false);
  });
});
