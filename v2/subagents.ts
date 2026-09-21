/**
 * Pure subagent display model for the V2 TUI plugin.
 *
 * Ports the V1 modules that are not tied to the V1 event plumbing:
 *   src/subagent.ts — display status and run timing
 *   src/sidebar.ts  — bounded rows, summaries, and headers
 *   src/activity.ts — the latest observed activity per session
 *
 * Only the input shapes change. V2 hands the TUI a reactive session store
 * (`context.data.session`, packages/plugin/src/tui/context.ts:65-95) plus
 * session-scoped events (packages/plugin/src/tui/context.ts:59-64), so the V1
 * event-driven tracker is replaced by host-owned data and the pure display
 * logic is kept here. Terminal width helpers stay shared with V1
 * (`src/terminal-text.ts`), so every rendered line is bounded by measured
 * display width in both runtimes.
 *
 * One addition has no V1 counterpart: every row carries the nesting depth
 * (`resolveDepth`) below the rendered session, resolved from the stored parent
 * chain, and `rowLines` renders it as a compact `L1` / `L2` / `L?` prefix.
 * `outlineRecords` turns those depth-annotated records into the rendered
 * outline, so a nested descendant keeps its true level instead of all rows
 * collapsing to `L1`.
 */
import { displayWidth, sanitizeText, truncateWidth } from "../src/terminal-text.ts";

export type DisplayStatus = "busy" | "retry" | "error" | "idle";

export type RunTiming = {
  startedAt: number;
  endedAt?: number;
};

export type ActivityObservation = {
  label: string;
  observedAt: number;
};

export type ActivityMap = ReadonlyMap<string, ActivityObservation>;

export type SubagentModel = {
  providerID: string;
  id: string;
  variant?: string;
};

/** The subset of V2 `SessionInfo` this plugin reads. */
export type SubagentSession = {
  id: string;
  parentID?: string;
  title?: string;
  agent?: string;
  model?: SubagentModel;
  cost: number;
  time: { created: number; updated: number };
};

export type SubagentRecord = {
  session: SubagentSession;
  status: DisplayStatus;
  timing?: RunTiming;
  errorAt?: number;
  /**
   * Nesting depth below the rendered root session, derived from the session
   * parent chain (`resolveDepth`). `undefined` renders as `L?`.
   */
  depth?: number;
};

export function isActive(status: DisplayStatus): boolean {
  return status === "busy" || status === "retry";
}

/** Reads a stored session by id, exactly like the host reactive store. */
export type SessionLookup = (sessionID: string) => SubagentSession | undefined;

/** Bound on parent-chain walking; a longer chain is treated as unresolvable. */
export const MAX_DEPTH = 32;

/** `L1`…`Ln` for a resolved level, or `L?` when ancestry is unresolved. */
export function depthLabel(depth: number | undefined): string {
  return depth === undefined ? "L?" : `L${depth}`;
}

/**
 * Depth of `session` below the rendered root, from the session *parent chain*
 * rather than creation order: a direct child of `rootID` is `1`, its child is
 * `2`, and `rootID` itself is `0`.
 *
 * A chain that never reaches `rootID` is unresolvable and returns `undefined`
 * so the row renders `L?` instead of a plausible-looking wrong level. That
 * covers a missing ancestor (the store has no record for it, e.g. an
 * unsynced or deleted session), an orphan without `parentID`, and a cycle.
 * A self-referencing or detached cycle is caught by the visited set, and a
 * chain longer than `MAX_DEPTH` is rejected rather than walked forever.
 */
export function resolveDepth(
  rootID: string,
  session: Pick<SubagentSession, "id" | "parentID">,
  lookup: SessionLookup,
): number | undefined {
  if (session.id === rootID) return 0;
  const visited = new Set<string>([session.id]);
  let current: Pick<SubagentSession, "id" | "parentID"> = session;
  for (let depth = 1; depth <= MAX_DEPTH; depth += 1) {
    const parentID = current.parentID;
    if (!parentID) return undefined;
    if (parentID === rootID) return depth;
    if (visited.has(parentID)) return undefined;
    visited.add(parentID);
    const parent = lookup(parentID);
    if (!parent) return undefined;
    current = parent;
  }
  return undefined;
}

/**
 * V1 `displayStatus` read a server session status and a retained error. V2
 * exposes only `"idle" | "running"` (packages/plugin/src/tui/context.ts:71), so
 * the retry and error marks are derived from the session-scoped events the V2
 * host publishes and are cleared once the session runs again.
 */
export function displayStatus(input: {
  running: boolean;
  errorAt?: number;
  retryAt?: number;
}): DisplayStatus {
  if (input.running) return "busy";
  if (
    input.retryAt !== undefined &&
    (input.errorAt === undefined || input.retryAt >= input.errorAt)
  )
    return "retry";
  if (input.errorAt !== undefined) return "error";
  return "idle";
}

