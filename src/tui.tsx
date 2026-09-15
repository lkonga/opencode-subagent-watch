/**
 * Connects OpenCode subscriptions to Solid state and terminal rendering.
 */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import type { BoxRenderable, RGBA } from "@opentui/core";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { clearActivity, updateActivity, type ActivityMap } from "./activity";
import { SubagentTracker, type TrackerSnapshot } from "./tracker";
import { headerSegments, resolveSessionModel, rowLines, sortAndPrune, summarize } from "./sidebar";
import {
  COLLAPSED_KEY,
  DEFAULT_COLLAPSED,
  PLUGIN_ID,
  restoreCollapsed,
  SIDEBAR_ORDER,
} from "./sidebar-state";
import { displayStatus, isActive } from "./subagent";
import { truncateWidth } from "./terminal-text";

function log(api: TuiPluginApi, level: "debug" | "warn", message: string): void {
  void api.client.app.log({ service: PLUGIN_ID, level, message }).catch(() => {});
}

function navigate(api: TuiPluginApi, sessionID: string): void {
  api.ui.dialog.clear();
  api.route.navigate("session", { sessionID });
}

function statusColor(api: TuiPluginApi, status: ReturnType<typeof displayStatus>): RGBA {
  if (status === "error") return api.theme.current.error;
  if (status === "retry") return api.theme.current.warning;
  if (status === "busy") return api.theme.current.success;
  return api.theme.current.textMuted;
}

