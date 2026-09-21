/**
 * Focused tests for the per-view watch controller (`v2/watch.ts`).
 *
 * These cover what the render tests cannot observe precisely: event filtering
 * for unrelated sessions, `session.created` refresh gating, the finite list
 * request, bounded sync concurrency, and the guarantee that in-flight work from
 * a disposed view or a previous parent never commits.
 */
import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import {
  createSubagentWatch,
  directChildren,
  isDirectChild,
  runBounded,
  HYDRATION_CONCURRENCY,
  HYDRATION_LIMIT,
  type SubagentWatch,
} from "./watch.ts";
import { createHarness, tick, type Harness } from "./testing/harness.ts";

function mountWatch(
  harness: Harness,
  initialParent: string,
): {
  readonly watch: SubagentWatch;
  readonly parent: (value: string) => void;
  readonly dispose: () => void;
} {
  const [parent, setParent] = createSignal(initialParent);
  let disposeRoot: () => void = () => {};
  const watch = createRoot((dispose) => {
    disposeRoot = dispose;
    return createSubagentWatch(harness.context, parent);
  });
  return { watch, parent: setParent, dispose: disposeRoot };
}

describe("V2 controller helpers", () => {
  test("directChildren keeps only stored sessions whose parentID matches", () => {
    const harness = createHarness();
    harness.addSession({ id: "child-1", parentID: "parent", title: "Child" });
    harness.orphan("parent", "ghost-1");
    harness.addSession({ id: "other-1", parentID: "other", title: "Other" });
    harness.orphan("parent", "other-1");

    expect(directChildren(harness.context, "parent").map((child) => child.id)).toEqual(["child-1"]);
    expect(isDirectChild(harness.context, "parent", "child-1")).toBe(true);
    expect(isDirectChild(harness.context, "parent", "other-1")).toBe(false);
    expect(isDirectChild(harness.context, "parent", "missing")).toBe(false);
  });

  test("runBounded never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 11 }, (_, index) => index);
    await runBounded(items, 3, async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick();
      inFlight -= 1;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1);
  });
});

describe("V2 controller event filtering", () => {
  test("activity, error and retry events only touch direct children of the rendered parent", async () => {
    const harness = createHarness();
    harness.addSession({ id: "child-1", parentID: "parent", title: "Child" }, "running");
    harness.addSession({ id: "other-1", parentID: "other", title: "Other" }, "running");
    const { watch, dispose } = mountWatch(harness, "parent");
    await tick();

    harness.emit({
      id: "evt-child",
      created: 10,
      type: "session.tool.input.started",
      data: { sessionID: "child-1", assistantMessageID: "m1", id: "call-1", name: "grep" },
    });
    harness.emit({
      id: "evt-other",
      created: 10,
      type: "session.tool.input.started",
      data: { sessionID: "other-1", assistantMessageID: "m2", id: "call-2", name: "read" },
    });
    expect([...watch.activities().keys()]).toEqual(["child-1"]);
    expect(watch.activities().get("child-1")?.label).toBe("grep");

    harness.emit({
      id: "evt-other-fail",
      created: 11,
      type: "session.execution.failed",
      data: { sessionID: "other-1", error: { type: "x", message: "boom" } },
    });
    harness.emit({
      id: "evt-child-fail",
      created: 12,
      type: "session.execution.failed",
      data: { sessionID: "child-1", error: { type: "x", message: "boom" } },
    });
    harness.emit({
      id: "evt-other-retry",
      created: 13,
      type: "session.retry.scheduled",
      data: {
        sessionID: "other-1",
        assistantMessageID: "m2",
        attempt: 1,
        at: 0,
        error: { type: "x", message: "boom" },
      },
    });

    harness.setStatus("child-1", "idle");
    harness.setStatus("other-1", "idle");
    await tick();
    const byID = new Map(watch.records().map((record) => [record.session.id, record]));
    expect(byID.get("child-1")?.status).toBe("error");
    // The unrelated session is not a child of this view at all.
    expect(byID.has("other-1")).toBe(false);
    expect(watch.summary()).toEqual({ total: 1, active: 0, errors: 1 });

    dispose();
  });

  test("clearing events from unrelated sessions leave child activity intact", async () => {
    const harness = createHarness();
    harness.addSession({ id: "child-1", parentID: "parent", title: "Child" }, "running");
    harness.addSession({ id: "other-1", parentID: "other", title: "Other" }, "running");
    const { watch, dispose } = mountWatch(harness, "parent");
    await tick();

    harness.emit({
      id: "evt-child",
      created: 10,
      type: "session.tool.input.started",
      data: { sessionID: "child-1", assistantMessageID: "m1", id: "call-1", name: "grep" },
    });
    harness.emit({
      id: "evt-other-ok",
      created: 11,
      type: "session.execution.succeeded",
      data: { sessionID: "other-1" },
    });
    expect(watch.activities().get("child-1")?.label).toBe("grep");

    harness.emit({
      id: "evt-child-ok",
      created: 12,
      type: "session.execution.succeeded",
      data: { sessionID: "child-1" },
    });
    expect(watch.activities().size).toBe(0);

    dispose();
  });

  test("session.created only re-hydrates for a direct child of the rendered parent", async () => {
    const harness = createHarness();
    harness.addSession({ id: "child-1", parentID: "parent", title: "Child" });
    const { dispose } = mountWatch(harness, "parent");
    await tick();
    const calls = harness.listInputs.length;

    harness.emit({
      id: "evt-none",
      created: 1,
      type: "session.created",
      data: { sessionID: "x", slug: "x" },
    });
    harness.emit({
      id: "evt-other",
      created: 2,
      type: "session.created",
      data: { sessionID: "y", parentID: "other", slug: "y" },
    });
    await tick();
    expect(harness.listInputs.length).toBe(calls);

    harness.emit({
      id: "evt-child",
      created: 3,
      type: "session.created",
      data: { sessionID: "z", parentID: "parent", slug: "z" },
    });
    await tick();
    expect(harness.listInputs.length).toBe(calls + 1);
    expect(harness.listInputs.at(-1)).toEqual({
      parentID: "parent",
      order: "desc",
      limit: HYDRATION_LIMIT,
    });

    dispose();
  });
});

