/**
 * Focused tests for the V2 display model.
 *
 * These cover the pure behaviour ported from the V1 modules (status, timing,
 * activity, sorting, header, row layout). Runtime activation is proven by the
 * protected V2 smoke, not here.
 */
import { describe, expect, test } from "bun:test";
import { displayWidth } from "../src/terminal-text.ts";
import {
  advanceTimings,
  clearActivity,
  clearSettled,
  depthLabel,
  differingModel,
  displayStatus,
  displayTitle,
  formatCost,
  formatDuration,
  headerLine,
  headerSegments,
  LIST_LIMIT,
  MAX_DEPTH,
  observeActivity,
  outlineRecords,
  pruneActivity,
  pruneList,
  pruneRecord,
  resolveDepth,
  resolveSessionModel,
  rowLines,
  sortAndPrune,
  summarize,
  type ActivityMap,
  type DisplayStatus,
  type RunTiming,
  type SessionLookup,
  type SubagentRecord,
} from "./subagents.ts";

const NOW = 1_000_000;

function record(input: {
  id: string;
  /** Defaults to the rendered session, i.e. a direct child. */
  parentID?: string;
  status?: DisplayStatus;
  created?: number;
  updated?: number;
  title?: string;
  agent?: string;
  cost?: number;
  timing?: RunTiming;
  errorAt?: number;
  /** Defaults to 1, i.e. a resolved direct child of the rendered session. */
  depth?: number;
}): SubagentRecord {
  return {
    session: {
      id: input.id,
      parentID: input.parentID ?? "parent",
      title: input.title ?? input.id,
      agent: input.agent ?? "explore",
      model: { providerID: "openrouter", id: "deepseek-v3.2" },
      cost: input.cost ?? 0,
      time: { created: input.created ?? NOW, updated: input.updated ?? NOW },
    },
    status: input.status ?? "idle",
    timing: input.timing,
    errorAt: input.errorAt,
    depth: input.depth ?? 1,
  };
}

type ChainEntry = { readonly id: string; readonly parentID?: string };

/** Stored-session lookup over a flat parent chain, as the host store provides. */
function chain(entries: readonly ChainEntry[]): SessionLookup {
  const byID = new Map(entries.map((entry) => [entry.id, entry]));
  return (sessionID) => {
    const entry = byID.get(sessionID);
    if (!entry) return undefined;
    return {
      id: entry.id,
      parentID: entry.parentID,
      cost: 0,
      time: { created: NOW, updated: NOW },
    };
  };
}

describe("displayStatus", () => {
  test("running wins over stale marks", () => {
    expect(displayStatus({ running: true, errorAt: 5, retryAt: 6 })).toBe("busy");
  });

  test("retry and error surface while idle", () => {
    expect(displayStatus({ running: false, retryAt: 20 })).toBe("retry");
    expect(displayStatus({ running: false, errorAt: 10 })).toBe("error");
    expect(displayStatus({ running: false })).toBe("idle");
  });

  test("the newest mark wins when both are present", () => {
    expect(displayStatus({ running: false, errorAt: 30, retryAt: 20 })).toBe("error");
    expect(displayStatus({ running: false, errorAt: 20, retryAt: 30 })).toBe("retry");
  });
});

describe("advanceTimings", () => {
  test("starts a run when a session becomes active", () => {
    expect(advanceTimings({}, { a: true }, NOW)).toEqual({ a: { startedAt: NOW } });
  });

  test("ends the run when the session settles", () => {
    expect(advanceTimings({ a: { startedAt: NOW - 5_000 } }, { a: false }, NOW)).toEqual({
      a: { startedAt: NOW - 5_000, endedAt: NOW },
    });
  });

  test("is stable across no-op transitions", () => {
    const previous = { a: { startedAt: NOW - 5_000, endedAt: NOW - 1_000 } };
    expect(advanceTimings(previous, { a: false }, NOW)).toBe(previous);
    const running = { a: { startedAt: NOW - 5_000 } };
    expect(advanceTimings(running, { a: true }, NOW)).toBe(running);
  });

  test("restarts timing after a settled run", () => {
    const previous = { a: { startedAt: 0, endedAt: 10 } };
    expect(advanceTimings(previous, { a: true }, NOW)).toEqual({ a: { startedAt: NOW } });
  });
});

