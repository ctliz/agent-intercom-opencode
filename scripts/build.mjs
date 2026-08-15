import { readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";
import { externalizeCorePlugin } from "./core-external.mjs";

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  plugins: [externalizeCorePlugin],
};

await Promise.all([
  build({
    ...common,
    entryPoints: ["opencode/plugin-entry.ts"],
    outfile: "dist/plugin.mjs",
  }),
  build({
    ...common,
    entryPoints: ["opencode/tui.ts"],
    outfile: "dist/tui.mjs",
  }),
  build({
    ...common,
    entryPoints: ["broker/broker.ts"],
    outfile: "dist/broker.mjs",
  }),
]);

for (const outfile of ["dist/plugin.mjs", "dist/tui.mjs", "dist/broker.mjs"]) {
  const content = readFileSync(outfile, "utf8");
  const normalized = content.split("\n").map(l => l.trimEnd()).join("\n");
  if (normalized !== content) {
    writeFileSync(outfile, normalized, "utf8");
  }
}