describe("V2 controller hydration", () => {
  test("requests a finite limit, hydrates every missing child and filters non-direct entries", async () => {
    const harness = createHarness();
    for (let index = 0; index < 3; index += 1) {
      harness.unsynced({
        id: `child-${index.toString().padStart(2, "0")}`,
        parentID: "parent",
        title: `Child ${index}`,
      });
    }
    harness.unsynced({ id: "impostor", parentID: "other", title: "Impostor" });
    const { watch, dispose } = mountWatch(harness, "parent");
    await tick();
    await tick();

    expect(harness.listInputs[0]).toEqual({
      parentID: "parent",
      order: "desc",
      limit: HYDRATION_LIMIT,
    });
    expect(harness.syncCalls).toHaveLength(3);
    expect(harness.syncCalls).not.toContain("impostor");
    expect(watch.loadState()).toBe("ready");

    dispose();
  });

  test("never hydrates past the bounded page, even when more children exist", async () => {
    const harness = createHarness();
    for (let index = 0; index < HYDRATION_LIMIT + 10; index += 1) {
      harness.unsynced({
        id: `child-${index.toString().padStart(3, "0")}`,
        parentID: "parent",
        title: `Child ${index}`,
      });
    }
    const { watch, dispose } = mountWatch(harness, "parent");
    await tick();
    await tick();

    // The list fake honors `input.limit`, so the page-size bound is behavioral.
    expect(harness.listInputs[0]).toEqual({
      parentID: "parent",
      order: "desc",
      limit: HYDRATION_LIMIT,
    });
    expect(harness.syncCalls).toHaveLength(HYDRATION_LIMIT);
    expect(watch.loadState()).toBe("ready");

    dispose();
  });

  test("hydrates a child past the old 20-item cutoff with at most four syncs in flight", async () => {
    const harness = createHarness();
    const total = 25;
    // Published newest-first, matching the host's `order: "desc"` response.
    for (let index = total - 1; index >= 0; index -= 1) {
      harness.unsynced({
        id: `child-${index.toString().padStart(2, "0")}`,
        parentID: "parent",
        title: `Child ${index}`,
        created: index * 1_000,
      });
    }
    harness.deferSync(true);
    const { watch, dispose } = mountWatch(harness, "parent");
    await tick();
    await tick();

    expect(harness.syncCalls).toHaveLength(HYDRATION_CONCURRENCY);
    expect(harness.syncMaxInFlight()).toBe(HYDRATION_CONCURRENCY);

    await harness.releaseSync();
    expect(harness.syncCalls).toHaveLength(total);
    expect(harness.syncMaxInFlight()).toBeLessThanOrEqual(HYDRATION_CONCURRENCY);
    // The oldest child sat beyond the previous 20-item cutoff: it is synced,
    // present in the panel model and visible in the bounded row list now.
    expect(harness.syncCalls).toContain("child-00");
    expect(watch.children().map((child) => child.id)).toContain("child-00");
    expect(watch.list().visible.map((record) => record.session.id)).toContain("child-00");
    expect(watch.loadState()).toBe("ready");

    dispose();
  });

  test("syncs at most HYDRATION_CONCURRENCY sessions at a time", async () => {
    const harness = createHarness();
    for (let index = 0; index < HYDRATION_CONCURRENCY + 2; index += 1) {
      harness.unsynced({ id: `child-${index}`, parentID: "parent", title: `Child ${index}` });
    }
    harness.deferSync(true);
    const { watch, dispose } = mountWatch(harness, "parent");
    await tick();
    await tick();

    expect(harness.syncInFlight()).toBe(HYDRATION_CONCURRENCY);
    expect(harness.syncMaxInFlight()).toBe(HYDRATION_CONCURRENCY);
    expect(watch.loadState()).toBe("loading");

    await harness.releaseSync();
    expect(harness.syncCalls).toHaveLength(HYDRATION_CONCURRENCY + 2);
    expect(harness.syncMaxInFlight()).toBe(HYDRATION_CONCURRENCY);
    expect(watch.loadState()).toBe("ready");

    dispose();
  });

  test("ignores in-flight syncs after disposal and never commits a stale result", async () => {
    const harness = createHarness();
    for (let index = 0; index < HYDRATION_CONCURRENCY + 1; index += 1) {
      harness.unsynced({ id: `child-${index}`, parentID: "parent", title: `Child ${index}` });
    }
    harness.deferSync(true);
    const { watch, dispose } = mountWatch(harness, "parent");
    await tick();
    await tick();
    expect(harness.syncInFlight()).toBe(HYDRATION_CONCURRENCY);

    dispose();
    await harness.releaseSync();
    expect(harness.syncCalls).toHaveLength(HYDRATION_CONCURRENCY);
    expect(watch.loadState()).toBe("loading");
    expect(harness.subscriptionCount()).toBe(0);
  });

  test("drops the previous parent's late list result and resets loading on parent change", async () => {
    const harness = createHarness();
    harness.unsynced({ id: "child-a", parentID: "parent-a", title: "Child A" });
    harness.unsynced({ id: "child-b", parentID: "parent-b", title: "Child B" });
    harness.deferLists(true);
    const { watch, parent, dispose } = mountWatch(harness, "parent-a");
    await tick();
    expect(harness.pendingListCount()).toBe(1);

    parent("parent-b");
    await tick();
    expect(watch.loadState()).toBe("loading");
    expect(harness.pendingListCount()).toBe(2);

    // The old parent's response lands last: it must not sync or mark ready.
    await harness.releaseLists(2);
    expect(harness.syncCalls).toEqual(["child-b"]);
    expect(watch.loadState()).toBe("ready");

    dispose();
  });

  test("a parent change drops the previous parent's children state", async () => {
    const harness = createHarness();
    harness.addSession({ id: "child-a", parentID: "parent-a", title: "Child A" }, "running");
    harness.addSession({ id: "child-b", parentID: "parent-b", title: "Child B" });
    const { watch, parent, dispose } = mountWatch(harness, "parent-a");
    await tick();

    harness.emit({
      id: "evt-a",
      created: 10,
      type: "session.tool.input.started",
      data: { sessionID: "child-a", assistantMessageID: "m1", id: "call-1", name: "grep" },
    });
    expect(watch.activities().size).toBe(1);

    parent("parent-b");
    await tick();
    await tick();
    expect(watch.activities().size).toBe(0);
    expect(watch.children().map((child) => child.id)).toEqual(["child-b"]);

    dispose();
  });

  test("unsubscribes every listener when disposed and is idempotent", async () => {
    const harness = createHarness();
    const { watch, dispose } = mountWatch(harness, "parent");
    await tick();
    expect(harness.subscriptionCount()).toBe(10);
    expect(watch.loadState()).toBe("ready");

    dispose();
    expect(harness.subscriptionCount()).toBe(0);
    dispose();
    expect(harness.subscriptionCount()).toBe(0);
  });
});

