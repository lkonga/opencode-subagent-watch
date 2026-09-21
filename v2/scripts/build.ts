/**
 * Regenerates the V2 build artifact from source.
 *
 * Mirrors the V1 build (`scripts/build.ts`): the OpenTUI Solid plugin compiles
 * JSX and the runtime modules stay external. V2 resolves those externals to its
 * own copies through the OpenTUI runtime module map, exactly like an
 * uncompiled `.tsx` plugin does, so the artifact must never bundle them.
 *
 * The entrypoint is `v2/tui.tsx` (the source stays the build input) and the
 * only output is `v2/dist/tui.js`, which the package exports.
 *
 * Usage: bun v2/scripts/build.ts
 */
import solidPlugin from "@opentui/solid/bun-plugin";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const entrypoint = fileURLToPath(new URL("tui.tsx", root));
const outdir = fileURLToPath(new URL("dist", root));
const expected = fileURLToPath(new URL("dist/tui.js", root));

const result = await Bun.build({
  entrypoints: [entrypoint],
  outdir,
  target: "node",
  format: "esm",
  sourcemap: "none",
  minify: false,
  plugins: [solidPlugin],
  external: ["@opencode/plugin/tui", "@opentui/solid", "solid-js"],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const outputs = result.outputs.map((output) => output.path);
if (outputs.length !== 1 || outputs[0] !== expected) {
  console.error(`expected exactly ${expected}, built ${outputs.join(", ") || "nothing"}`);
  process.exit(1);
}

console.log(`built ${expected}`);
