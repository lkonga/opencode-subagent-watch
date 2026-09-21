/**
 * opencode-subagent-watch — V2 TUI plugin.
 *
 * V2 TUI plugins are listed in `cli.json` `plugins`
 * (packages/tui/src/config/index.tsx:57-59; V2 has no `tui.json`) and load
 * through the public plugin surface (pinned worktree
 * `/home/lkonga/codes/opencode/.worktrees/port-v2.0.11-codex-prefix`,
 * base `9b9457c9de` — V2 2.0.11):
 *   module shape     packages/plugin/src/tui/plugin.ts:7-14   (`Definition { id, setup }`)
 *   context surface  packages/plugin/src/tui/context.ts:506-522
 *   sidebar slot     packages/plugin/src/tui/context.ts:191-202, 224-267, 503
 *   session data     packages/plugin/src/tui/context.ts:69-102
 *   events           packages/plugin/src/tui/context.ts:63-68
 *   router           packages/plugin/src/tui/context.ts:468-471
 *   keymap           packages/plugin/src/tui/context.ts:412-425, 440-460
 *   storage          packages/plugin/src/tui/context.ts:31-53
 *   theme text       packages/theme/src/tui/types.ts:32-38
 *
 * The V1 entrypoint (`../src/tui.tsx` → `dist/tui.js`) is untouched and still
 * loads under the V1 runtime. The V2 port keeps the V1 presentation (status
 * symbols, header counts, activity/duration/cost rows, click-to-navigate) and
 * swaps the V1 event-driven tracker for the V2 host-owned reactive session
 * store. The pure display model lives in `./subagents.ts`; per-view
 * subscriptions, bounded hydration and per-view state live in `./watch.ts`;
 * durable collapse state lives in `./collapse.ts`.
 *
 * Placement parity: V1 registers the `sidebar_content` slot with numeric
 * `order: 60` (`src/sidebar-state.ts:4`, `src/tui.tsx:301-304`), which renders
 * after Token Cache (55) and before core Todo (400). V2 has no numeric order —
 * a claim is exactly one of `prepend`/`append`/`before`/`after`/`replace`
 * (packages/plugin/src/tui/context.ts:224-262) and contributions render in
 * plugin enable order with no sort (packages/tui/src/plugin/structure.ts:60-147).
 * V2 2.0.11 also has no core Todo and no Token Cache sidebar section: the only
 * `sidebar.content` built-ins are `feature-plugins/sidebar/{context,mcp}.tsx`
 * (packages/tui/src/plugin/builtins.ts:15-31). `append: "sidebar.content"` from
 * a plugin enabled last is therefore the closest stable position — last section,
 * after every built-in — and is what this entrypoint registers. Exact "after
 * Token Cache, before Todo" ordering is not expressible through the V2 API;
 * `prepend` would move the panel ahead of the built-ins and `replace` would
 * suppress them.
 *
 * `session.sidebar` is NOT used: V2's `"auto" | "hide"` value controls the whole
 * sidebar pane (packages/tui/src/config/index.tsx:147-148,
 * packages/tui/src/component/session-frame.tsx:107-116, which also forces the
 * sidebar off for any session with a `parentID`), not this plugin's panel.
 * Collapse stays plugin-owned, exactly like V1.
 */
import { Plugin } from "@opencode/plugin/tui";
import type { BoxRenderable, RGBA } from "@opentui/core";
import { truncateWidth } from "../src/terminal-text.ts";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import {
  createCollapsedToggle,
  COLLAPSED_INITIAL,
  COLLAPSED_KEY,
  DEFAULT_COLLAPSED,
} from "./collapse.ts";
import { createSubagentWatch } from "./watch.ts";
import {
  headerSegments,
  isActive,
  resolveSessionModel,
  rowLines,
  type DisplayStatus,
} from "./subagents.ts";

/** Stable plugin id; also the diagnostics identity for this entrypoint. */
export const PLUGIN_ID = "opencode-subagent-watch-v2-tui";
export { COLLAPSED_INITIAL, COLLAPSED_KEY, DEFAULT_COLLAPSED };

/** The V2 sidebar slot this panel occupies; the only sidebar content path. */
export const SIDEBAR_SLOT = "sidebar.content";
/**
 * Placement kind for `SIDEBAR_SLOT`. V2 has no numeric order, so `append` is
 * the closest stable match for V1's `order: 60`: when this plugin is enabled
 * last it is the final sidebar section, after every built-in.
 */
export const SIDEBAR_PLACEMENT = "append";

function theme(api: Plugin.Context): {
  text: RGBA;
  subdued: RGBA;
  error: RGBA;
  warning: RGBA;
  success: RGBA;
} {
  return {
    text: api.theme.text.base,
    subdued: api.theme.text.muted,
    error: api.theme.text.feedback["error"].base,
    warning: api.theme.text.feedback["warning"].base,
    success: api.theme.text.feedback["success"].base,
  };
}

function statusColor(api: Plugin.Context, status: DisplayStatus): RGBA {
  const palette = theme(api);
  if (status === "error") return palette.error;
  if (status === "retry") return palette.warning;
  if (status === "busy") return palette.success;
  return palette.subdued;
}

function navigate(api: Plugin.Context, sessionID: string): void {
  api.ui.dialog.clear();
  api.ui.router.navigate({ type: "session", sessionID });
}