/**
 * V1 `transitionTiming`: a run starts when a session becomes active and ends
 * when it settles. Returns the same map when nothing changed.
 */
export function advanceTimings(
  previous: Record<string, RunTiming>,
  running: Readonly<Record<string, boolean>>,
  now: number,
): Record<string, RunTiming> {
  let next: Record<string, RunTiming> | undefined;
  const ensure = () => (next ??= { ...previous });
  for (const [sessionID, active] of Object.entries(running)) {
    const current = previous[sessionID];
    if (active) {
      if (!current || current.endedAt !== undefined) ensure()[sessionID] = { startedAt: now };
      continue;
    }
    if (current && current.endedAt === undefined)
      ensure()[sessionID] = { ...current, endedAt: now };
  }
  return next ?? previous;
}

/** Drops marks for sessions that are running again (V1 `updateStatus`). */
export function clearSettled(
  marks: Record<string, number>,
  running: Readonly<Record<string, boolean>>,
): Record<string, number> {
  const entries = Object.entries(marks).filter(([sessionID]) => !running[sessionID]);
  return entries.length === Object.keys(marks).length ? marks : Object.fromEntries(entries);
}

/**
 * V1 `updateActivity`/`touchActivity`/`observeActivity`: later observations
 * win, a repeated label only refreshes its age, and an out-of-order event is
 * ignored. Returns the same map when nothing changed.
 */
export function observeActivity(
  activities: ActivityMap,
  sessionID: string,
  label: string,
  observedAt: number,
): ActivityMap {
  if (!label || !Number.isFinite(observedAt)) return activities;
  const previous = activities.get(sessionID);
  if (previous && observedAt < previous.observedAt) return activities;
  if (previous?.label === label && observedAt - previous.observedAt < 1_000) return activities;
  return new Map(activities).set(sessionID, { label, observedAt });
}

export function clearActivity(activities: ActivityMap, sessionID: string): ActivityMap {
  if (!activities.has(sessionID)) return activities;
  return new Map([...activities].filter(([id]) => id !== sessionID));
}

/** Drops activity for sessions that are no longer direct children. */
export function pruneActivity(activities: ActivityMap, keep: ReadonlySet<string>): ActivityMap {
  const entries = [...activities].filter(([id]) => keep.has(id));
  return entries.length === activities.size ? activities : new Map(entries);
}

