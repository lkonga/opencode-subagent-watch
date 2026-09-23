// v2/tui.tsx
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { use as _$use } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { Plugin } from "@opencode/plugin/tui";

// src/terminal-text.ts
var WHITESPACE = /\s+/g;
var EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
var EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
var REGIONAL_INDICATOR = /\p{Regional_Indicator}/u;
var EMOJI_VARIATION = /\ufe0f/u;
var KEYCAP = /\u20e3/u;
var FORMAT_CONTROL = /\p{Cf}/u;
var ZERO_WIDTH_ONLY = /^[\p{Mark}\p{Cf}]+$/u;
var EMOJI_JOIN_IGNORABLE = /[\p{Mark}\p{Emoji_Modifier}]/u;
var EMOJI_TAG_SEQUENCE = /^\u{1f3f4}[\u{e0020}-\u{e007e}]+\u{e007f}$/u;
var EMOJI_TAG_CHARACTER = /[\u{e0020}-\u{e007f}]/u;
var SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function sanitizeText(value) {
  return [...SEGMENTER.segment(value)].flatMap(({ segment }) => {
    const characters = [...segment];
    const emojiTagSequence = EMOJI_TAG_SEQUENCE.test(segment);
    const joinedPictographs = (index) => {
      const neighbor = (direction) => {
        let cursor = index + direction;
        while (characters[cursor] && EMOJI_JOIN_IGNORABLE.test(characters[cursor]))
          cursor += direction;
        return characters[cursor];
      };
      const previous = neighbor(-1);
      const next = neighbor(1);
      return !!previous && !!next && EXTENDED_PICTOGRAPHIC.test(previous) && EXTENDED_PICTOGRAPHIC.test(next);
    };
    return characters.filter((character, index) => {
      const code = character.codePointAt(0) ?? 0;
      const control = code <= 8 || code >= 11 && code <= 31 || code >= 127 && code <= 159;
      if (control)
        return false;
      if (character === "‍")
        return joinedPictographs(index);
      if (EMOJI_TAG_CHARACTER.test(character))
        return emojiTagSequence;
      return !FORMAT_CONTROL.test(character);
    });
  }).join("").replace(WHITESPACE, " ").trim();
}
function isWide(codePoint) {
  return codePoint >= 4352 && (codePoint <= 4447 || codePoint === 9001 || codePoint === 9002 || codePoint >= 11904 && codePoint <= 42191 && codePoint !== 12351 || codePoint >= 44032 && codePoint <= 55203 || codePoint >= 63744 && codePoint <= 64255 || codePoint >= 65040 && codePoint <= 65049 || codePoint >= 65072 && codePoint <= 65135 || codePoint >= 65280 && codePoint <= 65376 || codePoint >= 65504 && codePoint <= 65510 || codePoint >= 131072 && codePoint <= 262141);
}
function displayWidth(value) {
  return [...SEGMENTER.segment(value)].reduce((width, { segment }) => {
    if (ZERO_WIDTH_ONLY.test(segment))
      return width;
    const emoji = EMOJI_PRESENTATION.test(segment) || REGIONAL_INDICATOR.test(segment) || EMOJI_VARIATION.test(segment) || KEYCAP.test(segment);
    return width + (emoji || isWide(segment.codePointAt(0) ?? 0) ? 2 : 1);
  }, 0);
}
function truncateWidth(value, width) {
  if (width <= 0)
    return "";
  if (displayWidth(value) <= width)
    return value;
  if (width === 1)
    return "…";
  const limit = width - 1;
  const { result } = [...SEGMENTER.segment(value)].map(({ segment }) => segment).reduce((state, segment) => state.done || displayWidth(state.result + segment) > limit ? { ...state, done: true } : { result: state.result + segment, done: false }, { result: "", done: false });
  return result + "…";
}

// v2/tui.tsx
import { createEffect as createEffect2, createMemo as createMemo2, createSignal as createSignal3, For, onCleanup as onCleanup2, Show } from "solid-js";