function View(props: {
  api: TuiPluginApi;
  sessionID: string;
  tracker: SubagentTracker;
  snapshot: () => TrackerSnapshot;
  collapsed: () => boolean;
  activities: () => ActivityMap;
  toggle: () => void;
  ensureKV: () => void;
}) {
  const [width, setWidth] = createSignal(40);
  const [now, setNow] = createSignal(Date.now());
  const [hovered, setHovered] = createSignal<string>();
  let root: BoxRenderable | undefined;

  createEffect(() => props.ensureKV());
  if (props.snapshot().parentID === props.sessionID) void props.tracker.refresh();
  else void props.tracker.setParent(props.sessionID);

  const list = createMemo(() => sortAndPrune(props.snapshot().children.values()));
  createEffect(() => {
    const hoveredID = hovered();
    if (
      hoveredID &&
      (props.collapsed() || !list().visible.some((child) => child.session.id === hoveredID))
    ) {
      setHovered(undefined);
    }
  });
  const parentModel = createMemo(() =>
    resolveSessionModel(
      props.api.state.session.get(props.sessionID),
      props.api.state.session.messages(props.sessionID),
    ),
  );
  const summary = createMemo(() => summarize(props.snapshot().children.values()));
  const header = createMemo(() =>
    headerSegments(summary(), props.collapsed(), width(), props.snapshot().stale),
  );
  const headerColor = (segment: string) => {
    if (segment.endsWith(" active")) return props.api.theme.current.success;
    if (segment.endsWith(" error")) return props.api.theme.current.error;
    return props.api.theme.current.textMuted;
  };

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
      ref={(value) => {
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
            when={props.snapshot().loadState === "ready"}
            fallback={
              <span style={{ fg: props.api.theme.current.text }}>
                <b>{truncateWidth(`${props.collapsed() ? "▶" : "▼"} Subagents`, width())}</b>
              </span>
            }
          >
            <span style={{ fg: props.api.theme.current.text }}>
              <b>{header()[0]}</b>
            </span>
            <For each={header().slice(1)}>
              {(segment) => (
                <>
                  <span style={{ fg: props.api.theme.current.textMuted }}> · </span>
                  <span style={{ fg: headerColor(segment) }}>{segment}</span>
                </>
              )}
            </For>
          </Show>
        </text>
      </box>

      <Show when={!props.collapsed()}>
        <Show when={props.snapshot().loadState === "loading"}>
          <text fg={props.api.theme.current.textMuted}>
            {truncateWidth("  Loading subagents…", width())}
          </text>
        </Show>
        <Show when={props.snapshot().loadState === "unavailable"}>
          <text fg={props.api.theme.current.error}>
            {truncateWidth("  Subagents unavailable", width())}
          </text>
        </Show>
        <Show when={props.snapshot().loadState === "ready" && props.snapshot().children.size === 0}>
          <text fg={props.api.theme.current.textMuted}>
            {truncateWidth("  No subagents", width())}
          </text>
        </Show>

        <For each={list().visible}>
          {(child) => {
            const isHovered = () => hovered() === child.session.id;
            const status = () => displayStatus(child);
            const lines = () =>
              rowLines(
                child,
                parentModel(),
                width(),
                now(),
                props.activities().get(child.session.id),
              );
            return (
              <box
                width="100%"
                flexDirection="column"
                onMouseOver={() => setHovered(child.session.id)}
                onMouseOut={() => setHovered(undefined)}
                onMouseUp={() => navigate(props.api, child.session.id)}
              >
                <text>
                  <span
                    style={{
                      fg:
                        isHovered() && status() === "idle"
                          ? props.api.theme.current.text
                          : statusColor(props.api, status()),
                    }}
                  >
                    <Show when={isHovered()} fallback={lines().prefix}>
                      <b>{lines().prefix}</b>
                    </Show>
                  </span>
                  <span
                    style={{
                      fg: isHovered()
                        ? props.api.theme.current.text
                        : props.api.theme.current.textMuted,
                    }}
                  >
                    {lines().title}
                  </span>
                </text>
                <Show when={lines().second} keyed>
                  {(second: string) => (
                    <text
                      fg={
                        isHovered()
                          ? props.api.theme.current.text
                          : props.api.theme.current.textMuted
                      }
                    >
                      {second}
                    </text>
                  )}
                </Show>
                <Show when={lines().third} keyed>
                  {(third: string) => (
                    <text
                      fg={
                        isHovered()
                          ? props.api.theme.current.text
                          : props.api.theme.current.textMuted
                      }
                    >
                      {third}
                    </text>
                  )}
                </Show>
              </box>
            );
          }}
        </For>

        <Show when={list().omitted > 0}>
          <text fg={props.api.theme.current.textMuted}>
            {truncateWidth(`  ${list().omitted} more subagents omitted`, width())}
          </text>
        </Show>
      </Show>
    </box>
  );
}

const tui: TuiPlugin = async (api) => {
  const [snapshot, setSnapshot] = createSignal<TrackerSnapshot>({
    children: new Map(),
    loadState: "loading",
    stale: false,
  });
  const [collapsed, setCollapsed] = createSignal(DEFAULT_COLLAPSED);
  const [activities, setActivities] = createSignal<ActivityMap>(new Map());
  let kvLoaded = false;

  const tracker = new SubagentTracker({
    fetchChildren: async (parentID) => {
      const response = await api.client.session.children({ sessionID: parentID });
      if (response.error) throw response.error;
      return response.data ?? [];
    },
    status: (sessionID) => api.state.session.status(sessionID),
    onChange: setSnapshot,
    log: (level, message) => log(api, level, message),
  });
  const ensureKV = () => {
    if (kvLoaded || !api.kv.ready) return;
    kvLoaded = true;
    setCollapsed(restoreCollapsed(api.kv));
  };
  const toggle = () => {
    ensureKV();
    if (!api.kv.ready) {
      setCollapsed(DEFAULT_COLLAPSED);
      return;
    }
    const next = !collapsed();
    setCollapsed(next);
    if (api.kv.ready) api.kv.set(COLLAPSED_KEY, next);
  };

  api.lifecycle.onDispose(() => tracker.dispose());

  api.event.on("session.created", (event) => tracker.onCreated(event.properties.info));
  api.event.on("session.updated", (event) => tracker.onUpdated(event.properties.info));
  api.event.on("session.deleted", (event) => {
    tracker.onDeleted(event.properties.info);
    setActivities((value) => clearActivity(value, event.properties.sessionID));
  });
  api.event.on("session.status", (event) => {
    tracker.onStatus(event.properties.sessionID, event.properties.status);
    if (event.properties.status.type === "idle") {
      setActivities((value) => clearActivity(value, event.properties.sessionID));
    }
  });
  api.event.on("session.error", (event) => {
    tracker.onError(event.properties.sessionID, event.properties.error);
    if (event.properties.sessionID && event.properties.error) {
      setActivities((value) => clearActivity(value, event.properties.sessionID!));
    }
  });

  api.event.on("message.part.updated", (event) => {
    const { sessionID, part, time } = event.properties;
    const child = snapshot().children.get(sessionID);
    if (!child || !isActive(child.status)) return;
    // Measured 2026-07-31 on 1.18.9: text was 4.5% of part events; each text part caused at most two message scans. Keep uncached for now.
    const messageRole =
      part.type === "text"
        ? api.state.session.messages(sessionID).findLast((message) => message.id === part.messageID)
            ?.role
        : undefined;
    const current = activities();
    const next = updateActivity(current, sessionID, part, time, messageRole);
    if (next !== current) setActivities(next);
  });

  api.slots.register({
    order: SIDEBAR_ORDER,
    slots: {
      sidebar_content(_context, props) {
        return (
          <View
            api={api}
            sessionID={props.session_id}
            tracker={tracker}
            snapshot={snapshot}
            collapsed={collapsed}
            activities={activities}
            toggle={toggle}
            ensureKV={ensureKV}
          />
        );
      },
    },
  });

  log(api, "debug", "activated");
};

const plugin: TuiPluginModule & { id: string } = {
  id: PLUGIN_ID,
  tui,
};

export default plugin;
