import { optimizePlugin } from "../index.ts";

export async function build() {
  const result = await Bun.build({
    entrypoints: ["./index.html"],
    plugins: [
      optimizePlugin({
      verbose: true,
      force: true,
      audioBitrate: "32k",
      videoQuality: 8,
      // A quality this low is refused by the gate on any real picture, which is
      // the point of the gate. The example wants the smallest possible bundle,
      // so it turns the measurement off and takes what it asked for.
      quality: 10,
      gate: false,
    })
    ],
    outdir: "dist",
  });
  for (const log of result.logs) console.log(log);
  if (!result.success) throw new AggregateError(result.logs, "build failed");
  return result;
}

if (import.meta.main) {
  await build();
}