// v2/collapse.ts
import { createSignal } from "solid-js";
var COLLAPSED_KEY = "collapsed";
var DEFAULT_COLLAPSED = true;
var COLLAPSED_INITIAL = { collapsed: DEFAULT_COLLAPSED };
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readCollapsed(state) {
  if (!isRecord(state))
    return;
  const value = state["collapsed"];
  return typeof value === "boolean" ? value : undefined;
}
function createCollapsedToggle(context) {
  const [state, mutate] = context.storage.store(COLLAPSED_KEY, {
    initial: COLLAPSED_INITIAL
  });
  const [pending, setPending] = createSignal();
  const collapsed = () => pending() ?? readCollapsed(state) ?? DEFAULT_COLLAPSED;
  let queue = Promise.resolve();
  const toggle = () => {
    const next = !collapsed();
    setPending(next);
    queue = queue.then(async () => {
      try {
        await mutate((draft) => {
          draft.collapsed = next;
        });
      } catch {
        return;
      }
      if (pending() === next)
        setPending(undefined);
    });
  };
  return { collapsed, toggle };
}

// v2/watch.ts
import { createEffect, createMemo, createSignal as createSignal2, onCleanup } from "solid-js";

// v2/subagents.ts
function isActive(status) {
  return status === "busy" || status === "retry";
}
var MAX_DEPTH = 32;
function depthLabel(depth) {
  return depth === undefined ? "L?" : `L${depth}`;
}
function resolveDepth(rootID, session, lookup) {
  if (session.id === rootID)
    return 0;
  const visited = new Set([session.id]);
  let current = session;
  for (let depth = 1;depth <= MAX_DEPTH; depth += 1) {
    const parentID = current.parentID;
    if (!parentID)
      return;
    if (parentID === rootID)
      return depth;
    if (visited.has(parentID))
      return;
    visited.add(parentID);
    const parent = lookup(parentID);
    if (!parent)
      return;
    current = parent;
  }
  return;
}
function displayStatus(input) {
  if (input.running)
    return "busy";
  if (input.retryAt !== undefined && (input.errorAt === undefined || input.retryAt >= input.errorAt))
    return "retry";
  if (input.errorAt !== undefined)
    return "error";
  return "idle";
}
function advanceTimings(previous, running, now) {
  let next;
  const ensure = () => next ??= { ...previous };
  for (const [sessionID, active] of Object.entries(running)) {
    const current = previous[sessionID];
    if (active) {
      if (!current || current.endedAt !== undefined)
        ensure()[sessionID] = { startedAt: now };
      continue;
    }
    if (current && current.endedAt === undefined)
      ensure()[sessionID] = { ...current, endedAt: now };
  }
  return next ?? previous;
}
function clearSettled(marks, running) {
  const entries = Object.entries(marks).filter(([sessionID]) => !running[sessionID]);
  return entries.length === Object.keys(marks).length ? marks : Object.fromEntries(entries);
}
function observeActivity(activities, sessionID, label, observedAt) {
  if (!label || !Number.isFinite(observedAt))
    return activities;
  const previous = activities.get(sessionID);
  if (previous && observedAt < previous.observedAt)
    return activities;
  if (previous?.label === label && observedAt - previous.observedAt < 1000)
    return activities;
  return new Map(activities).set(sessionID, { label, observedAt });
}
function clearActivity(activities, sessionID) {
  if (!activities.has(sessionID))
    return activities;
  return new Map([...activities].filter(([id]) => id !== sessionID));
}
function pruneActivity(activities, keep) {
  const entries = [...activities].filter(([id]) => keep.has(id));
  return entries.length === activities.size ? activities : new Map(entries);
}
function pruneRecord(record, keep) {
  const entries = Object.entries(record).filter(([id]) => keep.has(id));
  return entries.length === Object.keys(record).length ? record : Object.fromEntries(entries);
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function displayTitle(session) {
  const full = sanitizeText(session.title ?? "");
  if (!session.agent)
    return full;
  const stripped = full.replace(new RegExp(`\\s+\\(@${escapeRegExp(session.agent)} subagent\\)$`), "").trim();
  return stripped || full;
}
function effectiveModel(child, parent) {
  const model = child ?? parent;
  if (!model)
    return;
  return `${model.providerID}/${model.id}`;
}
function resolveSessionModel(session, messages) {
  if (session?.model)
    return session.model;
  return messages.findLast((message) => message.type === "model-switched")?.model;
}
var LIST_LIMIT = 5;
function byID(left, right) {
  return left.session.id.localeCompare(right.session.id);
}
function sortRecords(children) {
  const values = [...children];
  const active = values.filter((child) => isActive(child.status)).toSorted((left, right) => left.session.time.created - right.session.time.created || byID(left, right));
  const errors = values.filter((child) => child.status === "error").toSorted((left, right) => (right.errorAt ?? 0) - (left.errorAt ?? 0) || byID(left, right));
  const idle = values.filter((child) => child.status === "idle").toSorted((left, right) => right.session.time.updated - left.session.time.updated || byID(left, right));
  return [...active, ...errors, ...idle];
}
function pruneList(records, limit = LIST_LIMIT) {
  return {
    visible: records.slice(0, limit),
    omitted: Math.max(0, records.length - limit)
  };
}
function outlineRecords(records, rootID) {
  const byParent = new Map;
  for (const record of records) {
    if (record.depth === undefined)
      continue;
    const parentID = record.session.parentID;
    if (!parentID)
      continue;
    const siblings = byParent.get(parentID);
    if (siblings)
      siblings.push(record);
    else
      byParent.set(parentID, [record]);
  }
  const ordered = [];
  const seen = new Set([rootID]);
  const walk = (parentID, level) => {
    if (level > MAX_DEPTH)
      return;
    for (const record of sortRecords(byParent.get(parentID) ?? [])) {
      if (seen.has(record.session.id))
        continue;
      seen.add(record.session.id);
      ordered.push(record);
      walk(record.session.id, level + 1);
    }
  };
  walk(rootID, 1);
  return ordered;
}
function formatDuration(timing, now) {
  if (!timing)
    return;
  const seconds = Math.max(0, Math.floor(((timing.endedAt ?? now) - timing.startedAt) / 1000));
  let value;
  if (seconds < 60)
    value = `${seconds}s`;
  else if (seconds < 3600)
    value = `${Math.floor(seconds / 60)}m`;
  else {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    value = minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return value;
}
function formatCost(cost) {
  if (!cost || cost <= 0 || !Number.isFinite(cost))
    return;
  if (cost < 0.01)
    return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}
function summarize(children) {
  return [...children].reduce((summary, child) => ({
    total: summary.total + 1,
    active: summary.active + (isActive(child.status) ? 1 : 0),
    errors: summary.errors + (child.status === "error" ? 1 : 0)
  }), { total: 0, active: 0, errors: 0 });
}
function headerLine(summary, collapsed, width, stale = false) {
  const arrow = collapsed ? "▶" : "▼";
  if (summary.total === 0 && !stale)
    return truncateWidth(`${arrow} Subagents · none`, width);
  const counts = [
    summary.active ? `${summary.active} active` : "",
    summary.errors ? `${summary.errors} error` : "",
    `${summary.total} total`,
    stale ? "stale" : ""
  ].filter(Boolean);
  return truncateWidth(`${arrow} Subagents · ${counts.join(" · ")}`, width);
}
function headerSegments(summary, collapsed, width, stale = false) {
  return headerLine(summary, collapsed, width, stale).split(" · ");
}
function formatActivity(activity, now) {
  if (!activity)
    return;
  const age = formatDuration({ startedAt: activity.observedAt, endedAt: now }, now);
  const label = sanitizeText(activity.label);
  if (!label || !age)
    return;
  return { label, age: `${age} ago` };
}
function fitFields(fields, width) {
  const values = fields.filter(Boolean);
  const line = values.length ? `  ${values.join(" · ")}` : "";
  return line && displayWidth(line) <= width ? line : undefined;
}
function fitActivityColumns(activity, duration, width) {
  const separator = "  ";
  const activityWidth = width - displayWidth(`  ${separator}${duration}`);
  const labelWidth = activityWidth - displayWidth(` ${activity.age}`);
  if (labelWidth <= 0)
    return;
  const label = truncateWidth(activity.label, labelWidth);
  if (!label || label === "…" && activity.label !== "…")
    return;
  const field = `${label} ${activity.age}`;
  return `  ${field}${" ".repeat(Math.max(0, activityWidth - displayWidth(field)))}${separator}${duration}`;
}
function fitActivityOnly(activity, width) {
  const labelWidth = width - displayWidth(`   ${activity.age}`);
  if (labelWidth > 0) {
    const label = truncateWidth(activity.label, labelWidth);
    if (label !== "…" || activity.label === "…")
      return `  ${label} ${activity.age}`;
  }
  return fitFields([activity.age], width);
}
function fitActiveDetails(activity, runtime, width, now) {
  const observed = formatActivity(activity, now);
  if (!observed) {
    const duration2 = runtime ? `dur ${runtime}` : undefined;
    return fitFields([duration2 ?? ""], width);
  }
  const duration = runtime ? `dur ${runtime}` : undefined;
  if (duration) {
    return fitActivityColumns(observed, duration, width) ?? fitActivityOnly(observed, width);
  }
  return fitActivityOnly(observed, width);
}
function fitIdentity(agent, model, width) {
  if (!agent)
    return model && width > 2 ? `  ${truncateWidth(model, width - 2)}` : undefined;
  const full = model ? fitFields([agent, model], width) : fitFields([agent], width);
  if (full)
    return full;
  if (!model)
    return width > 2 ? `  ${truncateWidth(agent, width - 2)}` : undefined;
  const modelPrefix = " · ";
  const modelWidth = width - displayWidth(`  ${agent}${modelPrefix}`);
  if (modelWidth > 0)
    return `  ${agent}${modelPrefix}${truncateWidth(model, modelWidth)}`;
  return width > 2 ? `  ${truncateWidth(agent, width - 2)}` : undefined;
}
function fitSettledDetails(runtime, cost, width) {
  const duration = runtime ? `dur ${runtime}` : undefined;
  return fitFields([duration ?? "", cost ?? ""], width) ?? fitFields([duration ?? ""], width) ?? fitFields([cost ?? ""], width);
}
function rowLines(child, parentModel, width, now, activity) {
  const status = child.status;
  const symbol = {
    busy: "*",
    retry: "~",
    error: "!",
    idle: "-"
  };
  const fullTitle = displayTitle(child.session);
  const depthPrefix = `${depthLabel(child.depth)} · `;
  const statusPrefix = `${symbol[status]} ${status}`;
  const statusFullPrefix = `${statusPrefix} · `;
  const keepDepth = displayWidth(depthPrefix) + displayWidth(statusFullPrefix) < width;
  const fullPrefix = keepDepth ? `${depthPrefix}${statusFullPrefix}` : statusFullPrefix;
  const showTitle = !!fullTitle && displayWidth(fullPrefix) < width;
  const prefix = showTitle ? fullPrefix : truncateWidth(keepDepth ? `${depthPrefix}${statusPrefix}` : statusPrefix, width);
  const title = showTitle ? truncateWidth(fullTitle, width - displayWidth(fullPrefix)) : "";
  const first = prefix + title;
  const agent = sanitizeText(child.session.agent ?? "");
  const runtime = formatDuration(child.timing, now);
  const cost = formatCost(child.session.cost);
  const model = sanitizeText(effectiveModel(child.session.model, parentModel) ?? "") || undefined;
  const second = isActive(child.status) ? fitActiveDetails(activity, runtime, width, now) : fitSettledDetails(runtime, cost, width);
  const third = fitIdentity(agent, model, width);
  return { first: truncateWidth(first, width), prefix, title, second, third };
}

// v2/watch.ts
var HYDRATION_LIMIT = 50;
var HYDRATION_CONCURRENCY = 4;
function directChildren(context, parentID) {
  const result = [];
  for (const sessionID of context.data.session.family(parentID)) {
    const info = context.data.session.get(sessionID);
    if (info && info.parentID === parentID)
      result.push(info);
  }
  return result;
}
function familyDescendants(context, rootID) {
  const result = [];
  for (const sessionID of context.data.session.family(rootID)) {
    if (sessionID === rootID)
      continue;
    const info = context.data.session.get(sessionID);
    if (info)
      result.push(info);
  }
  return result;
}
function isDirectChild(context, parentID, sessionID) {
  return context.data.session.get(sessionID)?.parentID === parentID;
}
async function runBounded(items, concurrency, run) {
  const width = Math.max(1, Math.min(concurrency, items.length));
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item === undefined)
        return;
      await run(item);
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
}
function runningSessions(context, children) {
  const result = {};
  for (const child of children)
    result[child.id] = context.data.session.status(child.id) === "running";
  return result;
}
function createSubagentWatch(context, parent) {
  const [loadState, setLoadState] = createSignal2("loading");
  const [stale, setStale] = createSignal2(false);
  const [timings, setTimings] = createSignal2({});
  const [errors, setErrors] = createSignal2({});
  const [retries, setRetries] = createSignal2({});
  const [activities, setActivities] = createSignal2(new Map);
  const [refreshToken, setRefreshToken] = createSignal2(0);
  const subscriptions = [];
  let disposed = false;
  let generation = 0;
  let activeParent;
  let reconnectQueued = false;
  const children = createMemo(() => directChildren(context, parent()));
  const descendants = createMemo(() => familyDescendants(context, parent()));
  const running = createMemo(() => runningSessions(context, descendants()));
  const lookupSession = (sessionID) => context.data.session.get(sessionID);
  const records = createMemo(() => descendants().map((session) => ({
    session,
    status: displayStatus({
      running: running()[session.id] === true,
      errorAt: errors()[session.id],
      retryAt: retries()[session.id]
    }),
    timing: timings()[session.id],
    errorAt: errors()[session.id],
    depth: resolveDepth(parent(), session, lookupSession)
  })));
  const ordered = createMemo(() => outlineRecords(records(), parent()));
  const list = createMemo(() => pruneList(ordered()));
  const summary = createMemo(() => summarize(ordered()));
  const current = (run) => !disposed && run === generation;
  const isChild = (sessionID) => isDirectChild(context, parent(), sessionID);
  const observe = (sessionID, label, observedAt) => {
    setActivities((value) => observeActivity(value, sessionID, label, observedAt));
  };
  const clear = (sessionID) => {
    setActivities((value) => clearActivity(value, sessionID));
  };
  const markError = (sessionID) => {
    setErrors((value) => ({ ...value, [sessionID]: Date.now() }));
  };
  const markRetry = (sessionID) => {
    setRetries((value) => ({ ...value, [sessionID]: Date.now() }));
  };
  async function hydrate(parentID, run) {
    try {
      const response = await context.client.session.list({
        parentID,
        order: "desc",
        limit: HYDRATION_LIMIT
      });
      if (!current(run))
        return;
      const pending = response.data.filter((session) => session.parentID === parentID).map((session) => session.id).filter((sessionID) => !context.data.session.get(sessionID));
      await runBounded(pending, HYDRATION_CONCURRENCY, async (sessionID) => {
        if (!current(run))
          return;
        await context.data.session.sync(sessionID);
      });
      if (!current(run))
        return;
      setStale(false);
      setLoadState("ready");
    } catch {
      if (!current(run))
        return;
      setStale(true);
      setLoadState((previous) => previous === "ready" ? previous : "unavailable");
    }
  }
  createEffect(() => {
    const parentID = parent();
    refreshToken();
    const parentChanged = activeParent !== parentID;
    activeParent = parentID;
    const run = generation += 1;
    if (parentChanged) {
      setLoadState("loading");
      setStale(false);
    }
    hydrate(parentID, run);
  });
  subscriptions.push(context.data.on("session.created", (event) => {
    if (event.data.parentID !== parent())
      return;
    setRefreshToken((value) => value + 1);
  }));
  subscriptions.push(context.data.on("server.connected", () => {
    if (disposed || reconnectQueued)
      return;
    reconnectQueued = true;
    queueMicrotask(() => {
      reconnectQueued = false;
      if (disposed)
        return;
      setRefreshToken((value) => value + 1);
    });
  }));
  subscriptions.push(context.data.on("session.tool.input.started", (event) => {
    if (!isChild(event.data.sessionID))
      return;
    observe(event.data.sessionID, event.data.name, event.created);
  }));
  subscriptions.push(context.data.on("session.reasoning.started", (event) => {
    if (!isChild(event.data.sessionID))
      return;
    observe(event.data.sessionID, "thinking", event.created);
  }));
  subscriptions.push(context.data.on("session.text.started", (event) => {
    if (!isChild(event.data.sessionID))
      return;
    observe(event.data.sessionID, "responding", event.created);
  }));
  subscriptions.push(context.data.on("session.execution.succeeded", (event) => {
    if (!isChild(event.data.sessionID))
      return;
    clear(event.data.sessionID);
  }));
  subscriptions.push(context.data.on("session.execution.interrupted", (event) => {
    if (!isChild(event.data.sessionID))
      return;
    clear(event.data.sessionID);
  }));
  subscriptions.push(context.data.on("session.execution.failed", (event) => {
    if (!isChild(event.data.sessionID))
      return;
    markError(event.data.sessionID);
  }));
  subscriptions.push(context.data.on("session.step.failed", (event) => {
    if (!isChild(event.data.sessionID))
      return;
    markError(event.data.sessionID);
  }));
  subscriptions.push(context.data.on("session.retry.scheduled", (event) => {
    if (!isChild(event.data.sessionID))
      return;
    markRetry(event.data.sessionID);
  }));
  createEffect(() => {
    const snapshot = running();
    setTimings((previous) => advanceTimings(previous, snapshot, Date.now()));
    setErrors((previous) => clearSettled(previous, snapshot));
    setRetries((previous) => clearSettled(previous, snapshot));
  });
  createEffect(() => {
    const keep = new Set(descendants().map((child) => child.id));
    setTimings((previous) => pruneRecord(previous, keep));
    setErrors((previous) => pruneRecord(previous, keep));
    setRetries((previous) => pruneRecord(previous, keep));
    setActivities((previous) => pruneActivity(previous, keep));
  });
  const dispose = () => {
    if (disposed)
      return;
    disposed = true;
    generation += 1;
    for (const off of subscriptions.splice(0))
      off();
  };
  onCleanup(dispose);
  return { children, descendants, records, list, summary, activities, loadState, stale, dispose };
}

// v2/tui.tsx
var PLUGIN_ID = "opencode-subagent-watch-v2-tui";
var SIDEBAR_SLOT = "sidebar.content";
var SIDEBAR_PLACEMENT = "append";
function theme(api) {
  return {
    text: api.theme.text.base,
    subdued: api.theme.text.muted,
    error: api.theme.text.feedback["error"].base,
    warning: api.theme.text.feedback["warning"].base,
    success: api.theme.text.feedback["success"].base
  };
}
function statusColor(api, status) {
  const palette = theme(api);
  if (status === "error")
    return palette.error;
  if (status === "retry")
    return palette.warning;
  if (status === "busy")
    return palette.success;
  return palette.subdued;
}
function navigate(api, sessionID) {
  api.ui.dialog.clear();
  api.ui.router.navigate({
    type: "session",
    sessionID
  });
}
function View(props) {
  const api = props.context;
  const [width, setWidth] = createSignal3(40);
  const [now, setNow] = createSignal3(Date.now());
  const [hovered, setHovered] = createSignal3();
  let root;
  const watch = createSubagentWatch(api, () => props.sessionID);
  const list = watch.list;
  const summary = watch.summary;
  const loadState = watch.loadState;
  const stale = watch.stale;
  const activities = watch.activities;
  const header = createMemo2(() => headerSegments(summary(), props.collapsed(), width(), stale()));
  const parentModel = createMemo2(() => resolveSessionModel(api.data.session.get(props.sessionID), api.data.session.message.list(props.sessionID)));
  const headerColor = (segment) => {
    const palette = theme(api);
    if (segment.endsWith(" active"))
      return palette.success;
    if (segment.endsWith(" error"))
      return palette.error;
    return palette.subdued;
  };
  createEffect2(() => {
    const hoveredID = hovered();
    if (hoveredID && (props.collapsed() || !list().visible.some((child) => child.session.id === hoveredID))) {
      setHovered(undefined);
    }
  });
  createEffect2(() => {
    const hasVisibleActive = list().visible.some((child) => isActive(child.status));
    if (!hasVisibleActive || props.collapsed())
      return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup2(() => clearInterval(timer));
  });
  const measure = () => {
    if (root?.width)
      setWidth(Math.max(1, root.width));
  };
  return (() => {
    var _el$ = _$createElement("box"), _el$2 = _$createElement("box"), _el$3 = _$createElement("text");
    _$insertNode(_el$, _el$2);
    _$use((value) => {
      root = value;
      queueMicrotask(measure);
    }, _el$);
    _$setProp(_el$, "onSizeChange", measure);
    _$setProp(_el$, "width", "100%");
    _$setProp(_el$, "flexDirection", "column");
    _$insertNode(_el$2, _el$3);
    _$setProp(_el$2, "width", "100%");
    _$insert(_el$3, _$createComponent(Show, {
      get when() {
        return loadState() === "ready";
      },
      get fallback() {
        return (() => {
          var _el$0 = _$createElement("span"), _el$1 = _$createElement("b");
          _$insertNode(_el$0, _el$1);
          _$insert(_el$1, () => truncateWidth(`${props.collapsed() ? "▶" : "▼"} Subagents`, width()));
          _$effect((_$p) => _$setProp(_el$0, "style", {
            fg: theme(api).text
          }, _$p));
          return _el$0;
        })();
      },
      get children() {
        return [(() => {
          var _el$4 = _$createElement("span"), _el$5 = _$createElement("b");
          _$insertNode(_el$4, _el$5);
          _$insert(_el$5, () => header()[0]);
          _$effect((_$p) => _$setProp(_el$4, "style", {
            fg: theme(api).text
          }, _$p));
          return _el$4;
        })(), _$createComponent(For, {
          get each() {
            return header().slice(1);
          },
          children: (segment) => [(() => {
            var _el$10 = _$createElement("span");
            _$insertNode(_el$10, _$createTextNode(` · `));
            _$effect((_$p) => _$setProp(_el$10, "style", {
              fg: theme(api).subdued
            }, _$p));
            return _el$10;
          })(), (() => {
            var _el$12 = _$createElement("span");
            _$insert(_el$12, segment);
            _$effect((_$p) => _$setProp(_el$12, "style", {
              fg: headerColor(segment)
            }, _$p));
            return _el$12;
          })()]
        })];
      }
    }));
    _$insert(_el$, _$createComponent(Show, {
      get when() {
        return !props.collapsed();
      },
      get children() {
        return [_$createComponent(Show, {
          get when() {
            return loadState() === "loading";
          },
          get children() {
            var _el$6 = _$createElement("text");
            _$insert(_el$6, () => truncateWidth("  Loading subagents…", width()));
            _$effect((_$p) => _$setProp(_el$6, "fg", theme(api).subdued, _$p));
            return _el$6;
          }
        }), _$createComponent(Show, {
          get when() {
            return loadState() === "unavailable";
          },
          get children() {
            var _el$7 = _$createElement("text");
            _$insert(_el$7, () => truncateWidth("  Subagents unavailable", width()));
            _$effect((_$p) => _$setProp(_el$7, "fg", theme(api).error, _$p));
            return _el$7;
          }
        }), _$createComponent(Show, {
          get when() {
            return _$memo(() => loadState() === "ready")() && list().visible.length === 0;
          },
          get children() {
            var _el$8 = _$createElement("text");
            _$insert(_el$8, () => truncateWidth("  No subagents", width()));
            _$effect((_$p) => _$setProp(_el$8, "fg", theme(api).subdued, _$p));
            return _el$8;
          }
        }), _$createComponent(For, {
          get each() {
            return list().visible;
          },
          children: (child) => {
            const isHovered = () => hovered() === child.session.id;
            const lines = () => rowLines(child, parentModel(), width(), now(), activities().get(child.session.id));
            return (() => {
              var _el$13 = _$createElement("box"), _el$14 = _$createElement("text"), _el$15 = _$createElement("span"), _el$17 = _$createElement("span");
              _$insertNode(_el$13, _el$14);
              _$setProp(_el$13, "width", "100%");
              _$setProp(_el$13, "flexDirection", "column");
              _$setProp(_el$13, "onMouseOver", () => setHovered(child.session.id));
              _$setProp(_el$13, "onMouseOut", () => setHovered(undefined));
              _$setProp(_el$13, "onMouseUp", () => navigate(api, child.session.id));
              _$insertNode(_el$14, _el$15);
              _$insertNode(_el$14, _el$17);
              _$insert(_el$15, _$createComponent(Show, {
                get when() {
                  return isHovered();
                },
                get fallback() {
                  return lines().prefix;
                },
                get children() {
                  var _el$16 = _$createElement("b");
                  _$insert(_el$16, () => lines().prefix);
                  return _el$16;
                }
              }));
              _$insert(_el$17, () => lines().title);
              _$insert(_el$13, _$createComponent(Show, {
                get when() {
                  return lines().second;
                },
                keyed: true,
                children: (second) => (() => {
                  var _el$18 = _$createElement("text");
                  _$insert(_el$18, second);
                  _$effect((_$p) => _$setProp(_el$18, "fg", isHovered() ? theme(api).text : theme(api).subdued, _$p));
                  return _el$18;
                })()
              }), null);
              _$insert(_el$13, _$createComponent(Show, {
                get when() {
                  return lines().third;
                },
                keyed: true,
                children: (third) => (() => {
                  var _el$19 = _$createElement("text");
                  _$insert(_el$19, third);
                  _$effect((_$p) => _$setProp(_el$19, "fg", isHovered() ? theme(api).text : theme(api).subdued, _$p));
                  return _el$19;
                })()
              }), null);
              _$effect((_p$) => {
                var _v$ = {
                  fg: isHovered() && child.status === "idle" ? theme(api).text : statusColor(api, child.status)
                }, _v$2 = {
                  fg: isHovered() ? theme(api).text : theme(api).subdued
                };
                _v$ !== _p$.e && (_p$.e = _$setProp(_el$15, "style", _v$, _p$.e));
                _v$2 !== _p$.t && (_p$.t = _$setProp(_el$17, "style", _v$2, _p$.t));
                return _p$;
              }, {
                e: undefined,
                t: undefined
              });
              return _el$13;
            })();
          }
        }), _$createComponent(Show, {
          get when() {
            return list().omitted > 0;
          },
          get children() {
            var _el$9 = _$createElement("text");
            _$insert(_el$9, () => truncateWidth(`  ${list().omitted} more subagents omitted`, width()));
            _$effect((_$p) => _$setProp(_el$9, "fg", theme(api).subdued, _$p));
            return _el$9;
          }
        })];
      }
    }), null);
    _$effect((_$p) => _$setProp(_el$2, "onMouseUp", props.toggle, _$p));
    return _el$;
  })();
}
function Commands(props) {
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [{
      id: "subagent-watch.toggle",
      title: "Subagents: toggle panel",
      description: "Collapse or expand the subagent activity panel",
      group: "Subagents",
      palette: true,
      bind: false,
      slash: {
        name: "subagents"
      },
      run: () => props.toggle()
    }]
  }));
  return null;
}
var tuiWatchPlugin = {
  id: PLUGIN_ID,
  setup(context) {
    const {
      collapsed,
      toggle
    } = createCollapsedToggle(context);
    context.ui.slot({
      append: SIDEBAR_SLOT,
      render: (input) => _$createComponent(View, {
        context,
        get sessionID() {
          return input.sessionID;
        },
        collapsed,
        toggle
      })
    });
    context.ui.slot({
      append: "app",
      render: () => _$createComponent(Commands, {
        context,
        toggle
      })
    });
  }
};
var tui_default = Plugin.define(tuiWatchPlugin);
export {
  tui_default as default,
  SIDEBAR_SLOT,
  SIDEBAR_PLACEMENT,
  PLUGIN_ID,
  DEFAULT_COLLAPSED,
  COLLAPSED_KEY,
  COLLAPSED_INITIAL
};
