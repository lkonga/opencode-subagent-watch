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
  differingModel,
  displayStatus,
  displayTitle,
  formatCost,
  formatDuration,
  headerLine,
  headerSegments,
  observeActivity,
  pruneActivity,
  pruneRecord,
  resolveSessionModel,
  rowLines,
  sortAndPrune,
  summarize,
  type ActivityMap,
  type DisplayStatus,
  type RunTiming,
  type SubagentRecord,
} from "./subagents.ts";

const NOW = 1_000_000;

function record(input: {
  id: string;
  status?: DisplayStatus;
  created?: number;
  updated?: number;
  title?: string;
  agent?: string;
  cost?: number;
  timing?: RunTiming;
  errorAt?: number;
}): SubagentRecord {
  return {
    session: {
      id: input.id,
      parentID: "parent",
      title: input.title ?? input.id,
      agent: input.agent ?? "explore",
      model: { providerID: "openrouter", id: "deepseek-v3.2" },
      cost: input.cost ?? 0,
      time: { created: input.created ?? NOW, updated: input.updated ?? NOW },
    },
    status: input.status ?? "idle",
    timing: input.timing,
    errorAt: input.errorAt,
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
    expect(lines.prefix).toBe("* busy · ");
    expect(lines.title).toBe("Locate auth flow");
    expect(lines.first).toBe("* busy · Locate auth flow");
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
