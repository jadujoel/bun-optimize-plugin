import { describe, expect, test } from "bun:test";
import { encodeKey, optionsFor, resolveOptions } from "./options.ts";
import { STRICT_GATE } from "./quality.ts";

describe("resolveOptions", () => {
  test("a single quality pins the ladder to one step", () => {
    expect(resolveOptions({ quality: 70 }).quality).toEqual([70]);
  });

  test("the ladder always ascends, whatever order it was written in", () => {
    expect(resolveOptions({ quality: [90, 60, 75] }).quality).toEqual([60, 75, 90]);
  });

  test("an empty ladder is a configuration error, not a default", () => {
    expect(() => resolveOptions({ quality: [] })).toThrow("at least one step");
  });

  test("alpha defaults to auto", () => {
    expect(resolveOptions().alpha).toBe("auto");
    expect(resolveOptions({ alpha: "drop" }).alpha).toBe("drop");
  });
});

describe("optionsFor", () => {
  const options = resolveOptions({
    maxWidth: 1200,
    alpha: "drop",
    overrides: [
      { match: /signup-rose\.mov$/, alpha: "keep" },
      { match: /\/screenshots\//, gate: STRICT_GATE, maxWidth: 2400 },
    ],
  });

  test("an asset no override claims keeps the build's options", () => {
    const mine = optionsFor("/app/src/assets/hero.mp4", options);
    expect(mine).toBe(options);
    expect(mine.alpha).toBe("drop");
  });

  test("an override changes what it names", () => {
    expect(optionsFor("/app/src/assets/signup-rose.mov", options).alpha).toBe("keep");
  });

  test("an override inherits everything it does not name", () => {
    // `maxWidth` comes from the build, not from the default, which is no cap.
    expect(optionsFor("/app/src/assets/signup-rose.mov", options).maxWidth).toBe(1200);
  });

  test("an override may replace an inherited value", () => {
    const shot = optionsFor("/app/src/screenshots/settings.png", options);
    expect(shot.maxWidth).toBe(2400);
    expect(shot.gate).toEqual(STRICT_GATE);
    expect(shot.alpha).toBe("drop");
  });

  test("the first matching override wins, so the order is the answer", () => {
    const ordered = resolveOptions({
      overrides: [
        { match: /\.mov$/, videoQuality: 20 },
        { match: /rose/, videoQuality: 50 },
      ],
    });
    expect(optionsFor("/app/rose.mov", ordered).videoQuality).toBe(20);
  });

  test("an override carries no overrides of its own", () => {
    expect(optionsFor("/app/src/assets/signup-rose.mov", options).overrides).toEqual([]);
  });

  test("the build's own cache directory is never overridden", () => {
    expect(optionsFor("/app/src/assets/signup-rose.mov", options).cacheDir).toBe(options.cacheDir);
  });
});

describe("encodeKey", () => {
  test("two assets under one build get different keys when an override claims one", () => {
    const options = resolveOptions({ alpha: "drop", overrides: [{ match: /rose/, alpha: "keep" }] });
    const rose = optionsFor("/app/rose.mov", options);
    expect(encodeKey(rose)).not.toBe(encodeKey(options));
  });

  test("an option that cannot change the output bytes is not in the key", () => {
    const quiet = resolveOptions({ verbose: false, concurrency: 1 });
    const loud = resolveOptions({ verbose: true, concurrency: 8 });
    expect(encodeKey(quiet)).toBe(encodeKey(loud));
  });
});