describe("clearSettled / prune helpers", () => {
  test("drops marks for running sessions only", () => {
    const marks = { a: 1, b: 2 };
    expect(clearSettled(marks, { a: true })).toEqual({ b: 2 });
    expect(clearSettled(marks, { a: true, b: true })).toEqual({});
    expect(clearSettled(marks, {})).toBe(marks);
  });

  test("prunes records and activity maps to the live children", () => {
    expect(pruneRecord({ a: 1, b: 2 }, new Set(["a"]))).toEqual({ a: 1 });
    const activities: ActivityMap = new Map([
      ["a", { label: "grep", observedAt: 1 }],
      ["b", { label: "read", observedAt: 2 }],
    ]);
    expect([...pruneActivity(activities, new Set(["b"])).keys()]).toEqual(["b"]);
  });
});

describe("activity", () => {
  const base: ActivityMap = new Map([["a", { label: "grep", observedAt: NOW }]]);

  test("the first observation wins", () => {
    expect(observeActivity(base, "a", "read", NOW - 1)).toBe(base);
  });

  test("a new label replaces the old one immediately", () => {
    expect(observeActivity(base, "a", "read", NOW + 1).get("a")).toEqual({
      label: "read",
      observedAt: NOW + 1,
    });
  });

  test("a repeated label only refreshes beyond one second", () => {
    expect(observeActivity(base, "a", "grep", NOW + 500)).toBe(base);
    expect(observeActivity(base, "a", "grep", NOW + 1_500).get("a")?.observedAt).toBe(NOW + 1_500);
  });

  test("clearing unknown sessions is a no-op", () => {
    expect(clearActivity(base, "missing")).toBe(base);
    expect(clearActivity(base, "a").size).toBe(0);
  });
});

describe("summaries and headers", () => {
  const children = [
    record({ id: "active-1", status: "busy" }),
    record({ id: "active-2", status: "retry" }),
    record({ id: "error-1", status: "error", errorAt: NOW }),
    record({ id: "idle-1", status: "idle" }),
  ];

  test("summarize counts active and error rows", () => {
    expect(summarize(children)).toEqual({ total: 4, active: 2, errors: 1 });
  });

  test("header segments keep the V1 wording", () => {
    expect(headerSegments(summarize(children), false, 80)).toEqual([
      "▼ Subagents",
      "2 active",
      "1 error",
      "4 total",
    ]);
  });

  test("empty, collapsed and stale headers keep the V1 wording", () => {
    expect(headerLine({ total: 0, active: 0, errors: 0 }, false, 80)).toBe("▼ Subagents · none");
    expect(headerLine(summarize(children), true, 80)).toBe(
      "▶ Subagents · 2 active · 1 error · 4 total",
    );
    expect(headerLine({ total: 1, active: 0, errors: 0 }, false, 80, true)).toBe(
      "▼ Subagents · 1 total · stale",
    );
  });

  test("headers stay inside the measured width", () => {
    expect(displayWidth(headerLine(summarize(children), false, 12))).toBeLessThanOrEqual(12);
  });
});

describe("sortAndPrune", () => {
  test("orders active, then error, then idle and caps the list", () => {
    const children = [
      record({ id: "idle-new", updated: 90 }),
      record({ id: "idle-old", updated: 10 }),
      record({ id: "active-2", status: "busy", created: 20 }),
      record({ id: "active-1", status: "retry", created: 10 }),
      record({ id: "error-old", status: "error", errorAt: 1 }),
      record({ id: "error-new", status: "error", errorAt: 50 }),
      record({ id: "idle-3", updated: 5 }),
    ];
    const { visible, omitted } = sortAndPrune(children);
    expect(visible.map((child) => child.session.id)).toEqual([
      "active-1",
      "active-2",
      "error-new",
      "error-old",
      "idle-new",
    ]);
    expect(omitted).toBe(2);
  });
});

