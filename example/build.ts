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
      quality: 10,
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
