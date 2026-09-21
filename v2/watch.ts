/**
 * Focused watch controller for the V2 sidebar view.
 *
 * The V1 tracker fetched children and subscribed to global session events for
 * the process lifetime. V2 mounts one sidebar view per rendered session, so all
 * subscriptions, hydration and per-view maps are owned by a controller that is
 * created per view and disposed with it. This module keeps that ownership:
 *
 *   - event handlers only touch state for direct children of the *currently
 *     rendered* parent (`plugin.Context.data.session.get(id)?.parentID`);
 *   - `session.created` only re-hydrates when the created session's `parentID`
 *     matches the rendered parent (no work for unrelated sessions);
 *   - `server.connected` re-hydrates for whichever parent is rendered now, and
 *     a burst of synchronous reconnect signals coalesces into one refresh;
 *   - hydration requests a finite list (`HYDRATION_LIMIT`) and syncs every
 *     missing direct child that page returns, `HYDRATION_CONCURRENCY` at a
 *     time;
 *   - every await re-checks a generation counter, so results from a disposed
 *     view or from a previous parent are dropped instead of committed;
 *   - parent changes reset the load state and prune every per-view map.
 *   - rendering follows the rendered root's whole synced subtree (`familyDescendants`
 *     plus `outlineRecords`), while event marks and ownership stay scoped to
 *     direct children (`isDirectChild`).
 */
import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import type { Plugin } from "@opencode/plugin/tui";
import {
  advanceTimings,
  clearActivity,
  clearSettled,
  displayStatus,
  observeActivity,
  outlineRecords,
  pruneActivity,
  pruneList,
  pruneRecord,
  resolveDepth,
  summarize,
  type ActivityMap,
  type RunTiming,
  type SubagentList,
  type SubagentRecord,
  type SubagentSession,
  type Summary,
} from "./subagents.ts";

export type LoadState = "loading" | "ready" | "unavailable";

/** Finite page size for the child hydration request. */
export const HYDRATION_LIMIT = 50;
/** Fixed bounded concurrency for child syncs. */
export const HYDRATION_CONCURRENCY = 4;

export type SubagentWatch = {
  readonly children: Accessor<SubagentSession[]>;
  /** The rendered root's synced subtree, in host family-index order. */
  readonly descendants: Accessor<SubagentSession[]>;
  readonly records: Accessor<SubagentRecord[]>;
  readonly list: Accessor<SubagentList>;
  readonly summary: Accessor<Summary>;
  readonly activities: Accessor<ActivityMap>;
  readonly loadState: Accessor<LoadState>;
  readonly stale: Accessor<boolean>;
  /** Removes every host subscription; idempotent. */
  readonly dispose: () => void;
};

/**
 * Direct children of `parentID` from the host family index plus the reactive
 * session store. Missing or not-yet synced sessions are skipped, and a session
 * whose stored `parentID` disagrees with the index is ignored.
 */
export function directChildren(context: Plugin.Context, parentID: string): SubagentSession[] {
  const result: SubagentSession[] = [];
  for (const sessionID of context.data.session.family(parentID)) {
    const info = context.data.session.get(sessionID);
    if (info && info.parentID === parentID) result.push(info);
  }
  return result;
}

/**
 * Every session in the rendered root's family that the host has synced.
 *
 * The V2 host keys its family index by the family *root* and lists all members
 * (`packages/client/src/solid/data.ts:109-112, 514-541`), so a sync is the only
 * thing a descendant needs to appear here; `parentID` is what places it under
 * its parent. Members with no store record are skipped, exactly like
 * `directChildren`, and a member outside the rendered root's subtree is dropped
 * later by `outlineRecords`.
 */
export function familyDescendants(context: Plugin.Context, rootID: string): SubagentSession[] {
  const result: SubagentSession[] = [];
  for (const sessionID of context.data.session.family(rootID)) {
    if (sessionID === rootID) continue;
    const info = context.data.session.get(sessionID);
    if (info) result.push(info);
  }
  return result;
}

/** Whether `sessionID` is a direct child of `parentID` in the host store. */
export function isDirectChild(
  context: Plugin.Context,
  parentID: string,
  sessionID: string,
): boolean {
  return context.data.session.get(sessionID)?.parentID === parentID;
}