describe("rows", () => {
  test("busy rows show the latest activity beside the run duration", () => {
    const child = record({
      id: "busy",
      status: "busy",
      title: "Locate auth flow",
      timing: { startedAt: NOW - 120_000 },
    });
    const activity = { label: "grep", observedAt: NOW - 8_000 };
    const lines = rowLines(child, undefined, 40, NOW, activity);
    expect(lines.prefix).toBe("L1 · * busy · ");
    expect(lines.title).toBe("Locate auth flow");
    expect(lines.first).toBe("L1 · * busy · Locate auth flow");
    expect(lines.second).toContain("grep 8s ago");
    expect(lines.second).toContain("dur 2m");
    expect(displayWidth(lines.second!)).toBeLessThanOrEqual(40);
    expect(lines.third).toBe("  explore · openrouter/deepseek-v3.2");
  });

  test("settled rows show duration and cost", () => {
    const child = record({
      id: "idle",
      agent: "reviewer",
      cost: 0.03,
      timing: { startedAt: NOW - 43_000, endedAt: NOW },
    });
    const lines = rowLines(child, undefined, 40, NOW);
    expect(lines.second).toBe("  dur 43s · $0.03");
    expect(lines.third?.startsWith("  reviewer")).toBe(true);
  });

  test("rows never exceed the measured width", () => {
    const child = record({
      id: "narrow",
      status: "busy",
      title: "a very long subagent title that must truncate",
      timing: { startedAt: NOW - 1_000 },
    });
    const lines = rowLines(child, undefined, 12, NOW, { label: "grepping", observedAt: NOW });
    for (const value of [lines.first, lines.second, lines.third]) {
      if (value) expect(displayWidth(value)).toBeLessThanOrEqual(12);
    }
  });
});

describe("identity and model resolution", () => {
  test("displayTitle strips the V1 subagent suffix", () => {
    expect(displayTitle({ title: "Fix tests (@explore subagent)", agent: "explore" })).toBe(
      "Fix tests",
    );
    expect(displayTitle({ title: "Fix tests", agent: "explore" })).toBe("Fix tests");
  });

  test("the parent model only shows when it differs", () => {
    const child = { providerID: "openrouter", id: "deepseek-v3.2" };
    expect(differingModel(child, child)).toBeUndefined();
    expect(differingModel(child, { providerID: "anthropic", id: "claude" })).toBe(
      "openrouter/deepseek-v3.2",
    );
  });

  test("resolveSessionModel prefers the session and falls back to model-switched", () => {
    const model = { providerID: "openrouter", id: "deepseek-v3.2" };
    expect(resolveSessionModel({ model }, [])).toEqual(model);
    expect(
      resolveSessionModel(undefined, [
        { type: "user" },
        { type: "model-switched", model: { providerID: "xai", id: "grok" } },
      ]),
    ).toEqual({ providerID: "xai", id: "grok" });
    expect(resolveSessionModel(undefined, [])).toBeUndefined();
  });
});

describe("depth resolution", () => {
  // A flat "stored session" fixture: every level resolves through the chain.
  const nested: readonly ChainEntry[] = [
    { id: "l1", parentID: "root" },
    { id: "l2", parentID: "l1" },
    { id: "l3", parentID: "l2" },
    ...Array.from({ length: 12 }, (_, index) => ({
      id: `deep-${index + 1}`,
      parentID: index === 0 ? "root" : `deep-${index}`,
    })),
  ];

  test("direct children are L1 and the rendered root itself is L0", () => {
    expect(resolveDepth("root", { id: "l1", parentID: "root" }, chain([]))).toBe(1);
    expect(resolveDepth("root", { id: "root" }, chain([]))).toBe(0);
  });

  test("nested and deeply nested sessions count the parent chain", () => {
    const lookup = chain(nested);
    expect(resolveDepth("root", { id: "l2", parentID: "l1" }, lookup)).toBe(2);
    expect(resolveDepth("root", { id: "l3", parentID: "l2" }, lookup)).toBe(3);
    expect(resolveDepth("root", { id: "deep-12", parentID: "deep-11" }, lookup)).toBe(12);
  });

  test("depth follows the chain, not creation order", () => {
    // `first-created` was created before its own parent but sits one level deeper.
    const lookup = chain([
      { id: "first-created", parentID: "second" },
      { id: "second", parentID: "root" },
    ]);
    expect(resolveDepth("root", { id: "first-created", parentID: "second" }, lookup)).toBe(2);
    expect(resolveDepth("root", { id: "second", parentID: "root" }, lookup)).toBe(1);
  });

  test("a missing ancestor, an orphan and cycles stay unresolved", () => {
    // A parent the store has no record for (unsynced or deleted).
    expect(resolveDepth("root", { id: "gap", parentID: "gone" }, chain([]))).toBeUndefined();
    // An orphan with no parent metadata at all.
    expect(resolveDepth("root", { id: "orphan" }, chain([]))).toBeUndefined();
    // A self-referencing session.
    expect(resolveDepth("root", { id: "self", parentID: "self" }, chain([]))).toBeUndefined();
    // A detached cycle that never reaches the root.
    const cyclic = chain([
      { id: "a", parentID: "b" },
      { id: "b", parentID: "a" },
    ]);
    expect(resolveDepth("root", { id: "b", parentID: "a" }, cyclic)).toBeUndefined();
  });

  test("a chain longer than MAX_DEPTH is rejected instead of walked forever", () => {
    const overlong: ChainEntry[] = Array.from({ length: MAX_DEPTH + 1 }, (_, index) => ({
      id: `n-${index}`,
      parentID: index === 0 ? "root" : `n-${index - 1}`,
    }));
    const lookup = chain(overlong);
    expect(
      resolveDepth("root", { id: `n-${MAX_DEPTH}`, parentID: `n-${MAX_DEPTH - 1}` }, lookup),
    ).toBeUndefined();
    expect(
      resolveDepth("root", { id: `n-${MAX_DEPTH - 1}`, parentID: `n-${MAX_DEPTH - 2}` }, lookup),
    ).toBe(MAX_DEPTH);
  });

  test("depthLabel renders every level and the L? fallback", () => {
    expect(depthLabel(1)).toBe("L1");
    expect(depthLabel(2)).toBe("L2");
    expect(depthLabel(12)).toBe("L12");
    expect(depthLabel(undefined)).toBe("L?");
  });
});

