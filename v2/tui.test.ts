/**
 * End-to-end tests for the V2 TUI entrypoint.
 *
 * These mount the real plugin through a typed fake `Plugin.Context` and render
 * its slot claims in an OpenTUI test renderer, so they cover the pieces the
 * pure display-model and controller tests cannot: `Plugin.define` wiring, the
 * slot/input contract, rendering, click-to-navigate, and durable collapse
 * storage through the real `toggle`.
 */
import { describe, expect, mock, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type { TestRendererSetup } from "@opentui/core/testing";
import type { Plugin } from "@opencode/plugin/tui";
import { displayWidth } from "../src/terminal-text.ts";
import { createHarness, tick, type Harness } from "./testing/harness.ts";

// The V2 runtime injects `@opencode/plugin/tui` through the OpenTUI runtime
// module map, so the module does not exist on disk. `Plugin.define` is the
// only runtime member this entrypoint uses; mock it with the real contract.
mock.module("@opencode/plugin/tui", () => ({
  Plugin: {
    define: (definition: Plugin.Definition): Plugin.Definition => definition,
  },
}));

const v2 = await import("./tui.tsx");
const plugin = v2.default;
const { SIDEBAR_SLOT, SIDEBAR_PLACEMENT, COLLAPSED_KEY } = v2;

const WIDTH = 40;

async function mount(
  harness: Harness,
  sessionID: string,
  width = WIDTH,
  height = 14,
): Promise<TestRendererSetup> {
  const setup = await testRender(() => harness.sidebar(sessionID), { width, height });
  await setup.flush();
  return setup;
}

function lineOf(frame: string, needle: string): number {
  const index = frame.split("\n").findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`missing ${JSON.stringify(needle)} in frame:\n${frame}`);
  return index;
}

async function click(setup: TestRendererSetup, x: number, y: number): Promise<void> {
  await setup.mockMouse.click(x, y);
  await setup.flush();
}

function setupPlugin(options?: { persisted?: unknown }): Harness {
  const harness = createHarness(options);
  const cleanup = plugin.setup(harness.context);
  expect(cleanup === undefined || typeof cleanup === "function").toBe(true);
  return harness;
}

describe("V2 plugin definition", () => {
  test("exports the public Plugin.define module shape with a stable id", () => {
    expect(plugin.id).toBe("opencode-subagent-watch-v2-tui");
    expect(typeof plugin.setup).toBe("function");
  });

  test("appends to sidebar.content with sessionID input and exposes the app command", () => {
    const harness = setupPlugin();
    expect(harness.claims.map((claim) => ("append" in claim ? claim.append : "?"))).toEqual([
      "sidebar.content",
      "app",
    ]);
    expect(harness.keymapLayers).toHaveLength(0);
    // The app claim only runs when the host renders the app slot.
    harness.app();
    expect(harness.keymapLayers[0]?.mode).toBe("global");
    expect(harness.keymapLayers[0]?.commands?.[0]?.id).toBe("subagent-watch.toggle");
    expect(harness.keymapLayers[0]?.commands?.[0]?.bind).toBe(false);
  });

  test("claims exactly one sidebar.content append and no other placement", () => {
    const harness = setupPlugin();
    const sidebar = harness.claims.filter(
      (claim) => "append" in claim && claim.append === SIDEBAR_SLOT,
    );
    expect(sidebar).toHaveLength(1);
    // V2 has no numeric order: a claim is exactly one of
    // prepend/append/before/after/replace (packages/plugin/src/tui/context.ts:224-262),
    // so `append` is the closest stable match for V1's `order: 60`. A `prepend`
    // would render ahead of the built-in sections and `replace` would suppress
    // them, so neither is a parity option.
    expect(SIDEBAR_SLOT).toBe("sidebar.content");
    expect(SIDEBAR_PLACEMENT).toBe("append");
    expect(Object.keys(sidebar[0]!).toSorted()).toEqual(["append", "render"]);
    // The host decides position from plugin enable order, so the claim carries
    // no ordering hint at all.
    for (const other of ["prepend", "before", "after", "replace"]) {
      expect(sidebar[0]).not.toHaveProperty(other);
    }
  });

  test("reuses the V1 collapse default and its semantic key", () => {
    const harness = setupPlugin();
    // V1 owns `order: 60` / `opencode-subagent-watch.collapsed`; V2 matches the
    // *semantic* key (`collapsed`, namespaced by the host as
    // `plugin.<pluginId>.collapsed`) and the same `true` default.
    expect(COLLAPSED_KEY).toBe("collapsed");
    expect(harness.storageKeys).toEqual(["collapsed"]);
    expect(harness.storageInitials).toEqual([{ collapsed: true }]);
  });
});

