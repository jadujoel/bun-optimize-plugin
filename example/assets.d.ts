/**
 * Bun's `file` loader turns an unknown asset import into the emitted URL.
 * `bun-types` declares the loaders it knows about, but not these two.
 */

declare module "*.zip" {
  const url: string;
  export default url;
}

declare module "*.tgz" {
  const url: string;
  export default url;
}