describe("depth prefix", () => {
  const busy = { label: "grep", observedAt: NOW - 8_000 };

  test("active and completed rows keep the level as their first field", () => {
    const active = record({
      id: "busy",
      status: "busy",
      title: "Locate auth flow",
      depth: 1,
      timing: { startedAt: NOW - 120_000 },
    });
    expect(rowLines(active, undefined, 40, NOW, busy).first).toBe("L1 · * busy · Locate auth flow");

    const settled = record({
      id: "idle",
      status: "idle",
      title: "Review diff",
      depth: 2,
      timing: { startedAt: NOW - 43_000, endedAt: NOW },
    });
    expect(rowLines(settled, undefined, 40, NOW).first).toBe("L2 · - idle · Review diff");
  });

  test("a multi-digit level and an unresolved level stay compact", () => {
    const deep = record({ id: "deep", status: "busy", title: "Nested investigation", depth: 12 });
    expect(rowLines(deep, undefined, 40, NOW).prefix).toBe("L12 · * busy · ");

    // Unresolved ancestry must never be presented as a wrong level.
    const unknown = {
      ...record({ id: "unknown", status: "busy", title: "Nested" }),
      depth: undefined,
    };
    expect(rowLines(unknown, undefined, 40, NOW).prefix).toBe("L? · * busy · ");
  });

  test("the status and title survive when the panel cannot fit the level", () => {
    const child = record({
      id: "narrow",
      status: "busy",
      title: "a very long subagent title that must truncate",
      depth: 1,
      timing: { startedAt: NOW - 1_000 },
    });
    const lines = rowLines(child, undefined, 12, NOW, busy);
    // Depth yields first: the status word and the title are the load-bearing fields.
    expect(lines.first.startsWith("* busy · ")).toBe(true);
    expect(lines.first).not.toContain("L1");
    for (const value of [lines.first, lines.second, lines.third]) {
      if (value) expect(displayWidth(value)).toBeLessThanOrEqual(12);
    }
  });

  test("every width keeps rows bounded and prefers the level when it fits", () => {
    for (const depth of [1, 12, undefined]) {
      const child = {
        ...record({
          id: "scan",
          status: "busy",
          title: "Scan the repository for regressions",
          timing: { startedAt: NOW - 1_000 },
        }),
        depth,
      };
      for (let width = 1; width <= 44; width += 1) {
        const lines = rowLines(child, undefined, width, NOW, busy);
        expect(displayWidth(lines.first)).toBeLessThanOrEqual(width);
        if (lines.second) expect(displayWidth(lines.second)).toBeLessThanOrEqual(width);
        if (lines.third) expect(displayWidth(lines.third)).toBeLessThanOrEqual(width);
      }
      // At a comfortable width the level leads the row.
      expect(rowLines(child, undefined, 44, NOW, busy).prefix).toBe(
        `${depthLabel(depth)} · * busy · `,
      );
    }
  });
});

