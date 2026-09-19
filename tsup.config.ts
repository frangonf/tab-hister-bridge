import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    background: "src/background.ts",
    options: "src/options.ts",
  },
  format: ["esm"],
  target: "es2022",
  outDir: "dist",
  clean: false,
  sourcemap: true,
  noExternal: [],
});
