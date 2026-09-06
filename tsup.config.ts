import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts", "rtc-worker": "src/rtc/worker.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  sourcemap: false,
  dts: false,
  splitting: false,
});