describe("formatting", () => {
  test("durations and costs keep the V1 format", () => {
    expect(formatDuration({ startedAt: 0 }, 8_000)).toBe("8s");
    expect(formatDuration({ startedAt: 0 }, 120_000)).toBe("2m");
    expect(formatDuration({ startedAt: 0, endedAt: 3_900_000 }, NOW)).toBe("1h 5m");
    expect(formatDuration(undefined, NOW)).toBeUndefined();
    expect(formatCost(0)).toBeUndefined();
    expect(formatCost(0.003)).toBe("$0.0030");
    expect(formatCost(1.234)).toBe("$1.23");
  });
});

describe("outline ordering", () => {
  const nested = (): SubagentRecord[] => [
    record({ id: "child", parentID: "root", depth: 1 }),
    record({ id: "grand-a", parentID: "child", depth: 2 }),
    record({ id: "grand-b", parentID: "child", depth: 2, status: "busy" }),
    record({ id: "great", parentID: "grand-b", depth: 3 }),
    record({ id: "sibling", parentID: "root", depth: 1, status: "busy" }),
  ];

  test("every row is followed by its own descendants, depth-first", () => {
    expect(outlineRecords(nested(), "root").map((row) => [row.session.id, row.depth])).toEqual([
      ["sibling", 1],
      ["child", 1],
      ["grand-b", 2],
      ["great", 3],
      ["grand-a", 2],
    ]);
  });

  test("siblings keep the flat sortRecords order at every level", () => {
    const rows = nested();
    expect(outlineRecords(rows, "root").map((row) => row.session.id)).toEqual([
      "sibling",
      "child",
      "grand-b",
      "great",
      "grand-a",
    ]);
  });

  test("equal-status siblings tie-break by id so the outline is stable", () => {
    const rows = [
      record({ id: "b", parentID: "root", depth: 1 }),
      record({ id: "a", parentID: "root", depth: 1 }),
    ];
    expect(outlineRecords(rows, "root").map((row) => row.session.id)).toEqual(["a", "b"]);
  });

  test("an unresolved record is excluded instead of given a false level", () => {
    const rows = [
      record({ id: "child", parentID: "root", depth: 1 }),
      // A parent the store has no record for.
      record({ id: "gap", parentID: "gone", depth: undefined }),
      // An orphan with no parent metadata at all.
      record({ id: "orphan", parentID: undefined, depth: undefined }),
    ];
    expect(outlineRecords(rows, "root").map((row) => row.session.id)).toEqual(["child"]);
  });

  test("a detached cycle never reaches the root, so it is never rendered", () => {
    const rows = [
      record({ id: "a", parentID: "b", depth: undefined }),
      record({ id: "b", parentID: "a", depth: undefined }),
      record({ id: "child", parentID: "root", depth: 1 }),
    ];
    expect(outlineRecords(rows, "root").map((row) => row.session.id)).toEqual(["child"]);
  });

  test("a record that reappears below its own descendant is rendered once", () => {
    // root → a → b, and `a` again under `b`: the walk must reject the repeat.
    const rows = [
      record({ id: "a", parentID: "root", depth: 1 }),
      record({ id: "b", parentID: "a", depth: 2 }),
      record({ id: "a", parentID: "b", depth: 3 }),
    ];
    expect(outlineRecords(rows, "root").map((row) => row.session.id)).toEqual(["a", "b"]);
  });

  test("the walk stops at MAX_DEPTH", () => {
    const rows = Array.from({ length: MAX_DEPTH + 4 }, (_, index) =>
      record({
        id: `n-${index}`,
        parentID: index === 0 ? "root" : `n-${index - 1}`,
        depth: index + 1,
      }),
    );
    expect(outlineRecords(rows, "root")).toHaveLength(MAX_DEPTH);
  });

  test("bounds the rendered page and reports the rest as omitted", () => {
    const rows = Array.from({ length: LIST_LIMIT + 2 }, (_, index) =>
      record({ id: `child-${index}`, parentID: "root", depth: 1 }),
    );
    const list = pruneList(outlineRecords(rows, "root"));
    expect(list.visible).toHaveLength(LIST_LIMIT);
    expect(list.omitted).toBe(2);
  });

  test("truncation keeps a parent ahead of its descendants", () => {
    const rows = [
      record({ id: "child", parentID: "root", depth: 1 }),
      record({ id: "grand", parentID: "child", depth: 2 }),
    ];
    const page = pruneList(outlineRecords(rows, "root"), 1);
    expect(page.visible.map((row) => row.session.id)).toEqual(["child"]);
    expect(page.omitted).toBe(1);
  });
});