describe("V2 controller reconnect", () => {
  test("server.connected recovers an unavailable panel to ready", async () => {
    const harness = createHarness();
    harness.setListError("host down");
    const { watch, dispose } = mountWatch(harness, "parent");
    await tick();
    await tick();
    expect(watch.loadState()).toBe("unavailable");

    harness.setListError(undefined);
    harness.unsynced({ id: "late-1", parentID: "parent", title: "Late child" });
    harness.emit({ id: "evt-connected", type: "server.connected", data: {} });
    await tick();
    await tick();

    expect(watch.loadState()).toBe("ready");
    expect(watch.stale()).toBe(false);
    expect(harness.syncCalls).toEqual(["late-1"]);
    expect(watch.children().map((child) => child.id)).toEqual(["late-1"]);

    dispose();
  });

  test("server.connected clears staleness on a ready panel", async () => {
    const harness = createHarness();
    harness.addSession({ id: "child-1", parentID: "parent", title: "Child" });
    const { watch, dispose } = mountWatch(harness, "parent");
    await tick();
    await tick();
    expect(watch.loadState()).toBe("ready");
    expect(watch.stale()).toBe(false);

    harness.setListError("host down");
    harness.emit({
      id: "evt-created",
      created: 20,
      type: "session.created",
      data: { sessionID: "new-1", parentID: "parent", slug: "new-1" },
    });
    await tick();
    await tick();
    expect(watch.loadState()).toBe("ready");
    expect(watch.stale()).toBe(true);

    harness.setListError(undefined);
    harness.unsynced({ id: "late-1", parentID: "parent", title: "Late child" });
    harness.emit({ id: "evt-reconnected", type: "server.connected", data: {} });
    await tick();
    await tick();

    expect(watch.loadState()).toBe("ready");
    expect(watch.stale()).toBe(false);
    expect(harness.syncCalls).toEqual(["late-1"]);

    dispose();
  });

  test("coalesces duplicate synchronous reconnect signals into one refresh", async () => {
    const harness = createHarness();
    const { watch, dispose } = mountWatch(harness, "parent");
    await tick();
    await tick();
    const calls = harness.listInputs.length;

    harness.emit({ id: "evt-connected-1", type: "server.connected", data: {} });
    harness.emit({ id: "evt-connected-2", type: "server.connected", data: {} });
    harness.emit({ id: "evt-connected-3", type: "server.connected", data: {} });
    await tick();
    await tick();

    expect(harness.listInputs.length).toBe(calls + 1);
    expect(harness.listInputs.at(-1)).toEqual({
      parentID: "parent",
      order: "desc",
      limit: HYDRATION_LIMIT,
    });
    expect(watch.loadState()).toBe("ready");

    // A later, separate reconnect still refreshes.
    harness.emit({ id: "evt-connected-4", type: "server.connected", data: {} });
    await tick();
    await tick();
    expect(harness.listInputs.length).toBe(calls + 2);

    dispose();
  });

  test("a queued reconnect refresh never fires after disposal", async () => {
    const harness = createHarness();
    const { watch, dispose } = mountWatch(harness, "parent");
    await tick();
    await tick();
    const calls = harness.listInputs.length;

    harness.emit({ id: "evt-connected", type: "server.connected", data: {} });
    dispose();
    await tick();
    await tick();

    expect(harness.listInputs.length).toBe(calls);
    expect(harness.subscriptionCount()).toBe(0);
    expect(watch.loadState()).toBe("ready");

    dispose();
    expect(harness.subscriptionCount()).toBe(0);
  });
});