/**
 * Runs `run` over `items` with at most `concurrency` calls in flight. Workers
 * stop pulling new items as soon as `run` no longer resolves them (the caller
 * checks cancellation before starting each sync).
 */
export async function runBounded<Item>(
  items: readonly Item[],
  concurrency: number,
  run: (item: Item) => Promise<void>,
): Promise<void> {
  const width = Math.max(1, Math.min(concurrency, items.length));
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item === undefined) return;
      await run(item);
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
}

function runningSessions(
  context: Plugin.Context,
  children: readonly SubagentSession[],
): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const child of children)
    result[child.id] = context.data.session.status(child.id) === "running";
  return result;
}

/**
 * Creates the per-view watch controller. Must run inside a reactive root (a
 * component or `createRoot`): it registers effects and disposes its host
 * subscriptions on the owner's cleanup, and `dispose` may be called directly.
 */
export function createSubagentWatch(
  context: Plugin.Context,
  parent: Accessor<string>,
): SubagentWatch {
  const [loadState, setLoadState] = createSignal<LoadState>("loading");
  const [stale, setStale] = createSignal(false);
  const [timings, setTimings] = createSignal<Record<string, RunTiming>>({});
  const [errors, setErrors] = createSignal<Record<string, number>>({});
  const [retries, setRetries] = createSignal<Record<string, number>>({});
  const [activities, setActivities] = createSignal<ActivityMap>(new Map());
  const [refreshToken, setRefreshToken] = createSignal(0);

  const subscriptions: Array<() => void> = [];
  let disposed = false;
  /** Invalidates in-flight hydration: only the newest run may commit. */
  let generation = 0;
  let activeParent: string | undefined;
  /** Microtask latch: a burst of reconnect signals queues exactly one refresh. */
  let reconnectQueued = false;

  const children = createMemo(() => directChildren(context, parent()));
  const descendants = createMemo(() => familyDescendants(context, parent()));
  // Running status is read for every rendered row, so a nested descendant shows
  // the host's live status instead of defaulting to idle.
  const running = createMemo(() => runningSessions(context, descendants()));
  // Depth is re-derived from the live session store on every record rebuild, so
  // a row keeps its level across live events and store re-hydration, and an
  // unresolvable chain degrades to `L?` (never to a wrong level).
  const lookupSession = (sessionID: string): SubagentSession | undefined =>
    context.data.session.get(sessionID);
  const records = createMemo<SubagentRecord[]>(() =>
    descendants().map((session) => ({
      session,
      status: displayStatus({
        running: running()[session.id] === true,
        errorAt: errors()[session.id],
        retryAt: retries()[session.id],
      }),
      timing: timings()[session.id],
      errorAt: errors()[session.id],
      depth: resolveDepth(parent(), session, lookupSession),
    })),
  );
  // The rendered page is the placed subtree: unplaceable records are excluded,
  // and the summary counts exactly the rows the page can show.
  const ordered = createMemo(() => outlineRecords(records(), parent()));
  const list = createMemo(() => pruneList(ordered()));
  const summary = createMemo(() => summarize(ordered()));

  const current = (run: number): boolean => !disposed && run === generation;
  const isChild = (sessionID: string): boolean => isDirectChild(context, parent(), sessionID);
  const observe = (sessionID: string, label: string, observedAt: number): void => {
    setActivities((value) => observeActivity(value, sessionID, label, observedAt));
  };
  const clear = (sessionID: string): void => {
    setActivities((value) => clearActivity(value, sessionID));
  };
  const markError = (sessionID: string): void => {
    setErrors((value) => ({ ...value, [sessionID]: Date.now() }));
  };
  const markRetry = (sessionID: string): void => {
    setRetries((value) => ({ ...value, [sessionID]: Date.now() }));
  };

  async function hydrate(parentID: string, run: number): Promise<void> {
    try {
      const response = await context.client.session.list({
        parentID,
        order: "desc",
        limit: HYDRATION_LIMIT,
      });
      if (!current(run)) return;
      const pending = response.data
        .filter((session) => session.parentID === parentID)
        .map((session) => session.id)
        .filter((sessionID) => !context.data.session.get(sessionID));
      await runBounded(pending, HYDRATION_CONCURRENCY, async (sessionID) => {
        if (!current(run)) return;
        await context.data.session.sync(sessionID);
      });
      if (!current(run)) return;
      setStale(false);
      setLoadState("ready");
    } catch {
      if (!current(run)) return;
      setStale(true);
      setLoadState((previous) => (previous === "ready" ? previous : "unavailable"));
    }
  }

  createEffect(() => {
    const parentID = parent();
    void refreshToken();
    const parentChanged = activeParent !== parentID;
    activeParent = parentID;
    const run = (generation += 1);
    if (parentChanged) {
      // A new parent owns a fresh panel: drop the previous load outcome and
      // never let the old parent's in-flight hydration commit into it.
      setLoadState("loading");
      setStale(false);
    }
    void hydrate(parentID, run);
  });

  // `session.created` carries the new session's parent, so the panel refreshes
  // only for a direct child of the session it is rendered for.
  subscriptions.push(
    context.data.on("session.created", (event) => {
      if (event.data.parentID !== parent()) return;
      setRefreshToken((value) => value + 1);
    }),
  );

  // `server.connected` marks a (re)connect. Reconnects often arrive as a burst,
  // so the first signal queues one microtask refresh for whichever parent is
  // rendered then, and the rest of the burst is swallowed. A queued refresh
  // never fires once the view is disposed, and the refresh itself goes through
  // the generation counter, so an in-flight run still cannot commit stale data.
  subscriptions.push(
    context.data.on("server.connected", () => {
      if (disposed || reconnectQueued) return;
      reconnectQueued = true;
      queueMicrotask(() => {
        reconnectQueued = false;
        if (disposed) return;
        setRefreshToken((value) => value + 1);
      });
    }),
  );

  subscriptions.push(
    context.data.on("session.tool.input.started", (event) => {
      if (!isChild(event.data.sessionID)) return;
      observe(event.data.sessionID, event.data.name, event.created);
    }),
  );
  subscriptions.push(
    context.data.on("session.reasoning.started", (event) => {
      if (!isChild(event.data.sessionID)) return;
      observe(event.data.sessionID, "thinking", event.created);
    }),
  );
  subscriptions.push(
    context.data.on("session.text.started", (event) => {
      if (!isChild(event.data.sessionID)) return;
      observe(event.data.sessionID, "responding", event.created);
    }),
  );
  subscriptions.push(
    context.data.on("session.execution.succeeded", (event) => {
      if (!isChild(event.data.sessionID)) return;
      clear(event.data.sessionID);
    }),
  );
  subscriptions.push(
    context.data.on("session.execution.interrupted", (event) => {
      if (!isChild(event.data.sessionID)) return;
      clear(event.data.sessionID);
    }),
  );
  subscriptions.push(
    context.data.on("session.execution.failed", (event) => {
      if (!isChild(event.data.sessionID)) return;
      markError(event.data.sessionID);
    }),
  );
  subscriptions.push(
    context.data.on("session.step.failed", (event) => {
      if (!isChild(event.data.sessionID)) return;
      markError(event.data.sessionID);
    }),
  );
  subscriptions.push(
    context.data.on("session.retry.scheduled", (event) => {
      if (!isChild(event.data.sessionID)) return;
      markRetry(event.data.sessionID);
    }),
  );

  createEffect(() => {
    const snapshot = running();
    setTimings((previous) => advanceTimings(previous, snapshot, Date.now()));
    setErrors((previous) => clearSettled(previous, snapshot));
    setRetries((previous) => clearSettled(previous, snapshot));
  });

  createEffect(() => {
    // Prune against every rendered row so a nested row keeps its timing; event marks stay direct-child scoped.
    const keep = new Set(descendants().map((child) => child.id));
    setTimings((previous) => pruneRecord(previous, keep));
    setErrors((previous) => pruneRecord(previous, keep));
    setRetries((previous) => pruneRecord(previous, keep));
    setActivities((previous) => pruneActivity(previous, keep));
  });

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    generation += 1;
    for (const off of subscriptions.splice(0)) off();
  };
  onCleanup(dispose);

  return { children, descendants, records, list, summary, activities, loadState, stale, dispose };
}
