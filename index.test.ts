import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { optimizePlugin } from "./index.ts";

const outdir = await mkdtemp(join(tmpdir(), "optimize-plugin-"));
const cacheDir = join(outdir, "cache");

const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "example", "index.html")],
  plugins: [optimizePlugin({ cacheDir })],
  outdir,
});

const html = await Bun.file(join(outdir, "index.html")).text();
const emitted = result.outputs.map(output => basename(output.path));

afterAll(async () => {
  await rm(outdir, { recursive: true, force: true });
});

test("the build succeeds", () => {
  expect(result.success).toBe(true);
});

test("no reference keeps a re-encodable extension", () => {
  for (const extension of ["png", "jpg", "jpeg", "gif", "apng", "mov", "mp4", "wav", "mp3", "m4a", "caf"]) {
    expect(html).not.toContain(`.${extension}"`);
  }
});

test("images become webp and media becomes webm", () => {
  expect(html.match(/<img [^>]*src="\.\/sample-\w+\.(webp|avif)"/g)).toHaveLength(7);
  expect(html.match(/<video src="\.\/sample-\w+\.webm"/g)).toHaveLength(3);
  expect(html.match(/<audio src="\.\/sample-\w+\.(webm|ogg|opus)"/g)).toHaveLength(6);
});

test("a file the plugin does not handle is copied unchanged", () => {
  expect(emitted.some(name => name.endsWith(".zip"))).toBe(true);
  expect(emitted.some(name => name.endsWith(".tgz"))).toBe(true);
});

test("the optimized bundle is smaller than the sources", async () => {
  const glob = new Bun.Glob("sample.*");
  let sources = 0;
  for await (const name of glob.scan(join(import.meta.dir, "example", "assets"))) {
    sources += Bun.file(join(import.meta.dir, "example", "assets", name)).size;
  }
  let outputs = 0;
  for (const name of emitted) {
    if (name.startsWith("sample-")) outputs += Bun.file(join(outdir, name)).size;
  }
  expect(outputs).toBeLessThan(sources / 2);
});