describe("V2 rendering and tracking", () => {
  test("renders header counts, busy rows and settled rows", async () => {
    const harness = setupPlugin({ persisted: { collapsed: false } });
    harness.addSession(
      { id: "busy-1", parentID: "parent", title: "Locate auth flow", agent: "explore" },
      "running",
    );
    harness.addSession(
      {
        id: "idle-1",
        parentID: "parent",
        title: "Review diff",
        agent: "reviewer",
        cost: 0.03,
        created: 2_000,
        updated: 3_000,
      },
      "idle",
    );

    const setup = await mount(harness, "parent");
    try {
      const frame = await setup.waitForFrame((value) => value.includes("▼ Subagents"));
      expect(frame).toContain("▼ Subagents · 1 active · 2 total");
      expect(frame).toContain("* busy · Locate auth flow");
      expect(frame).toContain("- idle · Review diff");
      // Every row leads with the nesting level resolved from the parent chain:
      // these are direct children of the rendered session, so they are L1.
      expect(frame).toContain("L1 · * busy · Locate auth flow");
      expect(frame).toContain("L1 · - idle · Review diff");
      // The adapter asked the host for this parent's children, newest first,
      // with a finite page size.
      expect(harness.listInputs).toContainEqual({ parentID: "parent", order: "desc", limit: 50 });
    } finally {
      setup.renderer.destroy();
    }
  });

  test("tracks tool activity and error/retry marks from host events", async () => {
    const harness = setupPlugin({ persisted: { collapsed: false } });
    harness.addSession(
      { id: "busy-1", parentID: "parent", title: "Locate auth flow", agent: "explore" },
      "running",
    );
    harness.addSession({ id: "idle-1", parentID: "parent", title: "Review diff" }, "idle");

    const setup = await mount(harness, "parent");
    try {
      await setup.waitForFrame((value) => value.includes("- idle · Review diff"));
      const observedAt = Date.now();
      harness.emit({
        id: "evt-tool",
        created: observedAt,
        type: "session.tool.input.started",
        data: {
          sessionID: "busy-1",
          assistantMessageID: "m1",
          id: "call-1",
          name: "grep",
        },
      });
      const activity = await setup.waitForFrame((value) => value.includes("grep"));
      expect(activity).toContain("ago");
      expect(activity).toContain("dur ");

      harness.emit({
        id: "evt-fail",
        created: observedAt,
        type: "session.execution.failed",
        data: { sessionID: "idle-1", error: { type: "x", message: "boom" } },
      });
      const failed = await setup.waitForFrame((value) => value.includes("! error · Review diff"));
      expect(failed).toContain("1 error");

      // Activity (not the error mark) is cleared when the run succeeds.
      harness.emit({
        id: "evt-ok",
        created: observedAt,
        type: "session.execution.succeeded",
        data: { sessionID: "busy-1" },
      });
      const cleared = await setup.waitForFrame((value) => !value.includes("grep"));
      expect(cleared).not.toContain("grep");

      // A session that runs again drops its error mark.
      harness.setStatus("idle-1", "running");
      const recovered = await setup.waitForFrame((value) => value.includes("* busy · Review diff"));
      expect(recovered).not.toContain("! error · Review diff");

      // Retry marks surface while the session is idle again.
      harness.setStatus("idle-1", "idle");
      harness.emit({
        id: "evt-retry",
        created: observedAt,
        type: "session.retry.scheduled",
        data: {
          sessionID: "idle-1",
          assistantMessageID: "m1",
          attempt: 1,
          at: 0,
          error: { type: "x", message: "boom" },
        },
      });
      const retry = await setup.waitForFrame((value) => value.includes("~ retry · Review diff"));
      expect(retry).toContain("retry");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("syncs children the host has not loaded yet", async () => {
    const harness = setupPlugin({ persisted: { collapsed: false } });
    harness.unsynced({ id: "late-1", parentID: "parent", title: "Late subagent" });

    const setup = await mount(harness, "parent");
    try {
      const frame = await setup.waitForFrame((value) => value.includes("Late subagent"));
      expect(harness.syncCalls).toContain("late-1");
      // Restored from the host store by hydration, and still resolved to L1.
      expect(frame).toContain("L1 · - idle · Late subagent");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("unsubscribes its event adapters when disposed", async () => {
    const harness = setupPlugin();
    const setup = await mount(harness, "parent");
    expect(harness.subscriptionCount()).toBe(10);
    setup.renderer.destroy();
    await setup.flush();
    expect(harness.subscriptionCount()).toBe(0);
  });

  test("ignores events from sessions that are not direct children of this view", async () => {
    const harness = setupPlugin({ persisted: { collapsed: false } });
    harness.addSession({ id: "busy-1", parentID: "parent", title: "Locate auth flow" }, "running");
    harness.addSession({ id: "other-1", parentID: "other", title: "Other" }, "running");

    const setup = await mount(harness, "parent");
    try {
      await setup.waitForFrame((value) => value.includes("* busy · Locate auth flow"));
      harness.emit({
        id: "evt-other-tool",
        created: Date.now(),
        type: "session.tool.input.started",
        data: { sessionID: "other-1", assistantMessageID: "m2", id: "call-2", name: "secretTool" },
      });
      harness.emit({
        id: "evt-other-fail",
        created: Date.now(),
        type: "session.execution.failed",
        data: { sessionID: "other-1", error: { type: "x", message: "boom" } },
      });
      const frame = await setup.waitForFrame((value) => value.includes("1 total"));
      expect(frame).not.toContain("secretTool");
      expect(frame).not.toContain("error");
      expect(frame).not.toContain("Other");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("only a session.created for this parent refreshes the list", async () => {
    const harness = setupPlugin({ persisted: { collapsed: false } });
    harness.addSession({ id: "busy-1", parentID: "parent", title: "Locate auth flow" }, "running");

    const setup = await mount(harness, "parent");
    try {
      await setup.waitForFrame((value) => value.includes("Locate auth flow"));
      const baseline = harness.listInputs.length;

      harness.emit({
        id: "evt-unrelated",
        created: Date.now(),
        type: "session.created",
        data: { sessionID: "elsewhere", parentID: "other", slug: "elsewhere" },
      });
      await setup.flush();
      expect(harness.listInputs.length).toBe(baseline);

      harness.unsynced({ id: "late-1", parentID: "parent", title: "Late subagent" });
      harness.emit({
        id: "evt-child",
        created: Date.now(),
        type: "session.created",
        data: { sessionID: "late-1", parentID: "parent", slug: "late-1" },
      });
      const frame = await setup.waitForFrame((value) => value.includes("Late subagent"));
      expect(harness.listInputs.length).toBe(baseline + 1);
      expect(frame).toContain("- idle · Late subagent");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("recovers from unavailable when the host reconnects", async () => {
    const harness = setupPlugin({ persisted: { collapsed: false } });
    harness.setListError("host down");

    const setup = await mount(harness, "parent");
    try {
      await setup.waitForFrame((value) => value.includes("Subagents unavailable"));

      harness.setListError(undefined);
      harness.unsynced({ id: "late-1", parentID: "parent", title: "Late subagent" });
      harness.emit({ id: "evt-connected", type: "server.connected", data: {} });

      const frame = await setup.waitForFrame((value) => value.includes("Late subagent"));
      expect(frame).toContain("Subagents");
      // The reconnect refresh leaves the storage-owned collapse state alone.
      expect(harness.collapsed()).toBe(false);
      expect(harness.storageWrites).toHaveLength(0);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("a duplicate synchronous reconnect refreshes once and keeps the panel expanded", async () => {
    const harness = setupPlugin({ persisted: { collapsed: false } });
    harness.addSession({ id: "busy-1", parentID: "parent", title: "Locate auth flow" }, "running");

    const setup = await mount(harness, "parent");
    try {
      await setup.waitForFrame((value) => value.includes("Locate auth flow"));
      const baseline = harness.listInputs.length;

      harness.emit({ id: "evt-connected-1", type: "server.connected", data: {} });
      harness.emit({ id: "evt-connected-2", type: "server.connected", data: {} });
      await tick();
      await setup.flush();

      expect(harness.listInputs.length).toBe(baseline + 1);
      expect(harness.collapsed()).toBe(false);
      expect(harness.storageWrites).toHaveLength(0);
      const frame = await setup.waitForFrame((value) => value.includes("Locate auth flow"));
      expect(frame).toContain("▼ Subagents");
    } finally {
      setup.renderer.destroy();
    }
  });
});

describe("V2 navigation", () => {
  test("clicking a child row clears the dialog and navigates to that session", async () => {
    const harness = setupPlugin({ persisted: { collapsed: false } });
    harness.addSession({ id: "busy-1", parentID: "parent", title: "Locate auth flow" }, "running");

    const setup = await mount(harness, "parent");
    try {
      const frame = await setup.waitForFrame((value) =>
        value.includes("* busy · Locate auth flow"),
      );
      await click(setup, 4, lineOf(frame, "* busy · Locate auth flow"));
      expect(harness.dialogClears).toEqual(["clear"]);
      expect(harness.routerCalls).toEqual([{ type: "session", sessionID: "busy-1" }]);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("clicking the header toggles instead of navigating", async () => {
    const harness = setupPlugin({ persisted: { collapsed: false } });
    harness.addSession({ id: "busy-1", parentID: "parent", title: "Locate auth flow" }, "running");

    const setup = await mount(harness, "parent");
    try {
      const frame = await setup.waitForFrame((value) => value.includes("▼ Subagents"));
      await click(setup, 4, lineOf(frame, "▼ Subagents"));
      expect(harness.routerCalls).toHaveLength(0);
      expect(harness.collapsed()).toBe(true);
      await setup.waitForFrame((value) => value.includes("▶ Subagents"));
    } finally {
      setup.renderer.destroy();
    }
  });
});

describe("V2 storage", () => {
  test("uses the deterministic key and initial state", () => {
    const harness = setupPlugin();
    expect(harness.storageKeys).toEqual(["collapsed"]);
    expect(harness.storageInitials).toEqual([{ collapsed: true }]);
    expect(harness.collapsed()).toBeUndefined();
  });

  test("starts collapsed, hides the list, and persists the toggle both ways", async () => {
    const harness = setupPlugin();
    harness.addSession({ id: "busy-1", parentID: "parent", title: "Locate auth flow" }, "running");

    const setup = await mount(harness, "parent");
    try {
      const collapsed = await setup.waitForFrame((value) => value.includes("▶ Subagents"));
      expect(collapsed).not.toContain("Locate auth flow");
      expect(collapsed).not.toContain("No subagents");

      await click(setup, 4, lineOf(collapsed, "▶ Subagents"));
      expect(harness.collapsed()).toBe(false);
      const expanded = await setup.waitForFrame((value) => value.includes("Locate auth flow"));
      expect(expanded).toContain("▼ Subagents");

      await click(setup, 4, lineOf(expanded, "▼ Subagents"));
      expect(harness.collapsed()).toBe(true);
      await setup.waitForFrame((value) => !value.includes("Locate auth flow"));
    } finally {
      setup.renderer.destroy();
    }
  });

  test("a hot reload reuses the durable store and never rewrites the default", async () => {
    const harness = setupPlugin();
    harness.addSession({ id: "busy-1", parentID: "parent", title: "Locate auth flow" }, "running");

    const first = await mount(harness, "parent");
    try {
      const collapsed = await first.waitForFrame((value) => value.includes("▶ Subagents"));
      await click(first, 4, lineOf(collapsed, "▶ Subagents"));
      expect(harness.collapsed()).toBe(false);
      expect(harness.storageWrites).toEqual([false]);
    } finally {
      first.renderer.destroy();
    }

    // The host keeps one store per key, so a second setup (plugin hot reload)
    // restores what the first one persisted and writes nothing at startup.
    plugin.setup(harness.context);
    expect(harness.storageKeys).toEqual(["collapsed"]);
    expect(harness.storageInitials).toEqual([{ collapsed: true }]);
    expect(harness.storageWrites).toEqual([false]);

    const reloaded = await mount(harness, "parent");
    try {
      const frame = await reloaded.waitForFrame((value) => value.includes("Locate auth flow"));
      expect(frame).toContain("▼ Subagents");
      expect(harness.storageWrites).toEqual([false]);
      expect(harness.collapsed()).toBe(false);
    } finally {
      reloaded.renderer.destroy();
    }
  });

  test("restores a persisted expanded state", async () => {
    const harness = setupPlugin({ persisted: { collapsed: false } });
    harness.addSession({ id: "busy-1", parentID: "parent", title: "Locate auth flow" }, "running");

    const setup = await mount(harness, "parent");
    try {
      const frame = await setup.waitForFrame((value) => value.includes("Locate auth flow"));
      expect(frame).toContain("▼ Subagents");
      expect(harness.collapsed()).toBe(false);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("survives a failing host list and reports unavailable", async () => {
    const harness = setupPlugin({ persisted: { collapsed: false } });
    harness.setListError("host down");

    const setup = await mount(harness, "parent");
    try {
      const frame = await setup.waitForFrame((value) => value.includes("Subagents unavailable"));
      expect(frame).toContain("Subagents unavailable");
      expect(frame).not.toContain("No subagents");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("keeps the ready panel and marks it stale when a refresh fails", async () => {
    const harness = setupPlugin({ persisted: { collapsed: false } });
    harness.addSession({ id: "busy-1", parentID: "parent", title: "Locate auth flow" }, "running");

    const setup = await mount(harness, "parent");
    try {
      await setup.waitForFrame((value) => value.includes("Locate auth flow"));
      harness.setListError("host down");
      // `session.created` for this parent re-runs the client adapter.
      harness.emit({
        id: "evt-created",
        created: Date.now(),
        type: "session.created",
        data: { sessionID: "new-1", parentID: "parent", slug: "new-1" },
      });
      const frame = await setup.waitForFrame((value) => value.includes("stale"));
      expect(frame).toContain("stale");
      expect(frame).toContain("Locate auth flow");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("accepts only a boolean persisted collapsed value and never writes over malformed state", async () => {
    for (const persisted of [
      undefined,
      {},
      { collapsed: "yes" },
      { collapsed: 1 },
      { collapsed: null },
    ]) {
      const harness = setupPlugin({ persisted });
      const setup = await mount(harness, "parent");
      try {
        const frame = await setup.waitForFrame((value) => value.includes("▶ Subagents"));
        expect(frame).toContain("▶ Subagents");
        expect(frame).not.toContain("No subagents");
        await setup.flush();
        expect(harness.storageWrites).toHaveLength(0);
        expect(harness.collapsed()).toBeUndefined();
      } finally {
        setup.renderer.destroy();
      }
    }
  });

  test("preserves an explicit persisted true or false", async () => {
    const expanded = setupPlugin({ persisted: { collapsed: false } });
    const expandedSetup = await mount(expanded, "parent");
    try {
      const frame = await expandedSetup.waitForFrame((value) => value.includes("▼ Subagents"));
      expect(frame).toContain("▼ Subagents");
      expect(expanded.storageWrites).toHaveLength(0);
      expect(expanded.collapsed()).toBe(false);
    } finally {
      expandedSetup.renderer.destroy();
    }

    const collapsed = setupPlugin({ persisted: { collapsed: true } });
    const collapsedSetup = await mount(collapsed, "parent");
    try {
      await collapsedSetup.waitForFrame((value) => value.includes("▶ Subagents"));
      expect(collapsed.storageWrites).toHaveLength(0);
      expect(collapsed.collapsed()).toBe(true);
    } finally {
      collapsedSetup.renderer.destroy();
    }
  });

  test("serializes rapid toggles so delayed mutation results stay deterministic", async () => {
    const harness = setupPlugin({ persisted: { collapsed: true } });
    harness.addSession({ id: "busy-1", parentID: "parent", title: "Locate auth flow" }, "running");
    harness.deferMutations(true);

    const setup = await mount(harness, "parent");
    try {
      const collapsed = await setup.waitForFrame((value) => value.includes("▶ Subagents"));
      await click(setup, 4, lineOf(collapsed, "▶ Subagents"));
      const expanded = await setup.waitForFrame((value) => value.includes("Locate auth flow"));
      expect(harness.pendingMutationCount()).toBe(1);

      await click(setup, 4, lineOf(expanded, "▼ Subagents"));
      // The second toggle waits for the first write instead of racing it.
      expect(harness.pendingMutationCount()).toBe(1);
      expect(harness.collapsed()).toBe(true);

      await harness.flushMutations();
      expect(harness.storageWrites).toEqual([false, true]);
      expect(harness.collapsed()).toBe(true);
      const settled = await setup.waitForFrame((value) => value.includes("▶ Subagents"));
      expect(settled).toContain("▶ Subagents");
    } finally {
      setup.renderer.destroy();
      await tick();
    }
  });

  test("a rejected mutation is swallowed and later toggles still persist", async () => {
    const harness = setupPlugin({ persisted: { collapsed: false } });
    harness.addSession({ id: "busy-1", parentID: "parent", title: "Locate auth flow" }, "running");
    harness.failMutations("disk full");

    const setup = await mount(harness, "parent");
    try {
      const expanded = await setup.waitForFrame((value) => value.includes("Locate auth flow"));
      await click(setup, 4, lineOf(expanded, "▼ Subagents"));
      await tick();
      expect(harness.storageWrites).toHaveLength(0);

      harness.failMutations(undefined);
      const collapsed = await setup.waitForFrame((value) => value.includes("▶ Subagents"));
      await click(setup, 4, lineOf(collapsed, "▶ Subagents"));
      await tick();
      expect(harness.storageWrites).toEqual([false]);
      expect(harness.collapsed()).toBe(false);
    } finally {
      setup.renderer.destroy();
    }
  });
});

describe("V2 absent and narrow rendering", () => {
  test("renders an empty panel when the parent and children are absent", async () => {
    const harness = setupPlugin({ persisted: { collapsed: false } });
    const setup = await mount(harness, "missing-parent");
    try {
      const frame = await setup.waitForFrame((value) => value.includes("No subagents"));
      expect(frame).toContain("▼ Subagents · none");
      expect(frame).toContain("No subagents");
      expect(harness.listInputs).toContainEqual({
        parentID: "missing-parent",
        order: "desc",
        limit: 50,
      });
      expect(harness.syncCalls).toHaveLength(0);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("ignores family entries whose session is not in the store", async () => {
    const harness = setupPlugin({ persisted: { collapsed: false } });
    harness.orphan("parent", "ghost-1");
    harness.addSession({ id: "real-1", parentID: "parent", title: "Real subagent" });

    const setup = await mount(harness, "parent");
    try {
      const frame = await setup.waitForFrame((value) => value.includes("Real subagent"));
      expect(frame).not.toContain("ghost-1");
      expect(frame).toContain("1 total");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("bounds every rendered line in a narrow panel", async () => {
    const harness = setupPlugin({ persisted: { collapsed: false } });
    const title = "a very long subagent title that must truncate";
    harness.addSession({ id: "busy-1", parentID: "parent", title, agent: "explore" }, "running");

    const setup = await mount(harness, "parent", 10, 14);
    try {
      const frame = await setup.waitForFrame((value) => value.includes("busy"));
      expect(frame).not.toContain(title);
      expect(frame).toContain("…");
      // At this width the level yields to the status and title, so the row
      // stays readable instead of collapsing to a bare prefix.
      expect(frame).toContain("* busy ·");
      expect(frame).not.toContain("L1");

      const captured = setup.captureSpans();
      for (const line of captured.lines) {
        const width = line.spans.reduce((total, span) => total + span.width, 0);
        expect(width).toBeLessThanOrEqual(captured.cols);
        const text = line.spans.map((span) => span.text).join("");
        expect(displayWidth(text)).toBeLessThanOrEqual(captured.cols);
      }
    } finally {
      setup.renderer.destroy();
    }
  });
});
