/**
 * Package and V1 regression tests for the V2 entrypoint.
 *
 * The V2 work must not disturb the published V1 surface: the root `./tui`
 * export still points at the V1 build, and the V1 sidebar state constants stay
 * order 60 / `opencode-subagent-watch.collapsed` / default collapsed. The V2
 * package is a local, private artifact whose `.` and `./tui` exports both load
 * the dedicated build output.
 */
import { describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin/tui";
import {
  DEFAULT_COLLAPSED,
  COLLAPSED_KEY,
  PLUGIN_ID,
  SIDEBAR_ORDER,
} from "../src/sidebar-state.ts";
import v1 from "../src/tui.tsx";

// The runtime provides `@opencode/plugin/tui` through the OpenTUI module map,
// so the built artifact can only load with that module stubbed. `define` is the
// only runtime member the artifact uses.
mock.module("@opencode/plugin/tui", () => ({
  Plugin: {
    define: (definition: Plugin.Definition): Plugin.Definition => definition,
  },
}));

const root = join(import.meta.dir, "..");

type RootManifest = {
  readonly exports: Readonly<Record<string, { readonly import?: string } | string>>;
  readonly files?: readonly string[];
  readonly scripts?: Readonly<Record<string, string>>;
};

type V2Manifest = {
  readonly name: string;
  readonly private?: boolean;
  readonly type?: string;
  readonly exports: Readonly<Record<string, string>>;
  readonly files?: readonly string[];
  readonly scripts?: Readonly<Record<string, string>>;
};

async function readJSON<T>(path: string): Promise<T> {
  return (await Bun.file(path).json()) as T;
}

describe("root V1 package contract", () => {
  test("keeps the ./tui export on the V1 build", async () => {
    const manifest = await readJSON<RootManifest>(join(root, "package.json"));
    const tui = manifest.exports["./tui"];
    expect(typeof tui === "string" ? tui : tui?.import).toBe("./dist/tui.js");
    expect(manifest.files).toContain("dist");
    expect(manifest.exports["."]).toBeUndefined();
  });

  test("exports the V1 TUI plugin module under its stable id", () => {
    expect(v1.id).toBe(PLUGIN_ID);
    expect(PLUGIN_ID).toBe("opencode-subagent-watch");
    expect(typeof v1.tui).toBe("function");
  });

  test("keeps V1 sidebar order, storage key and collapse default", () => {
    expect(SIDEBAR_ORDER).toBe(60);
    expect(COLLAPSED_KEY).toBe("opencode-subagent-watch.collapsed");
    expect(DEFAULT_COLLAPSED).toBe(true);
  });

  test("orders Subagents after Token Cache and before core Todo", () => {
    // V1 slot orders: Token Cache 55, core Context 100, MCP 200, LSP 300,
    // core Todo 400. 60 yields Token Cache → Subagents → Todo.
    expect(SIDEBAR_ORDER).toBeGreaterThan(55);
    expect(SIDEBAR_ORDER).toBeLessThan(400);
  });
});

describe("V2 package contract", () => {
  test("exports both entrypoints as the dedicated build output", async () => {
    const manifest = await readJSON<V2Manifest>(join(root, "v2/package.json"));
    expect(manifest.exports["."]).toBe("./dist/tui.js");
    expect(manifest.exports["./tui"]).toBe("./dist/tui.js");
    expect(manifest.files).toEqual(["dist"]);
    expect(manifest.type).toBe("module");
    expect(manifest.private).toBe(true);
  });

  test("builds from the TypeScript source with the dedicated script", async () => {
    const manifest = await readJSON<V2Manifest>(join(root, "v2/package.json"));
    expect(manifest.scripts?.["build"]).toBe("bun scripts/build.ts");
    expect(existsSync(join(root, "v2/tui.tsx"))).toBe(true);
    expect(existsSync(join(root, "v2/scripts/build.ts"))).toBe(true);
  });

  test("adds only narrow root scripts for the V2 build and smoke", async () => {
    const manifest = await readJSON<RootManifest>(join(root, "package.json"));
    const build = manifest.scripts?.["build"];
    const check = manifest.scripts?.["check"];
    expect(manifest.scripts?.["build:v2"]).toBe("bun v2/scripts/build.ts");
    expect(manifest.scripts?.["smoke:v2"]).toBe("bun scripts/smoke-v2-package.ts");
    expect(build).toBe("bun scripts/build.ts");
    expect(check).toContain("build:v2");
    expect(check).toContain("build");
    expect(check).toContain("smoke-package");
    expect(check).toContain("smoke:v2");
  });

  test("tracks the committed V2 artifact despite the dist ignore rule", () => {
    expect(existsSync(join(root, "v2/dist/tui.js"))).toBe(true);
  });

  test("the built artifact dynamically imports and exposes { id, setup }", async () => {
    const loaded = (await import("./dist/tui.js")) as { default?: Plugin.Definition };
    expect(loaded.default).toBeDefined();
    expect(loaded.default?.id).toBe("opencode-subagent-watch-v2-tui");
    expect(typeof loaded.default?.setup).toBe("function");
  });
});
