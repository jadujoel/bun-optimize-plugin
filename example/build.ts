import { OptimizePlugin } from "../index.ts"

export async function build() {
  Bun.build({
    entrypoints: ["./index.html"],
    plugins: [OptimizePlugin],
    outdir: "dist",
  })
}

if (import.meta.main) {
  await build()
}
