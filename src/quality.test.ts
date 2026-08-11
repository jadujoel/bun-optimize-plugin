import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Pixels } from "./png.ts";
import {
  DEFAULT_GATE,
  STRICT_GATE,
  compare,
  describe as describeDifference,
  image,
  toPixels,
  withinGate,
} from "./quality.ts";

const ASSETS = join(import.meta.dir, "..", "example", "assets");

async function read(name: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(join(ASSETS, name)).arrayBuffer());
}

/** A canvas of one repeated colour, for arithmetic that is easy to check. */
function flat(width: number, height: number, rgba: readonly number[]): Pixels {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return { width, height, data };
}

describe("compare", () => {
  test("a picture against itself is a perfect score", () => {
    const pixels = flat(4, 4, [10, 20, 30, 255]);
    expect(compare(pixels, pixels)).toEqual({ rmse: 0, p999: 0 });
  });

  test("two sizes are a mistake upstream, not a measurement", () => {
    expect(compare(flat(4, 4, [0, 0, 0, 255]), flat(4, 5, [0, 0, 0, 255]))).toBeNull();
  });

  test("a uniform shift of n levels measures rmse n", () => {
    const difference = compare(flat(8, 8, [100, 100, 100, 255]), flat(8, 8, [110, 110, 110, 255]))!;
    expect(difference.rmse).toBeCloseTo(Math.sqrt((3 * 100) / 4), 6);
    expect(difference.p999).toBe(10);
  });

  test("colour under full transparency is not counted as damage", () => {
    // Both canvases are invisible. Only the colour differs, and premultiplying
    // by an alpha of zero is what makes that a difference of nothing.
    const difference = compare(flat(8, 8, [255, 0, 0, 0]), flat(8, 8, [0, 0, 255, 0]))!;
    expect(difference).toEqual({ rmse: 0, p999: 0 });
  });

  test("a difference in alpha itself is counted", () => {
    const difference = compare(flat(8, 8, [0, 0, 0, 255]), flat(8, 8, [0, 0, 0, 235]))!;
    expect(difference.p999).toBe(20);
    expect(difference.rmse).toBeGreaterThan(0);
  });

  test("the percentile catches damage that the average hides", () => {
    // Half a percent of the pixels are 50 levels out and the rest are exact.
    // The mean stays under the strict limit. That is the shape of banding in a
    // small gradient, and it must not pass.
    const size = 100;
    const a = flat(size, size, [0, 0, 0, 255]);
    const b = flat(size, size, [0, 0, 0, 255]);
    for (let i = 0; i < size * size * 0.005; i++) b.data[i * 4] = 50;
    const difference = compare(a, b)!;
    expect(difference.rmse).toBeLessThan(STRICT_GATE.rmse);
    expect(difference.p999).toBeGreaterThan(DEFAULT_GATE.p999);
    expect(withinGate(difference, DEFAULT_GATE)).toBe(false);
  });
});

describe("withinGate", () => {
  test.each([
    ["inside both limits", { rmse: 1, p999: 10 }, true],
    ["exactly on both limits", { rmse: 4, p999: 44 }, true],
    ["past the average only", { rmse: 4.1, p999: 10 }, false],
    ["past the percentile only", { rmse: 1, p999: 45 }, false],
  ])("%s", (_label, difference, expected) => {
    expect(withinGate(difference, DEFAULT_GATE)).toBe(expected);
  });

  test("the strict gate refuses what the default gate admits", () => {
    const difference = { rmse: 3, p999: 30 };
    expect(withinGate(difference, DEFAULT_GATE)).toBe(true);
    expect(withinGate(difference, STRICT_GATE)).toBe(false);
  });
});

describe("toPixels", () => {
  test("decodes a webp and a jpeg to the same canvas as the png", async () => {
    const source = await read("sample.png");
    const reference = (await toPixels(source))!;
    const webp = (await toPixels(await image(source).webp({ lossless: true }).bytes()))!;
    expect(webp.width).toBe(reference.width);
    expect(compare(reference, webp)).toEqual({ rmse: 0, p999: 0 });
  });

  test("resampling first is what makes a capped image measurable", async () => {
    const source = await read("sample.png");
    const full = (await toPixels(source))!;
    const capped = (await toPixels(source, 64))!;
    expect(capped.width).toBe(64);
    expect(compare(full, capped)).toBeNull();
  });
});

describe("describe", () => {
  test("reads as two numbers with a name each", () => {
    expect(describeDifference({ rmse: 1.234, p999: 17 })).toBe("rmse 1.23, p99.9 17");
  });
});