/** Drops marks/timings for sessions that are no longer direct children. */
export function pruneRecord<Value>(
  record: Record<string, Value>,
  keep: ReadonlySet<string>,
): Record<string, Value> {
  const entries = Object.entries(record).filter(([id]) => keep.has(id));
  return entries.length === Object.keys(record).length ? record : Object.fromEntries(entries);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function displayTitle(session: Pick<SubagentSession, "title" | "agent">): string {
  const full = sanitizeText(session.title ?? "");
  if (!session.agent) return full;
  const stripped = full
    .replace(new RegExp(`\\s+\\(@${escapeRegExp(session.agent)} subagent\\)$`), "")
    .trim();
  return stripped || full;
}

export function modelsEqual(
  left: SubagentModel | undefined,
  right: SubagentModel | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.providerID === right.providerID && left.id === right.id;
}

export function differingModel(
  child: SubagentModel | undefined,
  parent: SubagentModel | undefined,
): string | undefined {
  if (!child || modelsEqual(child, parent)) return;
  return `${child.providerID}/${child.id}`;
}

/**
 * V1 `resolveSessionModel` fell back to the newest user message. V2 user
 * messages carry no model (packages/client/src/promise/generated/types.ts:1530),
 * so the fallback reads the newest `model-switched` message instead.
 */
export function resolveSessionModel(
  session: Pick<SubagentSession, "model"> | undefined,
  messages: readonly { type: string; model?: SubagentModel }[],
): SubagentModel | undefined {
  if (session?.model) return session.model;
  return messages.findLast((message) => message.type === "model-switched")?.model;
}

export type SubagentList = {
  visible: SubagentRecord[];
  omitted: number;
};

/** Maximum rows the panel renders before the rest are reported as omitted. */
export const LIST_LIMIT = 5;

function byID(left: SubagentRecord, right: SubagentRecord): number {
  return left.session.id.localeCompare(right.session.id);
}

/**
 * Sibling order, V1-compatible: running rows first (oldest run first), then
 * errors (most recent error first), then settled rows (most recently updated
 * first), each tie-broken by session id so the order is stable across rebuilds.
 */
export function sortRecords(children: Iterable<SubagentRecord>): SubagentRecord[] {
  const values = [...children];
  const active = values
    .filter((child) => isActive(child.status))
    .toSorted(
      (left, right) => left.session.time.created - right.session.time.created || byID(left, right),
    );
  const errors = values
    .filter((child) => child.status === "error")
    .toSorted((left, right) => (right.errorAt ?? 0) - (left.errorAt ?? 0) || byID(left, right));
  const idle = values
    .filter((child) => child.status === "idle")
    .toSorted(
      (left, right) => right.session.time.updated - left.session.time.updated || byID(left, right),
    );

  return [...active, ...errors, ...idle];
}

/** Bounds an already-ordered record list to the rows the panel renders. */
export function pruneList(records: readonly SubagentRecord[], limit = LIST_LIMIT): SubagentList {
  return {
    visible: records.slice(0, limit),
    omitted: Math.max(0, records.length - limit),
  };
}

/** Flat counterpart of `outlineRecords`: sibling order plus the row bound. */
export function sortAndPrune(children: Iterable<SubagentRecord>, limit = LIST_LIMIT): SubagentList {
  return pruneList(sortRecords(children), limit);
}

/**
 * Orders the rendered root's subtree as an **outline**: every row's own
 * descendants follow it depth-first, and siblings at every level keep
 * `sortRecords` order.
 *
 * A record is only rendered under its parent, so a record whose ancestry never
 * reaches `rootID` (`depth === undefined`, e.g. an orphan without `parentID` or
 * a chain the store cannot resolve) is excluded rather than placed at a level
 * it does not have.
 *
 * The walk cannot loop: in-degree is one (`parentID`), `seen` rejects any row
 * that still reaches the root more than once (`root → a → b → a`), and
 * `MAX_DEPTH` bounds the recursion depth even if a future caller passes a
 * deeper chain.
 */
export function outlineRecords(
  records: Iterable<SubagentRecord>,
  rootID: string,
): SubagentRecord[] {
  const byParent = new Map<string, SubagentRecord[]>();
  for (const record of records) {
    if (record.depth === undefined) continue;
    const parentID = record.session.parentID;
    if (!parentID) continue;
    const siblings = byParent.get(parentID);
    if (siblings) siblings.push(record);
    else byParent.set(parentID, [record]);
  }

  const ordered: SubagentRecord[] = [];
  const seen = new Set<string>([rootID]);
  const walk = (parentID: string, level: number): void => {
    if (level > MAX_DEPTH) return;
    for (const record of sortRecords(byParent.get(parentID) ?? [])) {
      if (seen.has(record.session.id)) continue;
      seen.add(record.session.id);
      ordered.push(record);
      walk(record.session.id, level + 1);
    }
  };
  walk(rootID, 1);
  return ordered;
}

export function formatDuration(timing: RunTiming | undefined, now: number): string | undefined {
  if (!timing) return;
  const seconds = Math.max(0, Math.floor(((timing.endedAt ?? now) - timing.startedAt) / 1000));
  let value: string;
  if (seconds < 60) value = `${seconds}s`;
  else if (seconds < 3600) value = `${Math.floor(seconds / 60)}m`;
  else {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    value = minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return value;
}

export function formatCost(cost: number | undefined): string | undefined {
  if (!cost || cost <= 0 || !Number.isFinite(cost)) return;
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

export type Summary = { total: number; active: number; errors: number };

export function summarize(children: Iterable<SubagentRecord>): Summary {
  return [...children].reduce(
    (summary, child) => ({
      total: summary.total + 1,
      active: summary.active + (isActive(child.status) ? 1 : 0),
      errors: summary.errors + (child.status === "error" ? 1 : 0),
    }),
    { total: 0, active: 0, errors: 0 },
  );
}

export function headerLine(
  summary: Summary,
  collapsed: boolean,
  width: number,
  stale = false,
): string {
  const arrow = collapsed ? "▶" : "▼";
  if (summary.total === 0 && !stale) return truncateWidth(`${arrow} Subagents · none`, width);
  const counts = [
    summary.active ? `${summary.active} active` : "",
    summary.errors ? `${summary.errors} error` : "",
    `${summary.total} total`,
    stale ? "stale" : "",
  ].filter(Boolean);
  return truncateWidth(`${arrow} Subagents · ${counts.join(" · ")}`, width);
}

export function headerSegments(
  summary: Summary,
  collapsed: boolean,
  width: number,
  stale = false,
): string[] {
  return headerLine(summary, collapsed, width, stale).split(" · ");
}

export type RowLines = {
  first: string;
  /** Status symbol, status word and depth label, i.e. everything before the title. */
  prefix: string;
  title: string;
  second?: string;
  third?: string;
};

function formatActivity(
  activity: ActivityObservation | undefined,
  now: number,
): { label: string; age: string } | undefined {
  if (!activity) return;
  const age = formatDuration({ startedAt: activity.observedAt, endedAt: now }, now);
  const label = sanitizeText(activity.label);
  if (!label || !age) return;
  return { label, age: `${age} ago` };
}

function fitFields(fields: readonly string[], width: number): string | undefined {
  const values = fields.filter(Boolean);
  const line = values.length ? `  ${values.join(" · ")}` : "";
  return line && displayWidth(line) <= width ? line : undefined;
}

function fitActivityColumns(
  activity: { label: string; age: string },
  duration: string,
  width: number,
): string | undefined {
  const separator = "  ";
  const activityWidth = width - displayWidth(`  ${separator}${duration}`);
  const labelWidth = activityWidth - displayWidth(` ${activity.age}`);
  if (labelWidth <= 0) return;

  const label = truncateWidth(activity.label, labelWidth);
  if (!label || (label === "…" && activity.label !== "…")) return;
  const field = `${label} ${activity.age}`;
  return `  ${field}${" ".repeat(Math.max(0, activityWidth - displayWidth(field)))}${separator}${duration}`;
}

function fitActivityOnly(
  activity: { label: string; age: string },
  width: number,
): string | undefined {
  const labelWidth = width - displayWidth(`   ${activity.age}`);
  if (labelWidth > 0) {
    const label = truncateWidth(activity.label, labelWidth);
    if (label !== "…" || activity.label === "…") return `  ${label} ${activity.age}`;
  }
  return fitFields([activity.age], width);
}

function fitActiveDetails(
  activity: ActivityObservation | undefined,
  runtime: string | undefined,
  width: number,
  now: number,
): string | undefined {
  const observed = formatActivity(activity, now);
  if (!observed) {
    const duration = runtime ? `dur ${runtime}` : undefined;
    return fitFields([duration ?? ""], width);
  }

  const duration = runtime ? `dur ${runtime}` : undefined;
  if (duration) {
    return fitActivityColumns(observed, duration, width) ?? fitActivityOnly(observed, width);
  }
  return fitActivityOnly(observed, width);
}

function fitIdentity(agent: string, model: string | undefined, width: number): string | undefined {
  if (!agent) return model && width > 2 ? `  ${truncateWidth(model, width - 2)}` : undefined;
  const full = model ? fitFields([agent, model], width) : fitFields([agent], width);
  if (full) return full;
  if (!model) return width > 2 ? `  ${truncateWidth(agent, width - 2)}` : undefined;

  const modelPrefix = " · ";
  const modelWidth = width - displayWidth(`  ${agent}${modelPrefix}`);
  if (modelWidth > 0) return `  ${agent}${modelPrefix}${truncateWidth(model, modelWidth)}`;
  return width > 2 ? `  ${truncateWidth(agent, width - 2)}` : undefined;
}

function fitSettledDetails(
  runtime: string | undefined,
  cost: string | undefined,
  width: number,
): string | undefined {
  const duration = runtime ? `dur ${runtime}` : undefined;
  return (
    fitFields([duration ?? "", cost ?? ""], width) ??
    fitFields([duration ?? ""], width) ??
    fitFields([cost ?? ""], width)
  );
}

export function rowLines(
  child: SubagentRecord,
  parentModel: SubagentModel | undefined,
  width: number,
  now: number,
  activity?: ActivityObservation,
): RowLines {
  const status = child.status;
  const symbol: Record<DisplayStatus, string> = {
    busy: "*",
    retry: "~",
    error: "!",
    idle: "-",
  };
  const fullTitle = displayTitle(child.session);
  const depthPrefix = `${depthLabel(child.depth)} · `;
  const statusPrefix = `${symbol[status]} ${status}`;
  const statusFullPrefix = `${statusPrefix} · `;
  // The depth leads the row, but it is dropped before the status when the panel
  // is too narrow for both: status and title are the load-bearing fields, and
  // this keeps narrow rendering identical to the un-prefixed layout.
  const keepDepth = displayWidth(depthPrefix) + displayWidth(statusFullPrefix) < width;
  const fullPrefix = keepDepth ? `${depthPrefix}${statusFullPrefix}` : statusFullPrefix;
  const showTitle = !!fullTitle && displayWidth(fullPrefix) < width;
  const prefix = showTitle
    ? fullPrefix
    : truncateWidth(keepDepth ? `${depthPrefix}${statusPrefix}` : statusPrefix, width);
  const title = showTitle ? truncateWidth(fullTitle, width - displayWidth(fullPrefix)) : "";
  const first = prefix + title;
  const agent = sanitizeText(child.session.agent ?? "");
  const runtime = formatDuration(child.timing, now);
  const cost = formatCost(child.session.cost);
  const model = sanitizeText(differingModel(child.session.model, parentModel) ?? "") || undefined;
  const second = isActive(child.status)
    ? fitActiveDetails(activity, runtime, width, now)
    : fitSettledDetails(runtime, cost, width);
  const third = fitIdentity(agent, model, width);

  return { first: truncateWidth(first, width), prefix, title, second, third };
}