function View(props: {
  context: Plugin.Context;
  sessionID: string;
  collapsed: () => boolean;
  toggle: () => void;
}) {
  const api = props.context;
  const [width, setWidth] = createSignal(40);
  const [now, setNow] = createSignal(Date.now());
  const [hovered, setHovered] = createSignal<string>();
  let root: BoxRenderable | undefined;

  // One controller per rendered view: it owns the host subscriptions, the
  // bounded hydration run, and every per-view map, and is disposed with the
  // view (or explicitly through `watch.dispose()`).
  const watch = createSubagentWatch(api, () => props.sessionID);
  const list = watch.list;
  const summary = watch.summary;
  const loadState = watch.loadState;
  const stale = watch.stale;
  const activities = watch.activities;

  const header = createMemo(() => headerSegments(summary(), props.collapsed(), width(), stale()));
  const parentModel = createMemo(() =>
    resolveSessionModel(
      api.data.session.get(props.sessionID),
      api.data.session.message.list(props.sessionID),
    ),
  );
  const headerColor = (segment: string): RGBA => {
    const palette = theme(api);
    if (segment.endsWith(" active")) return palette.success;
    if (segment.endsWith(" error")) return palette.error;
    return palette.subdued;
  };

  createEffect(() => {
    const hoveredID = hovered();
    if (
      hoveredID &&
      (props.collapsed() || !list().visible.some((child) => child.session.id === hoveredID))
    ) {
      setHovered(undefined);
    }
  });

  createEffect(() => {
    const hasVisibleActive = list().visible.some((child) => isActive(child.status));
    if (!hasVisibleActive || props.collapsed()) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    onCleanup(() => clearInterval(timer));
  });

  const measure = () => {
    if (root?.width) setWidth(Math.max(1, root.width));
  };

  return (
    <box
      ref={(value: BoxRenderable) => {
        root = value;
        queueMicrotask(measure);
      }}
      onSizeChange={measure}
      width="100%"
      flexDirection="column"
    >
      <box width="100%" onMouseUp={props.toggle}>
        <text>
          <Show
            when={loadState() === "ready"}
            fallback={
              <span style={{ fg: theme(api).text }}>
                <b>{truncateWidth(`${props.collapsed() ? "▶" : "▼"} Subagents`, width())}</b>
              </span>
            }
          >
            <span style={{ fg: theme(api).text }}>
              <b>{header()[0]}</b>
            </span>
            <For each={header().slice(1)}>
              {(segment) => (
                <>
                  <span style={{ fg: theme(api).subdued }}> · </span>
                  <span style={{ fg: headerColor(segment) }}>{segment}</span>
                </>
              )}
            </For>
          </Show>
        </text>
      </box>

      <Show when={!props.collapsed()}>
        <Show when={loadState() === "loading"}>
          <text fg={theme(api).subdued}>{truncateWidth("  Loading subagents…", width())}</text>
        </Show>
        <Show when={loadState() === "unavailable"}>
          <text fg={theme(api).error}>{truncateWidth("  Subagents unavailable", width())}</text>
        </Show>
        <Show when={loadState() === "ready" && list().visible.length === 0}>
          <text fg={theme(api).subdued}>{truncateWidth("  No subagents", width())}</text>
        </Show>

        <For each={list().visible}>
          {(child) => {
            const isHovered = () => hovered() === child.session.id;
            const lines = () =>
              rowLines(child, parentModel(), width(), now(), activities().get(child.session.id));
            return (
              <box
                width="100%"
                flexDirection="column"
                onMouseOver={() => setHovered(child.session.id)}
                onMouseOut={() => setHovered(undefined)}
                onMouseUp={() => navigate(api, child.session.id)}
              >
                <text>
                  <span
                    style={{
                      fg:
                        isHovered() && child.status === "idle"
                          ? theme(api).text
                          : statusColor(api, child.status),
                    }}
                  >
                    <Show when={isHovered()} fallback={lines().prefix}>
                      <b>{lines().prefix}</b>
                    </Show>
                  </span>
                  <span style={{ fg: isHovered() ? theme(api).text : theme(api).subdued }}>
                    {lines().title}
                  </span>
                </text>
                <Show when={lines().second} keyed>
                  {(second: string) => (
                    <text fg={isHovered() ? theme(api).text : theme(api).subdued}>{second}</text>
                  )}
                </Show>
                <Show when={lines().third} keyed>
                  {(third: string) => (
                    <text fg={isHovered() ? theme(api).text : theme(api).subdued}>{third}</text>
                  )}
                </Show>
              </box>
            );
          }}
        </For>

        <Show when={list().omitted > 0}>
          <text fg={theme(api).subdued}>
            {truncateWidth(`  ${list().omitted} more subagents omitted`, width())}
          </text>
        </Show>
      </Show>
    </box>
  );
}

/**
 * `bind: false` is deliberate: V2 rejects unknown keybind ids at config parse
 * time (`packages/tui/src/config/keybind.ts:314-317`), so the panel action is
 * exposed through the command palette and the `/subagents` slash command
 * instead of inventing a keybind.
 */
function Commands(props: { context: Plugin.Context; toggle: () => void }) {
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "subagent-watch.toggle",
        title: "Subagents: toggle panel",
        description: "Collapse or expand the subagent activity panel",
        group: "Subagents",
        palette: true,
        bind: false,
        slash: { name: "subagents" },
        run: () => props.toggle(),
      },
    ],
  }));
  return null;
}

const tuiWatchPlugin: Plugin.Definition = {
  id: PLUGIN_ID,
  setup(context) {
    const { collapsed, toggle } = createCollapsedToggle(context);

    context.ui.slot({
      append: SIDEBAR_SLOT,
      render: (input) => (
        <View context={context} sessionID={input.sessionID} collapsed={collapsed} toggle={toggle} />
      ),
    });
    context.ui.slot({
      append: "app",
      render: () => <Commands context={context} toggle={toggle} />,
    });
  },
};

export default Plugin.define(tuiWatchPlugin);
