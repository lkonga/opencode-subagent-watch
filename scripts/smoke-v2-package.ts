/**
 * Smoke-checks the V2 package without publishing it.
 *
 * `smoke-package.ts` proves the published V1 tarball loads; this script does
 * the equivalent for the private V2 artifact:
 *   1. the V2 manifest keeps `.` and `./tui` on the dedicated build output;
 *   2. the tracked `v2/dist/tui.js` is fresh (byte-identical to a rebuild);
 *   3. the artifact still treats `@opencode/plugin/tui` as a runtime external;
 *   4. the artifact loads with the V2 `Plugin.define` contract stubbed and its
 *      `setup` registers the sidebar/app slots plus the deterministic storage
 *      key, against the same typed fake context the tests use.
 *
 * Usage: bun scripts/smoke-v2-package.ts
 */
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import solidPlugin from "@opentui/solid/bun-plugin";
import type { Plugin } from "@opencode/plugin/tui";
import { SIDEBAR_ORDER } from "../src/sidebar-state.ts";
import { createHarness } from "../v2/testing/harness.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const artifact = join(root, "v2/dist/tui.js");

type V2Manifest = {
  readonly name: string;
  readonly private?: boolean;
  readonly type?: string;
  readonly main?: string;
  readonly exports: Readonly<Record<string, string>>;
  readonly files?: readonly string[];
  readonly scripts?: Readonly<Record<string, string>>;
};

type RootManifest = {
  readonly exports: Readonly<Record<string, { readonly import?: string } | string>>;
  readonly scripts?: Readonly<Record<string, string>>;
};

type ArtifactModule = { readonly default?: Plugin.Definition };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`smoke:v2 failed: ${message}`);
}

async function manifest<T>(path: string): Promise<T> {
  return (await Bun.file(path).json()) as T;
}

const v2 = await manifest<V2Manifest>(join(root, "v2/package.json"));
assert(v2.name === "@lkonga/opencode-subagent-watch-v2", `unexpected package name ${v2.name}`);
assert(v2.private === true, "v2 package must stay private");
assert(v2.type === "module", "v2 package must be ESM");
assert(v2.exports["."] === "./dist/tui.js", "v2 `.` export must be ./dist/tui.js");
assert(v2.exports["./tui"] === "./dist/tui.js", "v2 `./tui` export must be ./dist/tui.js");
assert(Array.isArray(v2.files) && v2.files.includes("dist"), "v2 files must include dist");
assert(v2.scripts?.["build"] === "bun scripts/build.ts", "v2 build script must stay dedicated");

const v1 = await manifest<RootManifest>(join(root, "package.json"));
const tuiExport: string | { readonly import?: string } | undefined = v1.exports["./tui"];
const v1Tui = typeof tuiExport === "string" ? tuiExport : tuiExport?.import;
assert(v1Tui === "./dist/tui.js", "V1 ./tui export must stay ./dist/tui.js");
assert(v1.exports["."] === undefined, "root package must not gain a `.` export");
assert(v1.scripts?.["build:v2"] === "bun v2/scripts/build.ts", "missing root build:v2 script");
assert(
  SIDEBAR_ORDER === 60,
  `V1 sidebar order must stay 60 (after Token Cache 55, before core Todo 400), got ${SIDEBAR_ORDER}`,
);

const tracked = await Bun.file(artifact).text();
assert(tracked.length > 0, "v2/dist/tui.js is missing; run bun run build:v2");
assert(
  tracked.includes('from "@opencode/plugin/tui"'),
  "v2 artifact must keep @opencode/plugin/tui as a runtime import",
);
assert(
  tracked.includes('"opencode-subagent-watch-v2-tui"'),
  "v2 artifact must embed the plugin id",
);

const work = await mkdtemp(join(tmpdir(), "subagent-watch-v2-smoke-"));
try {
  // 1. Freshness: rebuild the source exactly like the dedicated build script.
  const freshDir = join(work, "fresh");
  const fresh = await Bun.build({
    entrypoints: [fileURLToPath(new URL("../v2/tui.tsx", import.meta.url))],
    outdir: freshDir,
    target: "node",
    format: "esm",
    sourcemap: "none",
    minify: false,
    plugins: [solidPlugin],
    external: ["@opencode/plugin/tui", "@opentui/solid", "solid-js"],
  });
  assert(fresh.success, "rebuilding v2/tui.tsx failed");
  const rebuilt = await Bun.file(join(freshDir, "tui.js")).text();
  assert(
    rebuilt.replace(/^\/\/ .*$/m, "") === tracked.replace(/^\/\/ .*$/m, ""),
    "v2/dist/tui.js is stale; run bun run build:v2",
  );

  // 2. Load the artifact with the runtime-provided module stubbed.
  const stub = join(work, "plugin-tui-stub.ts");
  await Bun.write(stub, `export const Plugin = { define: (definition) => definition };\n`);
  const sandbox = join(work, "sandbox");
  const bundle = await Bun.build({
    entrypoints: [artifact],
    outdir: sandbox,
    target: "node",
    format: "esm",
    sourcemap: "none",
    minify: false,
    plugins: [
      {
        name: "stub-runtime-plugin-tui",
        setup(build) {
          build.onResolve({ filter: /^@opencode\/plugin\/tui$/ }, () => ({ path: stub }));
        },
      },
    ],
    external: ["@opentui/solid", "solid-js"],
  });
  assert(bundle.success, "bundling the v2 artifact with stubs failed");
  // The sandbox lives outside the repo, so link the dev dependencies in for
  // the artifact's external runtime imports (`@opentui/solid`, `solid-js`).
  await symlink(join(root, "node_modules"), join(sandbox, "node_modules"), "dir");

  const loaded: ArtifactModule = await import(join(sandbox, "tui.js"));
  const definition = loaded.default;
  assert(definition !== undefined, "v2 artifact has no default export");
  assert(
    definition.id === "opencode-subagent-watch-v2-tui",
    `unexpected plugin id ${definition.id}`,
  );
  assert(typeof definition.setup === "function", "v2 artifact setup is not a function");
  // The module contract is exactly `{ id, setup }`.
  assert(
    Object.keys(loaded).includes("default"),
    "v2 artifact must expose its plugin as the default export",
  );
  assert(
    Object.keys(definition).every((key) => key === "id" || key === "setup"),
    `unexpected plugin definition keys ${Object.keys(definition).join(",")}`,
  );

  const harness = createHarness();
  const cleanup = definition.setup(harness.context);
  const slots = harness.claims.map((claim) => ("append" in claim ? claim.append : "?"));
  assert(slots.includes("sidebar.content"), "setup did not claim the sidebar.content slot");
  assert(slots.includes("app"), "setup did not claim the app slot");
  // The plugin's semantic collapse key; the host namespaces it as
  // `plugin.<pluginId>.collapsed`, matching V1's `opencode-subagent-watch.collapsed`.
  assert(
    harness.storageKeys.join(",") === "collapsed",
    `unexpected storage key ${harness.storageKeys.join(",")}`,
  );
  assert(
    JSON.stringify(harness.storageInitials) === JSON.stringify([{ collapsed: true }]),
    `unexpected storage initial ${JSON.stringify(harness.storageInitials)}`,
  );
  if (typeof cleanup === "function") await cleanup();
} finally {
  await rm(work, { recursive: true, force: true });
}

console.log("smoke:v2 ok");
